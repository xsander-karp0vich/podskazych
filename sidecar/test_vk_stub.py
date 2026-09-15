"""
Заглушка помощника podskazych-vk.exe для test_vulkan.py: тот же протокол по
stdin/stdout (gpu/vk-helper/README.md), но без видеокарты и модели.

Поведение задаёт JSON-файл из переменной PODSKAZYCH_VK_STUB. Файл перечитывается
на каждом запросе, поэтому тест может посреди сессии сказать «падай» или «зависни».
Поля (все необязательны):
  devices, version, cpuOk, vulkanLoader  — что отдать в hello;
  lat: {"1"|"0": {"0"|"1024"|"1280": мс}} — задержка по flash attention и окну;
  long_mult    — во сколько раз дольше звук от 15 с;
  garbage      — "fa" | "all": мусор вместо текста встроенных фраз;
  text         — что отвечать на любой другой звук;
  load_error   — код ошибки на load;
  crash        — на transcribe выйти с кодом 7, как GGML_ABORT;
  crash_fa     — то же, но только при flash attention;
  hang         — на transcribe не отвечать;
  log          — куда дописывать запросы (JSON по строке, без звука).
"""
import json
import os
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
GARBAGE = "СКД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД, КД"


def cfg() -> dict:
    try:
        with open(os.environ["PODSKAZYCH_VK_STUB"], encoding="utf-8") as f:
            return json.load(f)
    except (KeyError, OSError, ValueError):
        return {}


def log(rec: dict) -> None:
    path = cfg().get("log")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"pid": os.getpid(), **rec}, ensure_ascii=False) + "\n")


def selftest_texts() -> dict:
    """Число отсчётов встроенной фразы → её эталон: так заглушка «распознаёт» проверку."""
    refs = {}
    folder = os.path.join(HERE, "selftest")
    with open(os.path.join(folder, "phrases.tsv"), encoding="utf-8-sig") as f:
        for row in f:
            if "\t" in row:
                k, v = row.rstrip("\n").split("\t", 1)
                with wave.open(os.path.join(folder, f"{k}.wav"), "rb") as w:
                    refs[w.getnframes()] = v
    return refs


def main() -> int:
    out, inp = sys.stdout.buffer, sys.stdin.buffer

    def send(obj: dict) -> None:
        out.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
        out.flush()

    args = sys.argv[1:]
    parent = args[args.index("--parent-pid") + 1] if "--parent-pid" in args else None
    c = cfg()
    log({"type": "start", "parentPid": parent})
    sys.stderr.write("ggml_vulkan: Found 1 Vulkan devices (stub)\n")
    # whisper.cpp так печатает текст сегмента: в лог сайдкара это попасть не должно
    sys.stderr.write("[00:00:00.000 --> 00:00:01.000]  секретная речь\n")
    sys.stderr.flush()
    devices = c.get("devices") or [{"index": 0, "name": "Stub GPU", "type": "discrete", "vramMB": 8000, "freeMB": 7000}]
    send({"type": "hello", "version": c.get("version", "1.9.4"), "protocol": 1, "devices": devices,
          "cpuOk": c.get("cpuOk", True), "vulkanLoader": c.get("vulkanLoader", True)})
    refs = selftest_texts()
    fa = None
    while True:
        line = inp.readline()
        if not line:
            return 0
        if not line.strip():
            continue
        msg = json.loads(line)
        samples = int(msg.get("samples", 0))
        if samples:
            inp.read(samples * 4)
        c = cfg()
        kind = msg.get("type")
        if kind == "quit":
            log({"type": "quit"})
            return 0
        if kind == "load":
            log({"type": "load", "flashAttn": msg.get("flashAttn"), "device": msg.get("device"), "model": msg.get("model")})
            if c.get("load_error"):
                send({"type": "error", "code": c["load_error"], "message": "stub"})
                continue
            fa = bool(msg.get("flashAttn"))
            sys.stderr.write("whisper_model_load: loading model (stub)\n")
            sys.stderr.flush()
            send({"type": "loaded", "device": max(0, int(msg.get("device", 0))), "name": devices[0]["name"],
                  "deviceType": devices[0].get("type"), "flashAttn": fa, "ms": 1})
            continue
        if kind != "transcribe":
            send({"type": "error", "code": "bad-json", "message": "stub: unknown type"})
            continue
        ctx = int(msg.get("audioCtx", 0))
        log({"type": "transcribe", "samples": samples, "audioCtx": ctx, "promptTokens": len(msg.get("promptTokens") or []),
             "maxTokens": msg.get("maxTokens"), "flashAttn": fa})
        if fa is None:
            send({"type": "error", "id": msg.get("id"), "message": "no model"})
            continue
        if c.get("crash") or (c.get("crash_fa") and fa):
            sys.stderr.write("GGML_ASSERT(stub) failed\n")
            sys.stderr.flush()
            os._exit(7)
        if c.get("hang"):
            time.sleep(3600)
        lat = float(c.get("lat", {}).get("1" if fa else "0", {}).get(str(ctx), 5))
        if samples >= 15 * 16000:
            lat *= float(c.get("long_mult", 1.2))
        time.sleep(lat / 1000)
        garbage = c.get("garbage") == "all" or (c.get("garbage") == "fa" and fa)
        if samples in refs:
            text = GARBAGE if garbage else refs[samples]
        else:
            text = c.get("text", "раз два три")
        send({"type": "result", "id": msg["id"], "text": " " + text, "ms": int(lat)})


if __name__ == "__main__":
    sys.exit(main())
