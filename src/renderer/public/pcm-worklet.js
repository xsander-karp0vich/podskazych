/**
 * Float32 -> PCM16 LE, накопление ровными чанками.
 *
 * Ресемпл 48k->16k мы НЕ делаем руками: AudioContext создаётся сразу с
 * sampleRate:16000, и Chromium прогоняет поток через свой качественный
 * ресемплер. Самодельное усреднение трёх сэмплов даёт алиасинг и роняет WER.
 *
 * Квант AudioWorklet — всегда 128 сэмплов. При 16 кГц это 8 мс,
 * поэтому чанк в 50 мс = 800 сэмплов набирается за 6.25 квантов.
 */
const CHUNK_SAMPLES = 800 // 50 мс при 16 кГц

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Int16Array(CHUNK_SAMPLES)
    this._filled = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const ch = input[0]
    if (!ch) return true

    for (let i = 0; i < ch.length; i++) {
      // clamp перед масштабированием: значения вне [-1,1] дают wrap-around
      const s = Math.max(-1, Math.min(1, ch[i]))
      this._buf[this._filled++] = s < 0 ? s * 0x8000 : s * 0x7fff

      if (this._filled === CHUNK_SAMPLES) {
        // transfer, а не copy — буфер уезжает в главный поток без аллокации
        const out = this._buf.buffer
        this.port.postMessage(out, [out])
        this._buf = new Int16Array(CHUNK_SAMPLES)
        this._filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
