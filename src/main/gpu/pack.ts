import { app } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  GGML_MODEL_NAME,
  GPU_PACK_ASSETS,
  GPU_PACK_RELEASE_URL,
  GPU_PACK_VERSION,
  HELPER_EXE,
  gpuAdaptersOf,
  hasPackCandidate,
  packBytes,
  parseGpuGate,
  shouldOfferPack,
  withPinOverrides,
  type GpuAdapter,
  type PackAsset,
  type GpuPackPhase,
  type GpuPackState,
  type SttOutcome,
} from '@shared/gpuPack'
import {
  PackCancelled,
  PackError,
  discardPartial,
  forgetGateVerdicts,
  installPack,
  partialBytes,
  readInstalled,
  removePack,
  sweepLeftovers,
  type InstalledPack,
} from './download'

/**
 * Пакет ускорения на видеокарте в main: что установлено, идёт ли загрузка, что показать в настройках.
 *
 * Сайдкар живёт только пока идёт сессия, поэтому «перезапускать» его после установки не нужно: пакет
 * подхватит следующий «Старт». Если сессия идёт, пакет просто ждёт её конца, а строка настроек так
 * и говорит. Удалить пакет посреди сессии Windows не даст — помощник запущен из его каталога, —
 * поэтому удаление откладывается до «Стоп».
 *
 * Переопределяется переменными окружения — для dev-копий и проверки без GitHub:
 *   COPILOT_GPU_PACK_DIR — каталог пакетов вместо %LOCALAPPDATA%\Podskazych\gpu
 *   COPILOT_GPU_PACK_URL — адрес каталога ассетов вместо релиза gpu-vulkan-v1
 * Только в разработке (не в собранном приложении — там подменять контрольные суммы нельзя):
 *   COPILOT_GPU_PACK_PINS    — JSON {"<ассет>": {"sha256": "…", "bytes": N}}: свой локальный релиз без правки сборки
 *   COPILOT_GPU_FAKE_VENDOR  — «0x1002» или «0x1002:0x731f»: добавить видеокарту к списку, чтобы на машине
 *                              только с NVIDIA увидеть предложение, «Скачать» и подсказку в панели
 */

export interface SidecarPack {
  helper: string
  model: string
}

interface Saved {
  /** устройство последней сессии — cuda | vulkan | cpu: от него зависит, предлагать ли пакет */
  lastDevice: string | null
  /** итог старта после последней установки или удаления пакета */
  last: SttOutcome | null
}

function packRoot(): string {
  if (process.env.COPILOT_GPU_PACK_DIR) return process.env.COPILOT_GPU_PACK_DIR
  // Local, а не Roaming: 890 МБ не должны ездить за профилем по сети предприятия.
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Podskazych', 'gpu')
}

function packUrl(): string {
  const url = process.env.COPILOT_GPU_PACK_URL ?? GPU_PACK_RELEASE_URL
  return url.endsWith('/') ? url : `${url}/`
}

const REQUIRED = [HELPER_EXE, GGML_MODEL_NAME]

/** Описание пакета; в разработке суммы подменяются COPILOT_GPU_PACK_PINS. */
function packAssets(): readonly PackAsset[] {
  const raw = app.isPackaged ? undefined : process.env.COPILOT_GPU_PACK_PINS
  if (!raw) return GPU_PACK_ASSETS
  const { assets, problem } = withPinOverrides(GPU_PACK_ASSETS, raw)
  if (problem) console.warn(`[gpu] COPILOT_GPU_PACK_PINS не применён: ${problem}`)
  else console.log(`[gpu] контрольные суммы пакета из COPILOT_GPU_PACK_PINS: ${assets.map((a) => `${a.name} ${a.bytes}`).join(', ')}`)
  return assets
}

/** Видеокарта из COPILOT_GPU_FAKE_VENDOR — только в разработке. */
function fakeAdapters(): GpuAdapter[] {
  const raw = app.isPackaged ? undefined : process.env.COPILOT_GPU_FAKE_VENDOR
  if (!raw) return []
  const [vendorId, deviceId = '0'] = raw.split(':')
  return gpuAdaptersOf({ gpuDevice: [{ vendorId: vendorId?.trim(), deviceId: deviceId.trim() }] })
}

function savedOf(raw: unknown): Saved {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const lastRaw = (r.last && typeof r.last === 'object' ? r.last : null) as Record<string, unknown> | null
  return {
    lastDevice: typeof r.lastDevice === 'string' ? r.lastDevice : null,
    last:
      lastRaw && typeof lastRaw.device === 'string'
        ? {
            device: lastRaw.device,
            label: typeof lastRaw.label === 'string' ? lastRaw.label : '',
            fallbackReason: typeof lastRaw.fallbackReason === 'string' ? lastRaw.fallbackReason : null,
            gpu: parseGpuGate(lastRaw.gpu),
          }
        : null,
  }
}

export class GpuPackManager {
  readonly root = packRoot()
  /** до total: его размер считается по этому списку */
  private readonly assets = packAssets()
  private readonly statePath: string
  /** userData/stt-cache сайдкара: там итоги стартовой проверки видеокарты и флаг сбоя */
  private readonly sttCacheDir: string
  private readonly sessionActive: () => boolean
  private readonly onChange: (s: GpuPackState) => void

  private adapters: GpuAdapter[] = []
  private installed: InstalledPack | null = null
  private phase: GpuPackPhase = 'absent'
  private done = 0
  private total = packBytes(this.assets)
  private speed: number | null = null
  private partial = 0
  private error: string | null = null
  private pending: 'install' | 'remove' | null = null
  private saved: Saved = { lastDevice: null, last: null }
  private abort: AbortController | null = null
  private cancelRequested = false
  private readonly ready: Promise<void>

  constructor(o: { statePath: string; sttCacheDir: string; sessionActive: () => boolean; onChange: (s: GpuPackState) => void }) {
    this.statePath = o.statePath
    this.sttCacheDir = o.sttCacheDir
    this.sessionActive = o.sessionActive
    this.onChange = o.onChange
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    this.saved = savedOf(await readFile(this.statePath, 'utf8').then(JSON.parse, () => null))
    await sweepLeftovers(this.root, GPU_PACK_VERSION).catch(() => {})
    this.installed = await readInstalled(this.root, GPU_PACK_VERSION, REQUIRED)
    this.phase = this.installed ? 'installed' : 'absent'
    this.partial = this.installed ? 0 : await partialBytes(this.root, this.assets)
    try {
      // 'basic' не будит видеокарту и отвечает за миллисекунды; таймаут — на случай сломанного драйвера.
      const info = await Promise.race([app.getGPUInfo('basic'), new Promise((r) => setTimeout(() => r(null), 5000))])
      this.adapters = gpuAdaptersOf(info)
    } catch (e) {
      console.warn('[gpu] список видеокарт не получен:', e)
    }
    this.adapters.push(...fakeAdapters())
    const names = this.adapters.map((a) => `0x${a.vendorId.toString(16)}:0x${a.deviceId.toString(16)}`).join(', ')
    console.log(
      `[gpu] видеокарты: ${names || 'нет данных'}; пакет ${this.installed ? `установлен (${this.installed.dir})` : this.partial ? `скачан частично, ${this.partial} байт` : 'не скачан'}`,
    )
  }

  private snapshot(): GpuPackState {
    return {
      candidate: hasPackCandidate(this.adapters),
      offer: shouldOfferPack(this.adapters, this.saved.lastDevice),
      phase: this.phase,
      totalBytes: this.total,
      doneBytes: this.done,
      speedBps: this.speed,
      partialBytes: this.partial,
      error: this.error,
      last: this.saved.last,
      pending: this.pending,
      sessionActive: this.sessionActive(),
    }
  }

  private emit(): void {
    this.onChange(this.snapshot())
  }

  private save(): void {
    void mkdir(dirname(this.statePath), { recursive: true })
      .then(() => writeFile(this.statePath, JSON.stringify(this.saved), 'utf8'))
      .catch((e) => console.warn('[gpu] состояние не сохранилось:', e))
  }

  async state(): Promise<GpuPackState> {
    await this.ready
    return this.snapshot()
  }

  /** «Скачать», «Докачать», «Повторить». Повторный вызов во время загрузки ничего не делает. */
  async download(): Promise<void> {
    await this.ready
    if (this.phase !== 'absent' && this.phase !== 'error') return
    const abort = new AbortController()
    this.abort = abort
    this.error = null
    this.phase = 'downloading'
    this.done = this.partial
    this.speed = null
    this.emit()
    console.log(`[gpu] загрузка пакета: ${packUrl()} → ${this.root}`)

    try {
      this.installed = await installPack({
        root: this.root,
        version: GPU_PACK_VERSION,
        assets: this.assets,
        baseUrl: packUrl(),
        required: REQUIRED,
        signal: abort.signal,
        onProgress: (p) => {
          this.phase = p.phase
          this.done = p.doneBytes
          this.total = p.totalBytes || this.total
          this.speed = p.speedBps
          this.emit()
        },
      })
      this.phase = 'installed'
      this.partial = 0
      // Прошлый итог старта был без пакета — новый скажет следующая сессия.
      this.saved.last = null
      this.save()
      await this.forgetGate()
      // Идущую сессию не трогаем: сайдкар уже выбрал движок, пакет подхватит следующий «Старт».
      this.pending = this.sessionActive() ? 'install' : null
      console.log(`[gpu] пакет установлен: ${this.installed.dir}${this.pending ? ' — применится со следующей сессии' : ''}`)
    } catch (e) {
      if (e instanceof PackCancelled) {
        if (this.cancelRequested) await discardPartial(this.root).catch(() => {})
        this.phase = 'absent'
        console.log('[gpu] загрузка отменена')
      } else {
        this.phase = 'error'
        this.error = e instanceof PackError ? e.message : `Пакет не скачался: ${e instanceof Error ? e.message : String(e)}`
        console.warn('[gpu] пакет не установлен:', this.error)
      }
      this.partial = await partialBytes(this.root, this.assets).catch(() => 0)
    } finally {
      if (this.abort === abort) this.abort = null
      this.cancelRequested = false
      this.speed = null
      this.emit()
    }
  }

  /** «Отмена»: скачанное выбрасывается. Обрыв сети и выход из приложения, наоборот, его сохраняют. */
  cancel(): void {
    if (!this.abort) return
    this.cancelRequested = true
    this.abort.abort()
  }

  /** Выход из приложения: загрузку оборвать, скачанное оставить для докачки. */
  shutdown(): void {
    this.abort?.abort()
  }

  async remove(): Promise<void> {
    await this.ready
    if (this.phase !== 'installed') return
    if (this.sessionActive()) {
      this.pending = 'remove'
      console.log('[gpu] удаление пакета отложено до конца сессии')
      this.emit()
      return
    }
    this.phase = 'removing'
    this.pending = null
    this.emit()
    // Помощник гаснет вслед за сайдкаром не мгновенно: после «Стоп» его файлы ещё секунду заняты.
    for (let attempt = 0; ; attempt++) {
      try {
        await removePack(this.root, GPU_PACK_VERSION)
        this.installed = null
        this.phase = 'absent'
        this.partial = 0
        this.saved.last = null
        this.save()
        await this.forgetGate()
        console.log('[gpu] пакет удалён')
        break
      } catch (e) {
        if (e instanceof PackError && e.resumable && attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        console.warn('[gpu] пакет не удалился:', e)
        this.phase = 'installed'
        // Файлы всё ещё заняты — попробуем после следующей сессии.
        this.pending = 'remove'
        break
      }
    }
    this.emit()
  }

  /** Сессия закончилась: отложенное удаление выполняется, отметка «со следующей сессии» снимается. */
  async sessionEnded(): Promise<void> {
    await this.ready
    if (this.pending === 'remove') {
      this.phase = 'installed'
      await this.remove()
      return
    }
    if (this.pending === 'install') this.pending = null
    this.emit()
  }

  /**
   * Итоги стартовой проверки и флаг сбоя видеокарты — забыть. Их ключ — устройство, драйвер и sha помощника
   * с моделью, поэтому «Удалить» и новая загрузка тех же файлов его не меняли: разовый сбой драйвера держал
   * процессор, и переустановка не помогала. Установка и удаление — явное «проверь заново».
   */
  private async forgetGate(): Promise<void> {
    await forgetGateVerdicts(this.sttCacheDir).then(
      (n) => n > 0 && console.log(`[gpu] итоги проверки видеокарты сброшены: ${n}`),
      (e) => console.warn('[gpu] итоги проверки видеокарты не сброшены:', e),
    )
  }

  /** Пакет для запуска сайдкара; null — не установлен. Проверка дешёвая: манифест и размеры файлов. */
  async forSidecar(): Promise<SidecarPack | null> {
    await this.ready
    if (this.pending === 'remove') {
      await this.sessionEnded()
      // Файлы так и не удалились (их держит проводник, консоль или антивирус). Пакет, который человек велел
      // удалить, не запускаем: отметка остаётся, удаление повторится после этой сессии.
      if (this.pending === 'remove') return null
    }
    if (this.phase !== 'installed') return null
    this.installed = await readInstalled(this.root, GPU_PACK_VERSION, REQUIRED)
    if (!this.installed) {
      // Файлы удалили или повредили руками — честнее снова предложить скачать, чем запускать сломанное.
      console.warn('[gpu] пакет повреждён или удалён вручную — считаем, что его нет')
      this.phase = 'absent'
      this.emit()
      return null
    }
    this.pending = null
    return { helper: join(this.installed.dir, HELPER_EXE), model: join(this.installed.dir, GGML_MODEL_NAME) }
  }

  /** Сайдкар готов: запоминаем, где идёт распознавание и чем кончилась проверка видеокарты. */
  noteReady(info: { device: string; label: string; fallbackReason: string | null; gpu: SttOutcome['gpu'] }): void {
    this.saved.lastDevice = info.device || null
    if (this.phase === 'installed' && this.pending !== 'install') {
      this.saved.last = { device: info.device, label: info.label, fallbackReason: info.fallbackReason, gpu: info.gpu }
    }
    this.save()
    this.emit()
  }
}
