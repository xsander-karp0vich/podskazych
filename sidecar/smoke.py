import time, sys, numpy as np
import ctranslate2
from faster_whisper import WhisperModel

print("ctranslate2:", ctranslate2.__version__)
print("cuda device count:", ctranslate2.get_cuda_device_count())
try:
    print("supported compute types (cuda):", ctranslate2.get_supported_compute_types("cuda"))
except Exception as e:
    print("compute types query failed:", e)

MODEL = sys.argv[1] if len(sys.argv) > 1 else "large-v3-turbo"
t0 = time.time()
m = WhisperModel(MODEL, device="cuda", compute_type="int8_float16")
print(f"model load: {time.time()-t0:.1f}s  ({MODEL})")

# 10 с сигнала: проверяем, что CUDA-ядра реально исполняются на sm_120
rng = np.random.default_rng(0)
audio = (rng.standard_normal(16000 * 10) * 0.02).astype(np.float32)

for i in range(3):
    t = time.time()
    segs, info = m.transcribe(audio, language="ru", beam_size=1, vad_filter=True,
                              condition_on_previous_text=False)
    txt = " ".join(s.text for s in segs)
    dt = time.time() - t
    print(f"run {i+1}: {dt:.3f}s  RTF={dt/10:.4f}  x{10/dt:.0f} realtime  text={txt[:60]!r}")
print("OK")
