"""
Проверка канала them напрямую: LoopbackCapture -> Pipeline -> вывод.
Без вебсокета и подпроцесса, чтобы отделить логику от транспорта.
"""
import asyncio
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

import asr  # noqa: E402
from audio_loopback import LoopbackCapture  # noqa: E402

SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
MODEL = Path(__file__).parent / "models" / "whisper-large-v3-turbo"

stats = {"chunks": 0, "fed": 0, "loud": 0, "emits": 0}


async def main() -> None:
    engine, _ = asr.select_engine("cuda", str(MODEL), "ru", "int8_float16", "", print)
    transcriber = asr.Transcriber(engine)
    loop = asyncio.get_running_loop()
    t0 = time.monotonic()

    async def emit(kind, channel, text, start_ms):
        stats["emits"] += 1
        mark = "ФИНАЛ   " if kind == "final" else "черновик"
        print(f"[{mark}] {text}", flush=True)

    pipe = asr.Pipeline("them", transcriber, emit, t0)
    q: asyncio.Queue = asyncio.Queue(maxsize=400)

    def push(chunk):
        stats["chunks"] += 1
        if asr.rms_dbfs(chunk) > asr.VAD_RMS_DBFS:
            stats["loud"] += 1
        if not q.full():
            q.put_nowait(chunk)

    cap = LoopbackCapture(lambda c: loop.call_soon_threadsafe(push, c))
    cap.start()
    await asyncio.sleep(0.6)
    print(f"устройство: {cap.device_name}  ошибка: {cap.error}", flush=True)

    async def drain():
        while True:
            chunk = await q.get()
            stats["fed"] += 1
            try:
                await pipe.feed(chunk)
            except Exception as e:
                print(f"ОШИБКА в feed: {type(e).__name__}: {e}", flush=True)
                raise

    task = asyncio.create_task(drain())
    await asyncio.sleep(SECONDS)
    task.cancel()
    cap.stop()

    print(f"\nчанков получено: {stats['chunks']}")
    print(f"из них громче порога: {stats['loud']}")
    print(f"скормлено в Pipeline: {stats['fed']}")
    print(f"сообщений выдано: {stats['emits']}")
    print(f"состояние: speaking={pipe.speaking} samples={pipe.samples} "
          f"({pipe.samples / 16000:.1f} c) silence_ms={pipe.silence_ms}")


if __name__ == "__main__":
    asyncio.run(main())
