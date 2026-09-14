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

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private src: MediaStreamAudioSourceNode | null = null

  constructor(private readonly onPcm: PcmHandler) {}

  async start(deviceId?: string): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
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

    // sampleRate в конструкторе: ресемпл делает встроенный ресемплер Chromium,
    // а не самодельное усреднение, которое даёт алиасинг и роняет качество.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    this.ctx = ctx

    // Путь относительный: в собранном приложении страница грузится по file://,
    // и абсолютный '/pcm-worklet.js' уехал бы в корень диска.
    await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', window.location.href).href)

    this.src = ctx.createMediaStreamSource(this.stream)
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

  async stop(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    this.src?.disconnect()
    this.src = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.ctx) {
      await this.ctx.close()
      this.ctx = null
    }
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
