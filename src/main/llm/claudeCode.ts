import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import { CancelledError, SkippedError } from './types'
import { NO_THINKING_RULE, SUGGEST_SYSTEM, WARMUP_PROMPT } from './prompts'

/**
 * Подсказки через Claude Code — на вашей подписке, без API-ключа.
 *
 * ОДНА живая сессия на весь созвон. Дорогое начало платится один раз, по
 * кнопке «Старт». Для сравнения, запуск CLI на каждый вопрос стоил 16 секунд.
 *
 * Три вещи выяснены пробами, и каждая из них неочевидна:
 *
 * 1. CLI ничего не делает, пока в stdin не пришёл первый байт: событие init
 *    появляется вместе с первым сообщением, а не при запуске. Поэтому прогрев
 *    — это настоящий вопрос, а не просто поднятый процесс.
 * 2. Глубина размышлений задаётся флагом --effort. Выключать мышление на
 *    Opus 5 и Sonnet 5 не нужно: документация предупреждает, что без него в
 *    ответ протекают служебные теги, и советует вместо этого низкое усилие.
 *    Замер 11 сентября, Opus 5, по три вопроса: мышление выключено — первое
 *    слово через 1,0 с, ответ за 10,7 с; усилие low — 1,1 с и 9,4 с.
 *    Скорость та же, риска нет. На Haiku 4.5 усилия нет, и там «сразу»
 *    по-прежнему выключает мышление переменной MAX_THINKING_TOKENS.
 * 3. Раньше это делалось через Agent SDK и молча зависало внутри Electron.
 *    Причина в предупреждении самого CLI: «no stdin data received in 3s». SDK
 *    держал канал открытым и пустым: он ждал готовности CLI, CLI ждал ввода.
 *    Здесь мы говорим с CLI напрямую и пишем в stdin сразу же.
 */

// Встроенный промпт суфлёра, правило «не рассуждай» и прогревочный вопрос живут в prompts.ts:
// тот же текст уходит всем провайдерам. Правило «не рассуждай» здесь — только для Haiku 4.5.

/** Уровень усилия. На Haiku 4.5 не поддерживается — флаг не передаём. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Сообщение об ошибке в человеческом виде. Отдельная забота — исчерпанный
 * лимит: он приходит обычным текстом, и посреди созвона надо сразу понимать,
 * что делать, а не читать про сессии и токены.
 */
function explainError(text: string, subtype?: string): string {
  const raw = text.trim()
  if (/limit|лимит/i.test(raw)) {
    return `Лимит Claude исчерпан. ${raw} Пока лимит не обновится, подсказок не будет — можно вести созвон без суфлёра.`
  }
  if (!raw) return `Claude Code вернул ошибку${subtype ? ` (${subtype})` : ''}`
  return raw
}

interface Pending {
  resolve: (text: string) => void
  reject: (e: Error) => void
  onDelta: (chunk: string) => void
  /** Дёргается, когда модель начала размышлять, а не писать ответ. */
  onThinking?: () => void
  /** Любое событие сессии, пока вопрос в работе или ждёт очереди: по нему считается таймаут. */
  onActivity?: () => void
  /** Проверяется, когда подходит очередь: устаревший вопрос в модель не уходит. */
  isStale?: () => boolean
  /** Вопрос ушёл в модель — сразу или когда подошла очередь. */
  onStart?: () => void
  /** Модель вызвала инструмент, например веб-поиск. */
  onTool?: (name: string) => void
  /** У вопроса свой лимит тишины: пока он в работе, решает его таймер. */
  limited?: boolean
}

export interface AskOptions {
  onThinking?: () => void
  isStale?: () => boolean
  onStart?: () => void
  onTool?: (name: string) => void
  /**
   * Таймаут по тишине: столько секунд без единого события от сессии — и она
   * считается зависшей. В очереди тоже считается, но пока впереди печатается
   * живой ответ, таймер перезаводится.
   */
  silenceSec?: number
  silenceMessage?: string
  /** Картинки к вопросу — снимок экрана. Идут перед текстом: модель сначала смотрит, потом читает. */
  images?: ImageInput[]
}

export interface ImageInput {
  /** base64 без префикса data: */
  data: string
  mediaType: 'image/jpeg' | 'image/png'
}

type Question = { text: string; images?: ImageInput[] }

// Ошибки очереди общие для всех провайдеров: index.ts узнаёт их через instanceof,
// поэтому класс должен быть один — он живёт в types.ts.
export { SkippedError, CancelledError }

/**
 * Пустая конфигурация MCP: без неё CLI поднимает все серверы пользователя,
 * а это лишние ~4.5 с на старте. Суфлёру они не нужны.
 * Пишем файлом — передать JSON аргументом через оболочку не выходит,
 * кавычки съедаются.
 */
function noMcpConfigPath(): string {
  const p = join(app.getPath('userData'), 'no-mcp.json')
  if (!existsSync(p)) writeFileSync(p, '{"mcpServers":{}}', 'utf8')
  return p
}

export class ClaudeCodeSuggester {
  private proc: ChildProcess | null = null
  private system: string | undefined
  /** блок из текста прикреплённых файлов; пусто — файлов нет или это второй агент */
  private context = ''
  private model: string | undefined
  private thinking = true
  /** Усилие в режиме «думает»; undefined — по умолчанию CLI. «Сразу» всегда low. */
  private effort: EffortLevel | undefined
  /** Разрешённые встроенные инструменты: проверяющему — веб-поиск, суфлёру — ничего. */
  private tools: string[] | undefined
  /** Системный промпт уходит в первом сообщении сессии, отдельного флага CLI нет. */
  private systemSent = false
  private current: Pending | null = null
  private queue: Array<{ q: Question; p: Pending }> = []
  /** Флаги запуска поменялись посреди ответа: перезапуск — когда он допишется. */
  private restartPending = false
  /** С какими настройками запущен текущий процесс: сравниваем с ними, а не с прошлым вызовом. */
  private runningKey: string | undefined
  /** Прогрев в очереди или в работе; started — он уже идёт в текущем процессе. */
  private priming: { done: Promise<void>; started: boolean } | null = null
  private acc = ''
  private stderrTail = ''

  setSystemPrompt(prompt: string | undefined): void {
    // Промпт задаётся первым сообщением, поэтому смена требует новой сессии.
    this.reconfigure(() => {
      this.system = prompt?.trim() || undefined
    })
  }

  /** Материалы пользователя к системному промпту: тоже уходят первым сообщением, смена — новая сессия. */
  setContext(block: string | undefined): void {
    this.reconfigure(() => {
      this.context = block ?? ''
    })
  }

  /** Модель задаётся аргументом запуска, поэтому смена тоже требует новой сессии. */
  setModel(model: string | undefined): void {
    this.reconfigure(() => {
      this.model = model
    })
  }

  /**
   * Режим «думает» или «сразу». Сессию перезапускает, только если меняются
   * флаги запуска: «думает» с глубиной low запускается так же, как «сразу».
   */
  setThinking(on: boolean): void {
    this.reconfigure(() => {
      this.thinking = on
    })
  }

  /** Глубина для режима «думает». */
  setEffort(level: EffortLevel | undefined): void {
    this.reconfigure(() => {
      this.effort = level
    })
  }

  /** Встроенные инструменты задаются при запуске. */
  setTools(tools: string[] | undefined): void {
    this.reconfigure(() => {
      this.tools = tools?.length ? [...tools].sort() : undefined
    })
  }

  /** Всё, с чем запускается процесс и открывается сессия. */
  private launchKey(): string {
    return JSON.stringify([this.model, this.effectiveEffort, this.tools, this.isHaiku && !this.thinking, this.system, this.context])
  }

  /**
   * Применить настройку и перезапустить сессию, если поменялось то, с чем она
   * запущена. Идущий ответ не обрываем, перезапуск ждёт его конца: раньше
   * переключение режима посреди ответа стирало уже напечатанный текст.
   */
  private reconfigure(apply: () => void): void {
    apply()
    // Сравниваем с тем, с чем процесс запущен: включили и тут же выключили веб —
    // перезапускать нечего, и отложенный перезапуск тоже снимается.
    const differs = this.proc !== null && this.launchKey() !== this.runningKey
    if (this.current) this.restartPending = differs
    else if (differs) this.stop()
  }

  private get isHaiku(): boolean {
    return /haiku/i.test(this.model ?? '')
  }

  /** «Сразу» — низкое усилие, «думает» — выбранное; на Haiku флаг не передаётся. */
  private get effectiveEffort(): EffortLevel | undefined {
    if (this.isHaiku) return undefined
    return this.thinking ? this.effort : 'low'
  }

  get alive(): boolean {
    return this.proc !== null && !this.proc.killed
  }

  /** Сессия занята ответом: новый вопрос встанет в очередь. */
  get busy(): boolean {
    return this.current !== null
  }

  /**
   * Поднять сессию заранее. Одним запуском не обойтись: пока CLI не получил
   * сообщение, он не начинает работу, — поэтому шлём короткий вопрос и
   * выбрасываем ответ. Эти 4 секунды платятся до созвона, а не во время.
   */
  async warmup(): Promise<void> {
    // Перезапуск ждёт конца ответа — тогда прогрев встаёт в очередь за ним.
    if (this.alive && this.systemSent && !this.restartPending) return
    // Прогрев зовёт каждая смена настройки. Тот, что ждёт очереди, прогреет и
    // перезапущенную сессию — второй не нужен. А тот, что уже идёт в старом
    // процессе, новую сессию не прогреет: после перезапуска нужен ещё один.
    const pending = this.priming
    if (pending && !(pending.started && this.restartPending)) return pending.done
    const entry = { done: Promise.resolve(), started: false }
    this.priming = entry
    entry.done = this.ask(WARMUP_PROMPT, () => {}, {
      onStart: () => {
        entry.started = true
      },
    })
      .then(
        () => {},
        () => {
          /* прогрев не удался — обычный вопрос попробует ещё раз */
        },
      )
      .finally(() => {
        if (this.priming === entry) this.priming = null
      })
    await entry.done
  }

  private ensure(): void {
    if (this.alive) return

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify(noMcpConfigPath()),
    ]
    if (this.model) args.push('--model', this.model)
    const effort = this.effectiveEffort
    if (effort) args.push('--effort', effort)
    if (this.tools?.length) args.push('--allowedTools', ...this.tools)

    const proc = spawn(
      'claude',
      args,
      {
        // shell обязателен: `claude` в PATH — скрипт-обёртка, а не бинарник.
        shell: true,
        windowsHide: true,
        cwd: app.getPath('userData'),
        // Мышление выключаем только там, где нет усилия, — на Haiku 4.5.
        env: this.isHaiku && !this.thinking ? { ...process.env, MAX_THINKING_TOKENS: '0' } : process.env,
      },
    )
    this.proc = proc
    this.runningKey = this.launchKey()
    this.systemSent = false
    this.acc = ''
    this.stderrTail = ''
    this.restartPending = false

    // Все обработчики сверяются с текущим процессом. После перезапуска старый
    // процесс ещё доживает: его поздний `close` обнулял ссылку на уже новый
    // процесс и ронял чужой вопрос, а поздняя строка `result` могла закрыть
    // новый вопрос старым ответом.
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
      if (this.proc === proc) this.onLine(line)
    })

    proc.stderr?.on('data', (b: Buffer) => {
      if (this.proc === proc) this.stderrTail = (this.stderrTail + b.toString()).slice(-3000)
    })

    proc.on('error', (e) => {
      if (this.proc === proc) this.fail(e)
    })

    proc.on('close', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      if (this.current || this.queue.length) {
        this.fail(new Error(this.stderrTail.trim() || `Claude Code завершился (код ${code})`))
      }
    })
  }

  private onLine(line: string): void {
    let ev: {
      type?: string
      event?: {
        type?: string
        content_block?: { type?: string; name?: string }
        delta?: { type?: string; text?: string }
      }
      is_error?: boolean
      subtype?: string
      result?: string
    }
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }

    // Любая строка — признак жизни. Пока идёт веб-поиск, дельт нет,
    // но строки о вызове инструмента приходят.
    this.current?.onActivity?.()
    for (const w of this.queue) w.p.onActivity?.()

    if (ev.type === 'stream_event') {
      // Новый текстовый блок после уже написанного — например, вердикт после
      // веб-поиска. Без разделителя «Проверю через поиск.» и «ВЕРНО» склеивались
      // в одну строку, и вердикт не распознавался.
      if (ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text' && this.acc && this.current) {
        this.acc += '\n\n'
        this.current.onDelta('\n\n')
      }
      const block = ev.event?.content_block
      if (ev.event?.type === 'content_block_start' && (block?.type === 'tool_use' || block?.type === 'server_tool_use')) {
        this.current?.onTool?.(block.name ?? '')
      }
      const d = ev.event?.delta
      if (d?.type === 'text_delta' && d.text && this.current) {
        this.acc += d.text
        this.current.onDelta(d.text)
      } else if (d?.type === 'thinking_delta' && this.current) {
        // Сам текст размышлений не показываем: он длинный и не для чтения
        // вслух. Важно только сообщить окну, что пауза осмысленная.
        this.current.onThinking?.()
      }
      return
    }

    if (ev.type === 'result') {
      const done = this.current
      const text = this.acc.trim() || (typeof ev.result === 'string' ? ev.result : '')
      this.acc = ''
      this.current = null
      if (done) {
        // Ошибку нельзя отдавать как ответ: панель покажет её тем же кеглем,
        // что и подсказку, и на созвоне её можно прочитать вслух. Кончившийся
        // лимит приходит именно так — обычным текстом в поле result.
        if (ev.is_error) done.reject(new Error(explainError(text, ev.subtype)))
        else done.resolve(text)
      }
      this.drain()
    }
  }

  private fail(e: Error): void {
    const done = this.current
    this.current = null
    const waiting = this.queue.splice(0)
    this.proc = null
    this.restartPending = false
    done?.reject(e)
    for (const w of waiting) w.p.reject(e)
  }

  /** Следующий вопрос из очереди: CLI обрабатывает строго по одному. */
  private drain(): void {
    if (this.current) return
    // Настройки поменялись, пока шёл ответ: перезапускаем сейчас, между вопросами.
    if (this.restartPending) {
      this.restartPending = false
      this.kill()
    }
    let next = this.queue.shift()
    // Устаревший вопрос не держит очередь и не тратит лимиты.
    while (next?.p.isStale?.()) {
      next.p.reject(new SkippedError())
      next = this.queue.shift()
    }
    if (!next) return
    this.ensure()
    this.current = next.p
    this.acc = ''
    this.write(next.q)
    // Отсчёт тишины — с момента, когда вопрос ушёл в модель, а не с последнего события очереди.
    next.p.onActivity?.()
    next.p.onStart?.()
  }

  private write({ text, images = [] }: Question): void {
    // Системный промпт идёт вместе с первым сообщением сессии.
    const system = (this.system ?? SUGGEST_SYSTEM + (this.isHaiku && !this.thinking ? NO_THINKING_RULE : '')) + this.context
    const first = !this.systemSent
    this.systemSent = true
    // Порядок: системный промпт, картинки, вопрос. Вопрос ссылается на снимки «выше» — если они
    // стоят перед системным промптом, слабая модель отвечает на промпт и не замечает картинок
    // (замер 13 сентября, Haiku 4.5, серия из двух снимков первым сообщением сессии).
    const content = [
      ...(first && images.length ? [{ type: 'text', text: system }] : []),
      ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
      { type: 'text', text: first && !images.length ? `${system}\n\n${text}` : text },
    ]
    this.proc?.stdin?.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n',
    )
  }

  private enqueue(q: Question, p: Pending): void {
    this.ensure()
    if (this.current) {
      this.queue.push({ q, p })
      return
    }
    this.current = p
    this.acc = ''
    this.write(q)
    p.onStart?.()
  }

  ask(text: string, onDelta: (chunk: string) => void, opts: AskOptions = {}): Promise<string> {
    const { silenceSec, silenceMessage, images, ...rest } = opts
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const p: Pending = {
        ...rest,
        onDelta,
        limited: !!silenceSec,
        resolve: (t) => {
          clearTimeout(timer)
          resolve(t)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      // Таймаут по тишине, а не по общему времени. Общий обрывал живой ответ,
      // который печатался дольше лимита, и хвост дописывался после текста ошибки.
      if (silenceSec) {
        const arm = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            // Ждущий очереди не решает за идущий вопрос со своим лимитом: у того свой таймер.
            // Иначе короткий лимит ожидающего обрывал бы долгий веб-поиск текущего.
            if (this.current && this.current !== p && this.current.limited) return arm()
            this.hang(p, new Error(silenceMessage ?? `Claude Code молчит дольше ${silenceSec} с`))
          }, silenceSec * 1000)
        }
        p.onActivity = arm
        arm()
      }
      this.enqueue({ text, images }, p)
    })
  }

  /**
   * Сессия молчит дольше лимита. Молчание общее на сессию, значит завис вопрос,
   * который сейчас в работе: гасим процесс и отклоняем только его, а очередь
   * уходит в новую сессию. Раньше таймаут гасил всё сразу, и соседний вопрос
   * падал с чужой ошибкой.
   */
  private hang(p: Pending, err: Error): void {
    const stuck = this.current
    if (!stuck) return
    this.current = null
    this.kill()
    stuck.reject(stuck === p ? err : new Error('Сессия Claude Code зависла и перезапущена'))
    // Очередь переходит в новую сессию — отсчёт тишины у всех ожидающих начинается
    // заново. Их таймеры заведены тем же событием, что и у зависшего, и без этого
    // срабатывали следом, гася только что поднятый процесс.
    for (const w of this.queue) w.p.onActivity?.()
    this.drain()
  }

  /** Погасить сессию. reason — чем отклонить вопросы: отмену стоит отличать от сбоя. */
  stop(reason?: Error): void {
    const done = this.current
    const waiting = this.queue.splice(0)
    this.current = null
    this.restartPending = false
    this.kill()
    // Ожидающие вопросы отклоняем сразу. Раньше они молча терялись и висели до
    // таймаута — полминуты ожидания ответа, который уже никто не пишет.
    const err = reason ?? new Error('Сессия Claude Code перезапущена')
    done?.reject(err)
    for (const w of waiting) w.p.reject(err)
  }

  /** Убрать процесс, не трогая вопросы. */
  private kill(): void {
    const proc = this.proc
    this.proc = null
    this.systemSent = false
    if (!proc) return
    try {
      proc.stdin?.end()
      // `claude` запущен через оболочку. На Windows kill() гасит только cmd.exe,
      // а сам CLI остаётся жить и копится с каждым перезапуском — гасим всё дерево.
      if (process.platform === 'win32' && proc.pid) {
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
      } else {
        proc.kill()
      }
    } catch {
      /* уже завершился */
    }
  }
}
