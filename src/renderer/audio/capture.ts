/**
 * Захват микрофона в рендерере.
 *
 * Звук собеседника здесь НЕ берётся: getDisplayMedia с audio='loopback' на
 * Windows падает с NotReadableError даже при корректном источнике. Системный
 * звук захватывает Python-сайдкар напрямую через WASAPI — там это работает.
 */

/** Целевой формат для STT: PCM16 LE, 16 кГц, моно. */
export const SAMPLE_RATE = 16000

export type PcmHandler = (pcm: ArrayBuffer) => void

/**
 * Что случилось с захватом посреди сессии. restarted и resumed — захват сам
 * вернулся, это для лога; failed — вернуть не вышло, это надо показать.
 */
export interface MicEvent {
  kind: 'restarted' | 'resumed' | 'failed'
  message: string
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private src: MediaStreamAudioSourceNode | null = null
  /** какой микрофон выбран в настройках; undefined — системный по умолчанию */
  private wanted: string | undefined
  /** с какого микрофона пишем сейчас: выбранный мог пропасть, и мы ушли на системный */
  private using: string | undefined
  /** между start() и stop(): только тогда захват поднимаем заново сами */
  private active = false
  private restarting: Promise<void> | null = null

  constructor(
    private readonly onPcm: PcmHandler,
    private readonly onEvent?: (e: MicEvent) => void,
  ) {}

  async start(deviceId?: string): Promise<void> {
    this.wanted = deviceId
    this.active = true
    try {
      await this.open(deviceId)
    } catch (e) {
      this.active = false
      await this.teardown()
      throw e
    }
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
  }

  private async open(deviceId?: string): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          // Голос собеседника из динамиков не должен попадать в наш канал
          // и дублировать реплики.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
    } catch (e) {
      throw new Error(`Микрофон: ${describe(e)}`)
    }
    this.stream = stream
    this.using = deviceId
    // Гарнитуру выдернули, Bluetooth отвалился, драйвер забрал устройство —
    // трек кончается молча. Без перезапуска голос пропал бы до «Стоп/Старт»,
    // а волна «Я» замерла бы без единого слова об этом.
    for (const track of stream.getAudioTracks()) track.onended = () => void this.restart('микрофон отключился')

    // sampleRate в конструкторе: ресемпл делает встроенный ресемплер Chromium,
    // а не самодельное усреднение, которое даёт алиасинг и роняет качество.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    this.ctx = ctx
    // Windows приостанавливает звук при смене устройства вывода и после сна:
    // контекст встаёт, трек при этом жив, и ни один кадр больше не приходит.
    ctx.onstatechange = () => {
      if (this.ctx !== ctx || !this.active || ctx.state !== 'suspended') return
      ctx.resume().then(
        () => this.onEvent?.({ kind: 'resumed', message: 'захват микрофона был приостановлен и возобновлён' }),
        (e) => this.onEvent?.({ kind: 'failed', message: `Микрофон: ${describe(e)}` }),
      )
    }

    // Путь относительный: в собранном приложении страница грузится по file://,
    // и абсолютный '/pcm-worklet.js' уехал бы в корень диска.
    await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', window.location.href).href)

    this.src = ctx.createMediaStreamSource(stream)
    this.node = new AudioWorkletNode(ctx, 'pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onPcm(e.data)
    this.src.connect(this.node)
  }

  /**
   * Разобрать граф захвата. Обработчики снимаем первыми: закрытие контекста и
   * остановка трека — наши действия, а не пропажа устройства, перезапускать нечего.
   */
  private async teardown(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    this.src?.disconnect()
    this.src = null
    this.stream?.getTracks().forEach((t) => {
      t.onended = null
      t.stop()
    })
    this.stream = null
    const ctx = this.ctx
    this.ctx = null
    if (ctx) {
      ctx.onstatechange = null
      await ctx.close().catch(() => {})
    }
  }

  /** Поднять захват заново. Трек и devicechange часто приходят парой — перезапуск один. */
  private restart(reason: string): Promise<void> {
    if (!this.active) return Promise.resolve()
    this.restarting ??= this.reopen(reason).finally(() => {
      this.restarting = null
    })
    return this.restarting
  }

  private async reopen(reason: string): Promise<void> {
    await this.teardown()
    // Выбранный микрофон, если он ещё в системе; иначе системный по умолчанию:
    // exact на пропавшем устройстве дал бы OverconstrainedError, и голоса не было бы вовсе.
    let id = this.wanted
    if (id) {
      const mics = await listMicrophones().catch(() => [])
      if (!mics.some((d) => d.deviceId === id)) id = undefined
    }
    if (!this.active) return
    let failure: string | null = null
    try {
      await this.open(id)
    } catch (e) {
      failure = e instanceof Error ? e.message : describe(e)
      await this.teardown()
    }
    // Выбранное устройство уже в списке, но ещё не открывается: Bluetooth-гарнитура
    // сразу после подключения отдаёт NotReadableError. Старый захват к этому моменту
    // разобран, и без запасного пути голоса не было бы до следующего devicechange.
    // Пишем с системного, а к выбранному вернёмся, когда устройства снова поменяются.
    let fellBack = false
    if (failure !== null && id !== undefined && this.active) {
      try {
        await this.open(undefined)
        fellBack = true
        id = undefined
      } catch {
        await this.teardown()
      }
    }
    if (failure !== null && !fellBack) {
      if (this.active) this.onEvent?.({ kind: 'failed', message: failure })
      return
    }
    // Пока поднимали, сессию остановили — поднятое не нужно.
    if (!this.active) {
      await this.teardown()
      return
    }
    let where = id ? '' : ' на микрофоне по умолчанию'
    if (fellBack) where += `: выбранный не открылся (${failure})`
    this.onEvent?.({ kind: 'restarted', message: `${reason} — захват перезапущен${where}` })
  }

  private readonly onDeviceChange = (): void => {
    if (!this.active || this.restarting) return
    listMicrophones().then(
      (mics) => {
        if (!this.active || this.restarting) return
        const has = (id: string) => mics.some((d) => d.deviceId === id)
        // Прошлый перезапуск не удался — новое устройство может вернуть голос.
        if (!this.stream) void this.restart('появилось звуковое устройство')
        else if (this.using && !has(this.using)) void this.restart('выбранный микрофон отключён')
        // Выбранный в настройках вернулся, а пишем с системного, куда ушли без него.
        else if (this.wanted && this.using !== this.wanted && has(this.wanted))
          void this.restart('выбранный микрофон снова подключён')
      },
      () => {},
    )
  }

  async stop(): Promise<void> {
    this.active = false
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    await this.teardown()
  }

  get running(): boolean {
    return this.ctx !== null
  }
}

/** Список микрофонов для выпадающего списка. Метки видны только после доступа. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}
