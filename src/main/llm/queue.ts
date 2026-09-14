import { LlmError, SkippedError, type AskOptions, type ProviderId, type TurnHandlers } from './types.ts'

/**
 * Очередь вопросов к одной живой сессии модели — общая для всех транспортов.
 *
 * Логика перенесена из ClaudeCodeSuggester (claudeCode.ts) один в один, со всеми
 * граблями, на которые там уже наступили: таймаут по тишине, а не по общему
 * времени; зависание гасит только вопрос в работе; устаревший вопрос не уходит в
 * модель; перезапуск ради новых настроек ждёт конца идущего ответа. Сам Claude Code
 * пока живёт на своей копии этой логики: перевод его на очередь — отдельный шаг с
 * замерами, поведение подсказок Claude менять нельзя.
 *
 * ── API ─────────────────────────────────────────────────────────────────────
 *
 *   const q = new TurnQueue<Q>({ provider, label, transport })
 *
 * Q — что транспорт отправляет в модель (например, { text, images }).
 * label — имя программы в текстах ошибок: «Codex CLI молчит дольше 45 с».
 *
 * transport — три операции, их зовёт очередь:
 *   ensure()  поднять процесс/сессию, если не жив. Зовётся перед каждой отправкой.
 *             Синхронный: долгий старт (initialize, thread/start) транспорт прячет
 *             внутрь send — тот может вернуть промис.
 *   send(q)   отправить вопрос в модель. throw или отклонённый промис — вопрос падает
 *             с этой ошибкой, очередь идёт дальше.
 *   kill()    погасить процесс немедленно, не трогая вопросы. Транспорт обязан после
 *             этого игнорировать события старого процесса (сверять процесс/turnId).
 *
 * Вызовы для сессии (LlmSession):
 *   q.ask(question, handlers, { silenceSec, silenceMessage }) → Promise<string>
 *   q.warmup(prime, isWarm)   прогрев вопросом prime; повторные вызовы не множат прогревы
 *   q.reconfigure(differs)    настройки поменялись; differs — процесс жив и запущен
 *                             с другими флагами. Перезапуск сразу или после ответа.
 *   q.stop(reason?)           отклонить всё и погасить процесс
 *   q.busy                    идёт ответ
 *   q.restartPending          ждёт перезапуск после ответа
 *
 * События от транспорта (он разбирает вывод CLI и сообщает очереди):
 *   q.activity()      любая строка от процесса — признак жизни, перезаводит таймеры тишины
 *                     у вопроса в работе и у всех в очереди. Звать на КАЖДОЕ событие.
 *   q.delta(text)     кусок ответа
 *   q.blockBreak()    новый текстовый блок после уже написанного: вставит «\n\n»
 *   q.thinking()      модель размышляет
 *   q.tool(name)      модель вызвала инструмент
 *   q.finish(text?)   ответ готов; text — запасной, если дельт не было
 *   q.failTurn(err)   ответ не удался, процесс жив: отклонить только текущий вопрос
 *   q.failAll(err)    процесс умер: отклонить текущий и всю очередь
 *   q.processStarted() транспорт поднял новый процесс — отложенный перезапуск больше не нужен
 *   q.text            что уже написано в текущем ответе
 */

export interface QueueTransport<Q> {
  ensure(): void
  send(q: Q): void | Promise<void>
  kill(): void
}

interface Pending {
  resolve: (text: string) => void
  reject: (e: Error) => void
  onDelta: (chunk: string) => void
  onThinking?: () => void
  onTool?: (name: string) => void
  onStart?: () => void
  isStale?: () => boolean
  /** Любое событие сессии, пока вопрос в работе или ждёт очереди: по нему считается таймаут. */
  onActivity?: () => void
  /** У вопроса свой лимит тишины: пока он в работе, решает его таймер. */
  limited?: boolean
}

export interface TurnQueueOptions<Q> {
  provider: ProviderId
  /** имя программы в текстах ошибок: «Codex CLI» */
  label: string
  transport: QueueTransport<Q>
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

export class TurnQueue<Q> {
  private readonly provider: ProviderId
  private readonly label: string
  private readonly t: QueueTransport<Q>
  private current: Pending | null = null
  private queue: Array<{ q: Q; p: Pending }> = []
  private acc = ''
  private pendingRestart = false
  /** Прогрев в очереди или в работе; started — он уже идёт в текущем процессе. */
  private priming: { done: Promise<void>; started: boolean } | null = null

  constructor(opts: TurnQueueOptions<Q>) {
    this.provider = opts.provider
    this.label = opts.label
    this.t = opts.transport
  }

  get busy(): boolean {
    return this.current !== null
  }

  get restartPending(): boolean {
    return this.pendingRestart
  }

  get text(): string {
    return this.acc
  }

  /* ---------- вызовы сессии ---------- */

  ask(q: Q, h: TurnHandlers, o: AskOptions = {}): Promise<string> {
    const { silenceSec, silenceMessage } = o
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const p: Pending = {
        onDelta: (t) => h.onDelta(t),
        onThinking: h.onThinking && (() => h.onThinking!()),
        onTool: h.onTool && ((name) => h.onTool!(name)),
        onStart: h.onStart && (() => h.onStart!()),
        isStale: h.isStale && (() => h.isStale!()),
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
            this.hang(p, new LlmError('timeout', this.provider, silenceMessage ?? `${this.label} молчит дольше ${silenceSec} с`))
          }, silenceSec * 1000)
        }
        p.onActivity = arm
        arm()
      }
      this.enqueue(q, p)
    })
  }

  /**
   * Прогрев вопросом prime, ответ выбрасывается. isWarm — сессия уже поднята и прогрета
   * (у Claude Code: процесс жив и системный промпт отправлен).
   * Прогрев зовёт каждая смена настройки. Тот, что ждёт очереди, прогреет и
   * перезапущенную сессию — второй не нужен. А тот, что уже идёт в старом
   * процессе, новую сессию не прогреет: после перезапуска нужен ещё один.
   */
  async warmup(prime: Q, isWarm: () => boolean): Promise<void> {
    if (isWarm() && !this.pendingRestart) return
    const pending = this.priming
    if (pending && !(pending.started && this.pendingRestart)) return pending.done
    const entry = { done: Promise.resolve(), started: false }
    this.priming = entry
    entry.done = this.ask(prime, {
      onDelta: () => {},
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

  /**
   * Настройки сессии поменялись. differs — процесс жив и запущен с другими флагами.
   * Идущий ответ не обрываем, перезапуск ждёт его конца: раньше переключение режима
   * посреди ответа стирало уже напечатанный текст. Включили и тут же выключили —
   * отложенный перезапуск снимается.
   */
  reconfigure(differs: boolean): void {
    if (this.current) this.pendingRestart = differs
    else if (differs) this.stop()
  }

  /** Погасить сессию. reason — чем отклонить вопросы: отмену стоит отличать от сбоя. */
  stop(reason?: Error): void {
    const done = this.current
    const waiting = this.queue.splice(0)
    this.current = null
    this.pendingRestart = false
    this.t.kill()
    // Ожидающие вопросы отклоняем сразу, а не оставляем висеть до таймаута.
    const err = reason ?? new LlmError('unknown', this.provider, `Сессия ${this.label} перезапущена`)
    done?.reject(err)
    for (const w of waiting) w.p.reject(err)
  }

  /* ---------- события транспорта ---------- */

  processStarted(): void {
    this.pendingRestart = false
  }

  activity(): void {
    this.current?.onActivity?.()
    for (const w of this.queue) w.p.onActivity?.()
  }

  delta(text: string): void {
    if (!text || !this.current) return
    this.acc += text
    this.current.onDelta(text)
  }

  blockBreak(): void {
    if (!this.acc || !this.current) return
    this.acc += '\n\n'
    this.current.onDelta('\n\n')
  }

  thinking(): void {
    this.current?.onThinking?.()
  }

  tool(name: string): void {
    this.current?.onTool?.(name)
  }

  finish(fallback?: string): void {
    const done = this.current
    const text = this.acc.trim() || fallback || ''
    this.acc = ''
    this.current = null
    done?.resolve(text)
    this.drain()
  }

  failTurn(err: Error): void {
    const done = this.current
    this.acc = ''
    this.current = null
    done?.reject(err)
    this.drain()
  }

  failAll(err: Error): void {
    const done = this.current
    this.current = null
    this.acc = ''
    const waiting = this.queue.splice(0)
    this.pendingRestart = false
    done?.reject(err)
    for (const w of waiting) w.p.reject(err)
  }

  /* ---------- внутреннее ---------- */

  private enqueue(q: Q, p: Pending): void {
    this.t.ensure()
    if (this.current) {
      this.queue.push({ q, p })
      return
    }
    this.current = p
    this.acc = ''
    this.dispatch(q, p)
    if (this.current === p) p.onStart?.()
  }

  /** Следующий вопрос из очереди: сессия отвечает строго по одному. */
  private drain(): void {
    if (this.current) return
    // Настройки поменялись, пока шёл ответ: перезапускаем сейчас, между вопросами.
    if (this.pendingRestart) {
      this.pendingRestart = false
      this.t.kill()
    }
    let next = this.queue.shift()
    // Устаревший вопрос не держит очередь и не тратит лимиты.
    while (next?.p.isStale?.()) {
      next.p.reject(new SkippedError())
      next = this.queue.shift()
    }
    if (!next) return
    this.t.ensure()
    this.current = next.p
    this.acc = ''
    this.dispatch(next.q, next.p)
    if (this.current !== next.p) return
    // Отсчёт тишины — с момента, когда вопрос ушёл в модель, а не с последнего события очереди.
    next.p.onActivity?.()
    next.p.onStart?.()
  }

  private dispatch(q: Q, p: Pending): void {
    const failIfCurrent = (e: unknown) => {
      if (this.current === p) this.failTurn(toError(e))
    }
    try {
      const r = this.t.send(q)
      if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(undefined, failIfCurrent)
    } catch (e) {
      failIfCurrent(e)
    }
  }

  /**
   * Сессия молчит дольше лимита. Молчание общее на сессию, значит завис вопрос,
   * который сейчас в работе: гасим процесс и отклоняем только его, а очередь
   * уходит в новую сессию.
   */
  private hang(p: Pending, err: Error): void {
    const stuck = this.current
    if (!stuck) return
    this.current = null
    this.acc = ''
    this.t.kill()
    stuck.reject(stuck === p ? err : new LlmError('timeout', this.provider, `Сессия ${this.label} зависла и перезапущена`))
    // Очередь переходит в новую сессию — отсчёт тишины у всех ожидающих начинается заново.
    for (const w of this.queue) w.p.onActivity?.()
    this.drain()
  }
}
