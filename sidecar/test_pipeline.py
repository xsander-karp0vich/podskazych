"""
Диагностика канала them по шагам:
  1) доходят ли чанки из LoopbackCapture
  2) какой у них уровень (и проходят ли порог VAD)
  3) распознаётся ли накопленное Whisper-ом
"""
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from audio_loopback import LoopbackCapture  # noqa: E402

SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 12.0
VAD_RMS_DBFS = -45.0

chunks = []
levels = []


def on_audio(chunk: np.ndarray) -> None:
    chunks.append(chunk)
    r = float(np.sqrt(np.mean(np.square(chunk))))
    levels.append(20 * np.log10(r) if r > 0 else -100.0)


cap = LoopbackCapture(on_audio)
cap.start()
time.sleep(0.5)
print(f"устройство: {cap.device_name}  ошибка: {cap.error}")

time.sleep(SECONDS)
cap.stop()

if not chunks:
    print("ЧАНКИ НЕ ПРИШЛИ ВООБЩЕ — поток захвата не отдаёт данные")
    raise SystemExit(1)

audio = np.concatenate(chunks)
lv = np.array(levels)
above = int((lv > VAD_RMS_DBFS).sum())

print(f"чанков: {len(chunks)}  сэмплов: {audio.size}  = {audio.size / 16000:.1f} с аудио")
print(f"размер чанка: {chunks[0].size} сэмплов ({chunks[0].size / 16000 * 1000:.0f} мс)")
print(f"уровень: средний {lv.mean():.1f} dBFS, максимум {lv.max():.1f} dBFS")
print(f"чанков громче порога {VAD_RMS_DBFS} dBFS: {above} из {len(lv)} ({100 * above / len(lv):.0f}%)")

if audio.size < 16000:
    print("аудио слишком мало для распознавания")
    raise SystemExit(1)

print("\nраспознаю накопленное...")
from faster_whisper import WhisperModel  # noqa: E402

model = WhisperModel(str(Path(__file__).parent / "models" / "whisper-large-v3-turbo"),
                     device="cuda", compute_type="int8_float16")
t = time.time()
segments, info = model.transcribe(audio, language="ru", beam_size=1, vad_filter=True,
                                  condition_on_previous_text=False, temperature=0.0)
text = " ".join(s.text.strip() for s in segments).strip()
dt = time.time() - t
print(f"за {dt:.2f} с (x{audio.size / 16000 / dt:.0f} realtime)")
print(f"РАСПОЗНАНО: {text!r}" if text else "РАСПОЗНАНО: <пусто>")
