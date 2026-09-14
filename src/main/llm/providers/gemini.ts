import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { providerById } from '@shared/providers'
import { cliEnv, openInTerminal, providerWorkDir, readLines, resolveCommand, runCli, spawnCli, stderrTail, treeKill } from '../cli'
import { WARMUP_PROMPT, suggestSystemPrompt } from '../prompts'
import { TurnQueue } from '../queue'
import {
  CancelledError,
  LlmError,
  llmErrorText,
  type AskOptions,
  type Availability,
  type LlmErrorKind,
  type LlmSession,
  type ModelInfo,
  type ProviderAdapter,
  type SessionConfig,
  type TurnHandlers,
  type TurnInput,
} from '../types'
import {
  AgyTurn,
  StartGate,
  agyArgs,
  agyPermissionProblem,
  agyStderrErrors,
  agyEffort,
  agyUserLine,
  classifyAgyError,
  composeAgyMessage,
  isSandboxRejection,
  looksLikeLoginPrompt,
  parseAgyLine,
  parseAgyModels,
  quickModel,
  type AgyOutcome,
} from './geminiProtocol'

/**
 * Gemini через Antigravity CLI (agy) — одна живая сессия на созвон, как у Claude Code:
 * `agy --input-format stream-json --output-format stream-json`, вопросы строками в stdin.
 * Протокол и его источники — в geminiProtocol.ts.
 *
 * Что здесь важно:
 * - Только ответы текстом: флагов, снимающих разрешения, не передаём. Но в headless agy
 *   слушается режима разрешений из настроек пользователя: мягко отклоняет действие он, только
 *   если режим требует одобрения (а запись в рабочую папку разрешена и тогда). Запретить из
 *   клиента нельзя, поэтому перед запуском читаем настройки и с опасными не запускаемся
 *   (agyPermissionProblem), а запускаем с --sandbox, пока он не отказал. Рабочая папка —
 *   пустая подпапка userData.
 * - Веб-поиска у agy для второго агента нет: чтение адресов в headless по умолчанию тоже
 *   мягко отклоняется, а разрешать его пришлось бы в настройках пользователя. SessionConfig.web
 *   здесь не действует — main и не передаёт его провайдерам без webSearch.
 * - Снимков экрана не отправляем: способ не описан в документации agy.
 * - На Windows у agy были ошибки, когда вывод идёт не в окно терминала, а в трубу: процесс
 *   молча ничего не пишет (issues #76 и #408 в google-antigravity/antigravity-cli). Если за
 *   окно тишины от процесса не пришло ни строки, текст ошибки говорит об этом прямо —
 *   иначе «не отвечает» читалось бы как сбой сети.
 */

const INFO = providerById('gemini')

/** Установщик agy кладёт программу в %LOCALAPPDATA%\agy\bin; winget-ссылки уже в knownDirs. */
const extraDirs = () => [join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agy', 'bin')]

/**
 * Прогрев без лимита тишины мог бы висеть вечно (молчащий agy, вход, который ждёт кода) и
 * держать очередь. Своего таймера у прогрева в очереди нет, поэтому сторожим его здесь.
 */
const PRIME_SILENCE_MS = 60_000

const IMAGES_TEXT =
  'Antigravity CLI не принимает снимки экрана из приложения: способ передать картинку не описан в его документации. Для снимка выберите другого провайдера.'

interface Question {
  text: string
  prime?: boolean
}

/** Модели, известные адаптеру: живой список из `agy models`, пока его нет — запасной. */
let knownModels: string[] = INFO.models.map((m) => m.id)

/**
 * agy умер на старте из-за --sandbox (песочница agy для Windows не описана) — до перезапуска
 * приложения запускаем без флага. Безопасность держит проверка настроек, флаг — запасной слой.
 */
let sandboxBroken = false

/**
 * Что agy сделает без спроса, решают настройки пользователя (см. agyPermissionProblem).
 * Файла нет — умолчания agy, это безопасно. Читаем при каждом запуске: пользователь мог
 * поправить настройки по нашему сообщению, и перезапускать приложение ради этого незачем.
 */
async function agySettingsProblem(): Promise<string | null> {
  const file = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  try {
    return agyPermissionProblem(await readFile(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return agyPermissionProblem(null)
    return agyPermissionProblem(null, (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e)))
  }
}

class GeminiSession implements LlmSession {
  private cfg: SessionConfig = { model: INFO.defaultModel, thinking: true }
  private proc: ChildProcess | null = null
  /** Один старт на всех ждущих; kill сдвигает поколение и забывает старт (см. StartGate). */
  private readonly gate = new StartGate<ChildProcess>()
  /** С чем запущен текущий процесс: сравниваем с ним, а не с прошлым вызовом configure. */
  private runningKey: string | undefined
  /** Системный промпт уходит первым сообщением сессии. */
  private systemSent = false
  private turnSeq = 0
  private sawStdout = false
  /** Последний погашенный процесс не прислал ни строки — признак бага с трубой на Windows. */
  private lastKillSilent = false
  /** Хвост stderr погашенного процесса — чтобы понять, отчего он молчал. */
  private lastKillStderr = ''
  private stderr: () => string = () => ''
  private primeTimer: ReturnType<typeof setTimeout> | undefined
  /** Вопрос, ушедший в текущий процесс: если процесс не принял --sandbox, повторим его в новом. */
  private sent: Question | null = null
  private readonly turn = new AgyTurn()
  private readonly q: TurnQueue<Question>

  constructor() {
    this.q = new TurnQueue<Question>({
      provider: 'gemini',
      label: INFO.agent,
      transport: {
        ensure: () => {
          /* процесс поднимает send: старт асинхронный — найти программу, папку, окружение */
        },
        send: (q) => this.send(q),
        kill: () => this.kill(),
      },
    })
  }

  get busy(): boolean {
    return this.q.busy
  }

  configure(cfg: SessionConfig): void {
    this.cfg = { ...cfg }
    const differs = this.proc !== null && this.launchKey() !== this.runningKey
    this.q.reconfigure(differs)
  }

  warmup(): Promise<void> {
    return this.q.warmup({ text: WARMUP_PROMPT, prime: true }, () => this.proc !== null && this.systemSent)
  }

  async ask(input: TurnInput, h: TurnHandlers, o: AskOptions = {}): Promise<string> {
    if (input.images?.length) throw new LlmError('images-unsupported', 'gemini', IMAGES_TEXT)
    try {
      return await this.q.ask({ text: input.text }, h, o)
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'timeout' && this.lastKillSilent) {
        // Молчание процесса бывает по двум причинам: agy ждёт входа (открыл браузер и ждёт его)
        // или известная ошибка agy на Windows с выводом в трубу. stderr иногда подсказывает первое.
        const stderr = agyStderrErrors(this.lastKillStderr)
        if (looksLikeLoginPrompt(stderr)) {
          throw new LlmError('not-logged-in', 'gemini', undefined, stderr)
        }
        const sec = o.silenceSec ? ` за ${o.silenceSec} с` : ''
        throw new LlmError(
          'timeout',
          'gemini',
          `Antigravity CLI запустился, но не прислал ни строки${sec}, сессия перезапущена. Возможно, он ждёт входа — нажмите «Войти» в выборе провайдера. ` +
            'Если вход выполнен, это известная ошибка agy на Windows: когда вывод читает программа, а не окно терминала, он молчит. ' +
            'Обновите Antigravity CLI до последней версии или выберите другого провайдера.',
          stderr || e.message,
        )
      }
      throw e
    }
  }

  stop(reason?: Error): void {
    this.q.stop(reason)
  }

  /* ---------- процесс ---------- */

  /** Модель с учётом «сразу»: у agy глубина зашита в slug модели. */
  private effectiveModel(): string {
    const model = this.cfg.model || INFO.defaultModel
    return this.cfg.thinking ? model : quickModel(model, knownModels)
  }

  private systemPrompt(): string {
    return suggestSystemPrompt(this.cfg.systemPrompt)
  }

  private launchKey(): string {
    const model = this.effectiveModel()
    return JSON.stringify([model, agyEffort(this.cfg.thinking, this.cfg.effort, model), this.systemPrompt()])
  }

  private async send(q: Question): Promise<void> {
    const proc = this.proc ?? (await this.gate.join((gen) => this.start(gen)))
    const seq = ++this.turnSeq
    this.turn.reset()
    const first = !this.systemSent
    this.systemSent = true
    const line = agyUserLine(composeAgyMessage(q.text, first ? this.systemPrompt() : undefined))
    if (q.prime) this.armPrimeWatch(seq)
    if (!proc.stdin || proc.stdin.destroyed) throw new LlmError('crashed', 'gemini')
    this.sent = q
    proc.stdin.write(line)
  }

  private async start(gen: number): Promise<ChildProcess> {
    const cmd = await resolveCommand(['agy'], extraDirs())
    if (!cmd) throw new LlmError('not-installed', 'gemini')
    const [cwd, env, problem] = await Promise.all([providerWorkDir('gemini'), cliEnv(), agySettingsProblem()])
    // Пока искали программу, сессию погасили или перезапустили — этот старт уже никому не нужен.
    if (!this.gate.isCurrent(gen)) throw new CancelledError()
    if (problem) throw new LlmError('unknown', 'gemini', problem, 'unsafe agy permission settings')
    const model = this.effectiveModel()
    const sandbox = !sandboxBroken
    const proc = spawnCli(cmd, agyArgs({ model, effort: agyEffort(this.cfg.thinking, this.cfg.effort, model), sandbox }), { cwd, env })
    this.attach(proc, sandbox)
    return proc
  }

  private attach(proc: ChildProcess, sandbox: boolean): void {
    this.proc = proc
    this.runningKey = this.launchKey()
    this.systemSent = false
    this.sawStdout = false
    this.stderr = stderrTail(proc.stderr, 2000)
    this.q.processStarted()

    // Все обработчики сверяются с текущим процессом: после перезапуска старый ещё доживает,
    // и его поздний result не должен закрыть вопрос нового.
    readLines(proc.stdout, (line) => {
      if (this.proc !== proc) return
      this.sawStdout = true
      this.q.activity()
      if (this.primeTimer) this.armPrimeWatch(this.turnSeq)
      this.onLine(line)
    })
    // Запись в stdin умершего процесса даёт EPIPE: без обработчика он уронил бы main.
    proc.stdin?.on('error', () => {})
    proc.on('error', (e) => {
      if (this.proc !== proc) return
      this.detach()
      if (this.q.busy) this.q.failAll(new LlmError('crashed', 'gemini', llmErrorText('crashed', 'gemini', e.message), e.message))
    })
    proc.on('close', (code) => {
      if (this.proc !== proc) return
      const silent = !this.sawStdout
      if (sandbox && silent && isSandboxRejection(agyStderrErrors(this.stderr()))) {
        this.retryWithoutSandbox()
        return
      }
      this.detach()
      if (this.q.busy) this.q.failAll(this.exitError(code, silent))
    })
  }

  /**
   * agy не поднялся с --sandbox. Запоминаем это до перезапуска приложения и повторяем тот же
   * вопрос в новом процессе без флага: пользователь не должен видеть сбой из-за запасного слоя.
   * Повтор один — второй раз sandboxBroken уже стоит.
   */
  private retryWithoutSandbox(): void {
    sandboxBroken = true
    console.warn('[gemini] agy не запустился с --sandbox, запускаю без него:', agyStderrErrors(this.stderr()).slice(-300))
    const q = this.sent
    this.detach()
    if (!q || !this.q.busy) return
    this.send(q).catch((e: unknown) => {
      // Вопрос ещё тот же — отклоняем его; иначе его уже сняла очередь (стоп, тишина).
      if (this.sent === q || this.sent === null) this.q.failTurn(e instanceof Error ? e : new Error(String(e)))
    })
  }

  private onLine(line: string): void {
    const ev = parseAgyLine(line)
    if (!ev || !this.q.busy) return
    const outcome = this.turn.handle(ev, {
      delta: (t) => this.q.delta(t),
      blockBreak: () => this.q.blockBreak(),
      thinking: () => this.q.thinking(),
      tool: (name) => this.q.tool(name),
    })
    if (outcome) this.settle(outcome)
  }

  private settle(outcome: AgyOutcome): void {
    this.clearPrimeWatch()
    if (outcome.ok) {
      this.q.finish(outcome.response)
      return
    }
    const err = this.error(outcome.kind, outcome.detail)
    // Не вошли — не ответит и новая сессия, а этот процесс может ждать кода входа из stdin:
    // гасим и отклоняем всю очередь.
    if (outcome.kind === 'not-logged-in') {
      this.kill()
      this.q.failAll(err)
      return
    }
    // agy сам сдался по --print-timeout: процессу после этого верить нельзя. Очередь уйдёт в новый.
    if (outcome.kind === 'timeout') this.kill()
    this.q.failTurn(err)
  }

  private error(kind: LlmErrorKind, detail: string): LlmError {
    const text =
      kind === 'unknown'
        ? `Antigravity CLI вернул ошибку: ${detail.slice(0, 500)}`
        : llmErrorText(kind, 'gemini', kind === 'rate-limit' || kind === 'timeout' ? detail.slice(0, 300) : undefined)
    return new LlmError(kind, 'gemini', text, detail)
  }

  /** Процесс завершился посреди хода. */
  private exitError(code: number | null, silent: boolean): LlmError {
    const tail = agyStderrErrors(this.stderr())
    const kind = tail ? classifyAgyError(tail) : 'unknown'
    if (kind !== 'unknown') return this.error(kind, tail)
    const detail = tail ? ` ${tail.slice(-400)}` : ''
    if (code === 2) {
      return new LlmError('crashed', 'gemini', `Antigravity CLI не принял сообщение от приложения (код 2).${detail}`, tail)
    }
    if (silent) {
      return new LlmError(
        'crashed',
        'gemini',
        `Antigravity CLI завершился, не прислав ни строки (код ${code ?? '—'}). Проверьте, что вход выполнен: запустите agy в терминале.${detail}`,
        tail,
      )
    }
    return new LlmError('crashed', 'gemini', llmErrorText('crashed', 'gemini', `Код ${code ?? '—'}.${detail}`), tail)
  }

  private detach(): void {
    this.proc = null
    this.systemSent = false
    this.runningKey = undefined
    this.clearPrimeWatch()
  }

  /** Погасить процесс, не трогая вопросы (зовёт и очередь). */
  private kill(): void {
    // Идущий старт забываем: вопрос, заданный сразу после гашения, поднимет свой процесс,
    // а не получит отмену брошенного старта.
    this.gate.cancel()
    const proc = this.proc
    this.lastKillSilent = proc !== null && !this.sawStdout
    this.lastKillStderr = proc !== null ? this.stderr() : ''
    this.detach()
    treeKill(proc)
  }

  /* ---------- сторож прогрева ---------- */

  private armPrimeWatch(seq: number): void {
    clearTimeout(this.primeTimer)
    this.primeTimer = setTimeout(() => {
      this.primeTimer = undefined
      if (seq !== this.turnSeq || !this.q.busy) return
      // Гасим процесс и снимаем только прогрев: вопрос из очереди поднимет новую сессию.
      this.kill()
      this.q.failTurn(new LlmError('timeout', 'gemini', 'Прогрев Antigravity CLI не ответил', 'prime silence'))
    }, PRIME_SILENCE_MS)
  }

  private clearPrimeWatch(): void {
    clearTimeout(this.primeTimer)
    this.primeTimer = undefined
  }
}

async function detect(): Promise<Availability> {
  const cmd = await resolveCommand(['agy'], extraDirs())
  if (!cmd) return { state: 'not-installed' }
  const ver = await runCli(cmd, ['--version'], { env: await cliEnv(), timeoutMs: 5000 })
  if (ver.timedOut) return { state: 'unknown', message: 'Antigravity CLI не ответил за 5 с' }
  const out = `${ver.stdout}\n${ver.stderr}`
  const version = /\d+\.\d+\.\d+/.exec(out)?.[0]
  if (ver.code === 0 || version) {
    // Команды «статус входа» у agy нет: вход проверится первым вопросом. Установлен — значит, готов.
    return { state: 'ok', version }
  }
  // Флага --version может не быть в старой сборке: программа есть и отвечает — считаем установленной.
  if (/flag provided but not defined|unknown (flag|option)/i.test(out)) return { state: 'ok' }
  return {
    state: 'error',
    message: out.trim().slice(-500) || ver.error?.message || `Antigravity CLI завершился с кодом ${ver.code}`,
  }
}

async function listModels(): Promise<ModelInfo[]> {
  const cmd = await resolveCommand(['agy'], extraDirs())
  if (!cmd) throw new Error('Antigravity CLI не установлен')
  const [cwd, env] = await Promise.all([providerWorkDir('gemini'), cliEnv()])
  const r = await runCli(cmd, ['models'], { cwd, env, timeoutMs: 10_000 })
  const models = r.code === 0 ? parseAgyModels(r.stdout) : []
  // Пустой вывод (в том числе молчащий agy на Windows) — не список: реестр возьмёт запасной.
  if (!models.length) throw new Error(`agy models не отдал список (код ${r.code ?? '—'})`)
  knownModels = models.map((m) => m.id)
  return models
}

export function createGeminiAdapter(): ProviderAdapter {
  return {
    id: 'gemini',
    detect,
    listModels,
    createSession: () => new GeminiSession(),
    async openLogin(): Promise<void> {
      // Отдельной команды входа у agy нет: первый запуск сам открывает вход через браузер.
      // Пояснение — строкой в окне, иначе пустой терминал с agy непонятен.
      // Команда уходит в `cmd /c start "" cmd /k <команда>`: «&&» без ^ выполнил бы внешний
      // скрытый cmd, и agy запустился бы невидимым. ^&^& доходит до окна как «&&».
      // В самом тексте нет других символов, которые cmd.exe понял бы как команду (| < > ^ %).
      await openInTerminal(
        `echo Вход в Antigravity CLI: откроется браузер, войдите в аккаунт Google. Когда agy будет готов к вопросам, закройте это окно и вернитесь в приложение. ^&^& ${INFO.login!.command}`,
        { cwd: await providerWorkDir('gemini') },
      )
    },
  }
}
