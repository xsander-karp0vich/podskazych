import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { app } from 'electron'
import { gateAfterFallback, gateOfReady, type GpuGate } from '@shared/gpuPack'

export interface SidecarInfo {
  port: number
  token: string
  model: string
  /** cuda | vulkan | cpu */
  device: string
  /** движок распознавания */
  engine: string
  /** подпись для строки состояния: «… · cuda», «… · видеокарта AMD Radeon RX 5700 XT (Vulkan)» или «… · процессор» */
  label: string
  /** почему работаем не на видеокарте NVIDIA (и не через Vulkan); null — всё штатно */
  fallbackReason: string | null
  /** итог стартовой проверки видеокарты через Vulkan; null — пакета нет или сайдкар её не делал */
  gpu: GpuGate | null
  /** какое устройство вывода слушаем как «собеседника» */
  loopbackDevice: string | null
  /** если захват системного звука не завёлся — причина */
  loopbackError: string | null
}

/** Свободный порт у ОС: фиксированный займут, а мы поднимаемся на машине пользователя. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const p = addr.port
        srv.close(() => resolve(p))
      } else {
        srv.close(() => reject(new Error('no port')))
      }
    })
  })
}

const MODEL_DIR = 'whisper-large-v3-turbo'

/**
 * Распознавание целиком внутри установщика: в resources/python лежит Python
 * со всеми пакетами и библиотеками C++ и NVIDIA, в resources/models — веса.
 * Ничего не докачивается, поэтому на чужом компьютере «Старт» работает сразу.
 * При разработке — sidecar/.venv и sidecar/models, как раньше.
 *
 * Переопределяется переменными окружения:
 *   COPILOT_SIDECAR_DATA — папка, где лежат .venv и models (как sidecar/ в репозитории)
 *   COPILOT_PYTHON       — прямой путь к python.exe
 *   COPILOT_MODEL        — прямой путь к папке с весами
 *   COPILOT_STT_DEVICE   — auto | cuda | vulkan | cpu; cpu — проверить режим компьютера без NVIDIA,
 *                          vulkan — видеокарта через пакет ускорения, даже если медленнее процессора
 */
function sidecarPaths() {
  const packaged = app.isPackaged
  const scriptDir = packaged ? join(process.resourcesPath, 'sidecar') : join(app.getAppPath(), 'sidecar')
  const dataDir = process.env.COPILOT_SIDECAR_DATA ?? (packaged ? null : scriptDir)

  return {
    packaged,
    dir: scriptDir,
    script: join(scriptDir, 'asr.py'),
    python:
      process.env.COPILOT_PYTHON ??
      (dataDir ? join(dataDir, '.venv', 'Scripts', 'python.exe') : join(process.resourcesPath, 'python', 'python.exe')),
    localModel:
      process.env.COPILOT_MODEL ??
      (dataDir ? join(dataDir, 'models', MODEL_DIR) : join(process.resourcesPath, 'models', MODEL_DIR)),
    /** путь не переопределён — значит, это файлы из установщика, и их отсутствие = повреждённая установка */
    bundledPython: !process.env.COPILOT_PYTHON && !dataDir,
    bundledModel: !process.env.COPILOT_MODEL && !dataDir,
  }
}

/**
 * Кэш сайдкара (--cache-dir): итоги стартовой проверки видеокарты, флаг её сбоя, замер процессора.
 * Пакет ускорения чистит отсюда итоги при установке и удалении — путь один на обоих.
 */
export const sttCacheDir = (): string => join(app.getPath('userData'), 'stt-cache')

/** vulkan без пакета сайдкар отработает сам: скажет причину и перейдёт на процессор. */
const DEVICES = new Set(['auto', 'cuda', 'vulkan', 'cpu'])

/** Помощник и модель пакета ускорения на видеокарте (gpu/pack.ts), если он установлен. */
export interface SttGpuPack {
  helper: string
  model: string
}

const BROKEN_INSTALL = 'Установка Подсказыча повреждена'

/**
 * Локальная папка с весами приоритетнее repo-id: faster-whisper принимает и то,
 * и другое, но локальный путь не ходит в сеть вообще.
 *
 * В собранном приложении запасного repo-id нет: он молча тянул бы 1,6 ГБ с
 * HuggingFace и не успевал за три минуты старта. Модель входит в установщик,
 * и если её нет — установка повреждена, об этом и говорим.
 */
function resolveModel(paths: ReturnType<typeof sidecarPaths>, requested?: string): string {
  if (requested) return requested
  if (existsSync(join(paths.localModel, 'model.bin'))) return paths.localModel
  if (!paths.packaged) return 'large-v3-turbo'
  throw new Error(
    paths.bundledModel
      ? `${BROKEN_INSTALL}: не найдена модель распознавания речи (${paths.localModel}). Переустановите приложение.`
      : `Не найдена модель распознавания речи: ${paths.localModel} (задана через COPILOT_MODEL или COPILOT_SIDECAR_DATA)`,
  )
}

/**
 * Окружение для Python без следов машины пользователя. Чужие PYTHONHOME и
 * PYTHONPATH (их оставляют установщики других программ) подменили бы
 * стандартную библиотеку или подсунули несовместимый numpy, а пакеты из
 * пользовательского site-packages — свои версии поверх наших.
 */
function sidecarEnv(packaged: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // В Windows имена переменных без учёта регистра, а в объекте — с учётом.
  for (const key of Object.keys(env)) {
    const k = key.toUpperCase()
    if (k === 'PYTHONHOME' || k === 'PYTHONPATH') delete env[key]
  }
  // PYTHONUTF8: трассировки в stderr по-русски не превращаются в кракозябры.
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONNOUSERSITE = '1'
  // Модель лежит в установщике; сеть huggingface_hub не нужна ни при каких условиях.
  if (packaged) env.HF_HUB_OFFLINE = '1'
  return env
}

/** Больше этого лог переезжает в stt.1.log: хватает на много созвонов и не растёт без конца. */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * Лог сайдкара на диске. Раньше stderr держался в памяти и показывался, только
 * если процесс не поднялся: обрыв сокета микрофона посреди созвона и трассировки
 * websockets не оставляли следа, и понять по жалобе тестера было нечего.
 *
 * Пишем stdout и stderr построчно. Текста расшифровки тут нет: реплики идут
 * окну по WebSocket, а в stdout — только готовность, замеры, события и ошибки.
 * Запись асинхронная и последовательная: main не ждёт диска на каждой строке.
 */
class SttLog {
  readonly file: string
  private size = -1
  private chain: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  write(stream: 'out' | 'err' | 'app', lines: string[]): void {
    const stamp = new Date().toISOString()
    const chunk = lines
      .filter((l) => l.trim())
      .map((l) => `${stamp} ${stream} ${l.trimEnd()}\n`)
      .join('')
    if (!chunk) return
    // Сбой диска не должен ронять распознавание: строка пропадёт, созвон — нет.
    this.chain = this.chain.then(() => this.append(chunk)).catch(() => {})
  }

  private async append(chunk: string): Promise<void> {
    if (this.size < 0) {
      await mkdir(dirname(this.file), { recursive: true })
      this.size = await stat(this.file).then(
        (s) => s.size,
        () => 0,
      )
    }
    if (this.size > LOG_MAX_BYTES) {
      // Не переименовался (файл держит второй экземпляр) — пишем дальше в тот же,
      // попробуем снова на следующем круге.
      await rename(this.file, this.file.replace(/\.log$/, '.1.log')).catch(() => {})
      this.size = 0
    }
    await appendFile(this.file, chunk)
    this.size += Buffer.byteLength(chunk)
  }
}

export class SttSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null
  private info: SidecarInfo | null = null
  private log: SttLog | null = null
  /**
   * Процесс завершился сам, уже после готовности: не «Стоп» и не таймаут старта.
   * Окну надо перестать переподключаться и показать причину.
   */
  onExit: ((error: string) => void) | null = null
  /**
   * Движок сменился посреди сессии: видеокарта через Vulkan сбоила или замедлилась, и сайдкар сам перешёл
   * на процессор. Звук идёт дальше, но подпись в окне и строка настроек иначе до конца сессии врали бы «Vulkan».
   */
  onEngine: ((info: SidecarInfo, reason: string) => void) | null = null

  /** Процесс запущен — от «Старт» до «Стоп» или выхода. Пока он жив, файлы пакета на видеокарте заняты. */
  get running(): boolean {
    return this.proc !== null
  }

  async start(
    opts: { language?: string; glossary?: string; model?: string; gpuPack?: SttGpuPack | null } = {},
  ): Promise<SidecarInfo> {
    if (this.info) return this.info

    const paths = sidecarPaths()
    const { python, script, dir } = paths
    if (!existsSync(python)) {
      throw new Error(
        paths.packaged && paths.bundledPython
          ? `${BROKEN_INSTALL}: не найден встроенный Python распознавания речи (${python}). Переустановите приложение.`
          : `Не найден Python сайдкара: ${python}`,
      )
    }
    if (!existsSync(script)) {
      throw new Error(
        paths.packaged
          ? `${BROKEN_INSTALL}: не найден asr.py (${script}). Переустановите приложение.`
          : `Не найден asr.py: ${script}`,
      )
    }
    const model = resolveModel(paths, opts.model)

    const port = await freePort()
    const token = randomBytes(24).toString('hex')
    const device = process.env.COPILOT_STT_DEVICE ?? 'auto'

    // Встроенному Python — те же флаги, что в проверке scripts/build-stt-runtime.ps1:
    // -E не читает PYTHON* из окружения (и PythonPath из реестра, который оставляет
    // установленный у пользователя Python той же версии), -s не берёт пакеты из
    // профиля, -X utf8 заменяет PYTHONUTF8, который -E игнорирует.
    const isolation = paths.packaged ? ['-E', '-s', '-X', 'utf8'] : []

    // Путь — не при импорте модуля: папку userData main выставляет при запуске (appName.ts).
    const log = (this.log ??= new SttLog(join(app.getPath('userData'), 'logs', 'stt.log')))
    console.log('[stt] лог распознавания:', log.file)
    const pack = opts.gpuPack ?? null
    log.write('app', [
      `запуск сайдкара: устройство ${device}, модель ${model.split(/[\\/]/).pop()}, ` +
        `пакет Vulkan ${pack ? `установлен (${dirname(pack.helper)})` : 'не установлен'}`,
    ])

    // Пакет передаём, только если он установлен: без него сайдкар в auto выбирает между CUDA и процессором,
    // как раньше. Кэш стартовой проверки видеокарты — рядом с логом: проверка стоит секунды, а её итог
    // зависит только от устройства, драйвера, помощника и модели.
    const packArgs = pack ? ['--vk-helper', pack.helper, '--ggml-model', pack.model, '--cache-dir', sttCacheDir()] : []

    const proc = spawn(
      python,
      [
        ...isolation,
        script,
        '--port', String(port),
        '--token', token,
        '--model', model,
        '--device', DEVICES.has(device) ? device : 'auto',
        '--language', opts.language ?? 'ru',
        '--glossary', opts.glossary ?? '',
        ...packArgs,
      ],
      { cwd: dir, windowsHide: true, env: sidecarEnv(paths.packaged) },
    )
    this.proc = proc

    return new Promise<SidecarInfo>((resolve, reject) => {
      // Причина, которую сайдкар назвал сам перед выходом. Понятнее трассировки.
      let fatal: string | null = null
      // Модель с диска грузится секунды, но на слабом компьютере с антивирусом
      // первый запуск бывает долгим, а при разработке без sidecar/models веса
      // ещё и тянутся с HuggingFace. Зависший процесс гасим: иначе он держит видеопамять, а следующий «Старт»
      // поднимет второй такой же.
      const timer = setTimeout(() => {
        reject(new Error('Распознавание речи не запустилось за 3 минуты'))
        if (this.proc === proc) this.stop()
        else proc.kill()
      }, 180_000)
      // Разбираем построчно. Готовность приходит один раз, а замеры уровней —
      // каждые двадцать секунд, весь созвон. Раньше stdout копился в одной
      // строке до конца сессии и просматривался целиком на каждый чанк.
      let pending = ''
      let pendingErr = ''
      let stderr = ''
      // Готовность уже отдана окну: выход после неё — падение посреди сессии, а не неудачный старт.
      let ready = false

      proc.stdout.on('data', (b: Buffer) => {
        pending += b.toString()
        const lines = pending.split('\n')
        // Последний кусок может быть недописанной строкой — ждём продолжения.
        pending = lines.pop() ?? ''
        log.write('out', lines)

        for (const line of lines) {
          if (!line.trim()) continue
          let msg: {
            ready?: boolean
            model?: string
            device?: string
            engine?: string
            label?: string
            fallbackReason?: string | null
            loopbackDevice?: string | null
            loopbackError?: string | null
            stats?: unknown
            event?: string
            /** engine-fallback: почему ушли с видеокарты */
            reason?: string
            error?: string
            fatal?: { code?: string; message?: string }
          }
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }

          if (msg.ready) {
            clearTimeout(timer)
            ready = true
            const model = msg.model ?? ''
            const device = msg.device ?? ''
            this.info = {
              port,
              token,
              model,
              device,
              engine: msg.engine ?? 'faster-whisper',
              label: msg.label || `${model.split(/[\\/]/).pop()} · ${device}`,
              fallbackReason: msg.fallbackReason ?? null,
              loopbackDevice: msg.loopbackDevice ?? null,
              loopbackError: msg.loopbackError ?? null,
              gpu: gateOfReady(msg),
            }
            const { gpu, fallbackReason } = this.info
            if (gpu) {
              // Итог проверки видеокарты — отдельной строкой: по жалобе «медленно» первым делом смотрят сюда.
              const t = [gpu.tFullMs !== undefined && `полное окно ${Math.round(gpu.tFullMs)} мс`, gpu.tLadderMs !== undefined && `лесенка ${Math.round(gpu.tLadderMs)} мс`]
                .filter(Boolean)
                .join(', ')
              log.write('app', [
                `проверка видеокарты: ${gpu.device || 'устройство не названо'}, уровень ${gpu.tier}, flash attention ${gpu.flashAttn ? 'вкл' : 'выкл'}${t ? `, ${t}` : ''}${gpu.reason ? ` — ${gpu.reason}` : ''}`,
              ])
            }
            if (device === 'vulkan') {
              console.log('[stt] распознавание на видеокарте через Vulkan:', this.info.label, fallbackReason ? `(не CUDA: ${fallbackReason})` : '')
            } else if (fallbackReason) {
              console.warn(`[stt] распознавание ${device === 'cpu' ? 'на процессоре' : `на ${device}`}:`, fallbackReason)
            }
            resolve(this.info)
          } else if (msg.fatal) {
            fatal = msg.fatal.message ?? msg.fatal.code ?? null
            console.error('[stt] сайдкар не поднялся:', msg.fatal.code, msg.fatal.message)
          } else if (msg.stats) {
            // Запас речи над порогом и счётчик потерь — единственный способ
            // понять по логу, что у собеседника плохой микрофон, а не модель
            // плохо слышит.
            console.log('[stt] уровни:', JSON.stringify(msg.stats))
          } else if (msg.event) {
            // Закрытие сокета, замена подключения микрофона — то, что раньше
            // происходило молча и объясняло «перестал слышать мой голос».
            console.log('[stt] событие:', line)
            // Переход с Vulkan на процессор. Сведения обновляем только о своём, ещё живом процессе:
            // событие старого сайдкара после нового «Старт» не должно переписать новый.
            if (msg.event === 'engine-fallback' && this.proc === proc && this.info && msg.device) {
              const reason = msg.reason?.trim() || 'видеокарта через Vulkan сбоила'
              const prev = this.info
              this.info = {
                ...prev,
                device: msg.device,
                label: msg.label || prev.label,
                // Как у старта на процессоре: «почему не CUDA; Vulkan: почему не Vulkan».
                fallbackReason: [prev.fallbackReason, `Vulkan: ${reason}`].filter(Boolean).join('; '),
                gpu: gateAfterFallback(prev.gpu, reason),
              }
              log.write('app', [`распознавание перешло на ${msg.device === 'cpu' ? 'процессор' : msg.device} посреди сессии: ${reason}`])
              console.warn('[stt] распознавание перешло на процессор посреди сессии:', reason)
              this.onEngine?.(this.info, reason)
            }
          } else if (msg.error) {
            console.error('[stt]', msg.error)
          }
        }
      })

      proc.stderr.on('data', (b: Buffer) => {
        const text = b.toString()
        stderr += text
        if (stderr.length > 8000) stderr = stderr.slice(-8000)
        pendingErr += text
        const lines = pendingErr.split('\n')
        pendingErr = lines.pop() ?? ''
        log.write('err', lines)
        for (const line of lines) if (line.trim()) console.error('[stt:err]', line.trimEnd())
      })

      proc.once('error', (e) => {
        clearTimeout(timer)
        log.write('app', [`процесс не запустился: ${e.message}`])
        reject(e)
      })
      // Хвосты без перевода строки — по 'close', когда потоки дочитаны: после 'exit'
      // данные ещё приходят. А недописанная строка — часто последняя строка трассировки.
      proc.once('close', () => {
        log.write('out', [pending])
        log.write('err', [pendingErr])
        if (pendingErr.trim()) console.error('[stt:err]', pendingErr.trimEnd())
      })
      proc.once('exit', (code, signal) => {
        clearTimeout(timer)
        log.write('app', [`выход: код ${code}${signal ? `, сигнал ${signal}` : ''}`])
        // Старый процесс может умереть уже после нового «Старт» — его выход
        // не должен стирать сведения о новом. И «Стоп», и таймаут старта отвязывают
        // процесс раньше, чем придёт его выход, так что совпадение здесь — выход,
        // которого никто не просил.
        const unexpected = this.proc === proc
        if (unexpected) {
          this.proc = null
          this.info = null
        }
        if (!ready) {
          // Таймер уже снят: без reject и на коде 0 «Старт» ждал бы вечно.
          reject(new Error(fatal ?? `Сайдкар упал (код ${code ?? signal}):\n${stderr.slice(-2000)}`))
          return
        }
        if (unexpected) {
          const reason = fatal ?? `код ${code ?? signal}`
          console.error('[stt] сайдкар завершился посреди сессии:', reason)
          this.onExit?.(`Распознавание речи остановилось (${reason}) — начните сессию заново`)
        }
      })
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.info = null
  }

  get current(): SidecarInfo | null {
    return this.info
  }
}
