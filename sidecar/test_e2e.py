"""
Сквозной тест: поднимает asr.py, подключается как клиент канала them
и печатает всё, что придёт. Системный звук сайдкар берёт сам.

Запускать вместе с играющим звуком (синтезатор речи или что угодно).
"""
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import websockets

HERE = Path(__file__).parent
PY = HERE / ".venv" / "Scripts" / "python.exe"
MODEL = HERE / "models" / "whisper-large-v3-turbo"
PORT = 46123
TOKEN = "e2e-test-token"
LISTEN_SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 40.0


async def main() -> None:
    proc = subprocess.Popen(
        [str(PY), str(HERE / "asr.py"),
         "--port", str(PORT), "--token", TOKEN,
         "--model", str(MODEL), "--language", "ru"],
        cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )

    # Пайпы надо разгребать ВСЁ время жизни процесса. Если перестать читать,
    # буфер трубы заполняется и дочерний процесс встаёт на записи — выглядит
    # это как «сайдкар молчит», хотя он просто заблокирован.
    import threading
    err_tail: list[str] = []

    def drain_stderr() -> None:
        for line in proc.stderr:
            err_tail.append(line)
            del err_tail[:-40]

    threading.Thread(target=drain_stderr, daemon=True).start()

    ready = None
    t0 = time.time()
    while time.time() - t0 < 120:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                print("СAЙДКАР УПАЛ:")
                print((proc.stderr.read() or "")[-2000:])
                return
            continue
        line = line.strip()
        if '"ready"' in line:
            ready = json.loads(line)
            break
    if ready is None:
        print("не дождались ready")
        proc.kill()
        return

    print("ready:", json.dumps(ready, ensure_ascii=False))
    if ready.get("loopbackError"):
        print("ОШИБКА ЗАХВАТА:", ready["loopbackError"])

    # stdout тоже надо продолжать читать — сайдкар пишет туда ошибки конвейера.
    def drain_stdout() -> None:
        for line in proc.stdout:
            s = line.strip()
            if s:
                print("[сайдкар]", s, flush=True)

    threading.Thread(target=drain_stdout, daemon=True).start()

    url = f"ws://127.0.0.1:{PORT}/?ch=them&token={TOKEN}"
    got = 0
    try:
        async with websockets.connect(url) as ws:
            print(f"подключился, слушаю {LISTEN_SECONDS:.0f} с...")
            end = time.time() + LISTEN_SECONDS
            while time.time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0.5, end - time.time()))
                except asyncio.TimeoutError:
                    break
                msg = json.loads(raw)
                got += 1
                mark = "ФИНАЛ  " if msg["type"] == "final" else "черновик"
                print(f"[{mark}] {msg['text']}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print(f"\nвсего сообщений: {got}")
    if got == 0:
        print("ничего не пришло — либо тишина, либо канал не работает")


if __name__ == "__main__":
    asyncio.run(main())
