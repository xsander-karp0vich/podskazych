"""Проверка podskazych-vk.exe на раннере GitHub без видеокарты.

Модели и GPU здесь нет, поэтому проверяется то, что ломается на чистой машине: exe
запускается без VC++ redist и без DLL рядом, отвечает hello, не падает на мусоре во
входе, вычитывает байты звука даже при отказе (иначе протокол рассинхронизируется),
принимает кириллический путь по трубе, выходит по quit и сам завершается, когда убит
родитель. Только стандартная библиотека Python.

    python ci_smoke.py path\\to\\podskazych-vk.exe
"""

import ctypes
import json
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time

MAX_SAMPLES = 30 * 16000 * 2


class Helper:
    def __init__(self, exe, args=None, env=None):
        self.proc = subprocess.Popen(
            [exe] + (args if args is not None else ["--parent-pid", str(os.getpid())]),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.lines = queue.Queue()
        self.stderr = bytearray()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        # stderr обязательно вычитывать: заполненная труба остановит помощника на записи лога
        self.err_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.err_thread.start()

    def _read_stdout(self):
        for raw in self.proc.stdout:
            self.lines.put(raw)
        self.lines.put(None)

    def _read_stderr(self):
        while True:
            chunk = self.proc.stderr.read1(65536) if hasattr(self.proc.stderr, "read1") else self.proc.stderr.read(4096)
            if not chunk:
                return
            self.stderr += chunk

    def send(self, obj_or_bytes, payload=b""):
        data = obj_or_bytes if isinstance(obj_or_bytes, bytes) else json.dumps(obj_or_bytes, ensure_ascii=False).encode("utf-8")
        self.proc.stdin.write(data + b"\n" + payload)
        self.proc.stdin.flush()

    def recv(self, timeout=60):
        raw = self.lines.get(timeout=timeout)
        if raw is None:
            raise AssertionError("stdout закрыт раньше ответа")
        # каждая строка stdout обязана быть JSON-объектом протокола
        msg = json.loads(raw.decode("utf-8"))
        assert isinstance(msg, dict) and "type" in msg, raw
        return msg


def check(cond, what):
    if not cond:
        raise AssertionError(what)
    print("  ok:", what)


DETAIL_INTS = ("vendorId", "deviceId", "driverId", "driverVersionRaw")
DETAIL_STRS = ("driverName", "driverInfo", "driverVersion", "apiVersion", "architecture")
DETAIL_BOOLS = ("uma", "coopmat", "coopmat2", "integerDotProduct", "fp16")
ARCHITECTURES = {"amd-gcn", "amd-rdna1", "amd-rdna2", "amd-rdna3", "intel-xe1", "intel-xe2",
                 "nvidia-pre-turing", "nvidia-turing", "other"}


def check_device(dev):
    """Схема устройства в hello: подробности — все поля или ни одного. Возвращает, есть ли они."""
    tag = f"устройство {dev.get('index')}"
    check(type(dev.get("index")) is int and isinstance(dev.get("name"), str), f"{tag}: index и name")
    check(dev.get("type") in ("discrete", "integrated", "other"), f"{tag}: type")
    keys = DETAIL_INTS + DETAIL_STRS + DETAIL_BOOLS
    present = [k for k in keys if k in dev]
    check(not present or len(present) == len(keys), f"{tag}: подробности все или ни одной ({present})")
    if not present:
        return False
    # bool в Python — подкласс int, поэтому сравнение типов строгое
    check(all(type(dev[k]) is int and 0 <= dev[k] <= 0xFFFFFFFF for k in DETAIL_INTS), f"{tag}: целые поля")
    check(all(type(dev[k]) is str for k in DETAIL_STRS), f"{tag}: строковые поля")
    check(all(type(dev[k]) is bool for k in DETAIL_BOOLS), f"{tag}: логические поля")
    check(dev["architecture"] in ARCHITECTURES, f"{tag}: architecture из известного списка")
    check(dev["apiVersion"].count(".") == 2 and all(p.isdigit() for p in dev["apiVersion"].split(".")), f"{tag}: apiVersion x.y.z")
    if dev["type"] in ("discrete", "integrated"):
        check(dev["uma"] == (dev["type"] == "integrated"), f"{tag}: uma согласовано с type")
    return True


def expect_error(h, code=None, id_=None, timeout=60):
    msg = h.recv(timeout)
    check(msg["type"] == "error", f"ошибка в ответ ({msg})")
    if code is not None:
        check(msg.get("code") == code, f"code={code} ({msg.get('message')})")
    if id_ is not None:
        check(msg.get("id") == id_, f"id={id_}")
    return msg


class ProcHandle:
    """Дескриптор процесса по PID, открытый заранее: после выхода по нему читается код
    завершения, и переиспользованный PID не спутается с помощником."""

    def __init__(self, pid):
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k32.OpenProcess.restype = ctypes.c_void_p
        # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        self.h = self.k32.OpenProcess(0x00100000 | 0x1000, False, pid)
        if not self.h:
            raise OSError(f"OpenProcess({pid}): ошибка {ctypes.get_last_error()}")

    def wait(self, timeout_s):
        return self.k32.WaitForSingleObject(ctypes.c_void_p(self.h), int(timeout_s * 1000)) == 0

    def exit_code(self):
        code = ctypes.c_ulong()
        if not self.k32.GetExitCodeProcess(ctypes.c_void_p(self.h), ctypes.byref(code)):
            return None
        return None if code.value == 259 else code.value  # STILL_ACTIVE

    def close(self):
        self.k32.CloseHandle(ctypes.c_void_p(self.h))


def wait_stderr(h, needle, timeout_s=10):
    """stderr читается отдельным потоком: строка, записанная до hello, могла ещё не дойти."""
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        text = h.stderr.decode("utf-8", "replace")
        if needle in text:
            return text
        time.sleep(0.05)
    return h.stderr.decode("utf-8", "replace")


def check_details_switches(exe, h, hello):
    """Только на машине с видеокартой (на раннере устройств нет, а Mock ICD в Windows-SDK
    не входит): подробности сверены со строкой ggml, а выключатели GGML_VK_DISABLE_* меняют
    флаги, но не вендора, драйвер и поколение."""
    detailed = [d for d in hello["devices"] if check_device(d)]
    if not detailed:
        print("  устройств с подробностями нет, проверка выключателей пропущена")
        return
    err = wait_stderr(h, "сверка с ggml")
    check("сверка с ggml: совпало" in err and "расхождение" not in err, "подробности совпали со строкой ggml")
    env = dict(os.environ, GGML_VK_DISABLE_COOPMAT="1", GGML_VK_DISABLE_COOPMAT2="1",
               GGML_VK_DISABLE_INTEGER_DOT_PRODUCT="1", GGML_VK_DISABLE_F16="1")
    ho = Helper(exe, env=env)
    off = {d["index"]: d for d in ho.recv(timeout=180)["devices"]}
    for d in detailed:
        o = off.get(d["index"], {})
        print("  с GGML_VK_DISABLE_*:", json.dumps(o, ensure_ascii=False))
        check(check_device(o), f"устройство {d['index']}: подробности и с выключателями")
        same = ("vendorId", "deviceId", "driverId", "driverVersionRaw", "driverInfo", "architecture", "uma")
        check(all(o[k] == d[k] for k in same), f"устройство {d['index']}: вендор, драйвер и поколение те же")
        check(not (o["coopmat"] or o["coopmat2"] or o["integerDotProduct"] or o["fp16"]),
              f"устройство {d['index']}: GGML_VK_DISABLE_* выключают флаги")
    err = wait_stderr(ho, "сверка с ggml")
    check("расхождение" not in err, "с выключателями подробности совпали со строкой ggml")
    ho.send({"type": "quit"})
    check(ho.proc.wait(timeout=60) == 0, "с выключателями: quit -> код 0")


def main():
    # консоль раннера в cp1252: без этого первый же русский print падает
    sys.stdout.reconfigure(encoding="utf-8")
    exe = os.path.abspath(sys.argv[1])
    print("exe:", exe, os.path.getsize(exe), "байт")

    # --- неизвестный аргумент: отказ с кодом 2, без зависания ---
    p = subprocess.run([exe, "--model", "x"], stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    check(p.returncode == 2, f"неизвестный аргумент -> код 2 (получен {p.returncode})")
    check(p.stdout == b"", "при отказе в stdout ничего")

    h = Helper(exe)
    t0 = time.monotonic()
    hello = h.recv(timeout=180)
    print("  hello:", json.dumps(hello, ensure_ascii=False), f"({time.monotonic() - t0:.1f} с)")
    check(hello["type"] == "hello", "первая строка — hello")
    check(hello["version"] == "1.9.4", "whisper_version() == 1.9.4")
    check(isinstance(hello["devices"], list), "devices — список")
    check(hello["cpuOk"] is True, "процессор раннера поддерживает AVX2")
    no_gpu = len(hello["devices"]) == 0
    if not no_gpu:
        print("  внимание: на раннере нашлись устройства Vulkan, проверка no-device пропускается")
    check_details_switches(exe, h, hello)

    def in_sync(tag):
        # Следующий ответ обязан быть ошибкой именно на этот запрос: лишних ответов нет.
        h.send({"type": "sentinel-" + tag})
        msg = expect_error(h, "bad-json")
        check("sentinel-" + tag in msg.get("message", ""), f"поток в порядке после «{tag}»")

    # --- корректный JSON с незнакомыми полями и неизвестный type: ошибка, работа дальше ---
    h.send({"type": "nope"})
    expect_error(h, "bad-json")
    h.send(b'{"type":"nope2","x":-1.5e-3,"big":99999999999999999999,"o":{"a":[1,{"b":null}],"c":"d"},'
           b'"arr":[1,"a",2.0,[]],"t":true,"id":3}')
    msg = expect_error(h, "bad-json", 3)
    check("nope2" in msg["message"], "незнакомые поля всех типов не мешают разбору")
    h.send(b'{"type":1,"id":4}')
    expect_error(h, "bad-json", 4)
    in_sync("types")
    # неизвестный type со звуком: байты пропущены по samples
    h.send({"type": "future", "id": 5, "samples": 400}, b"\n{}\n" * 400)
    expect_error(h, "bad-json", 5)
    in_sync("future")

    # --- transcribe до load: звук вычитан, ответ с id, поток не сломан ---
    pcm = struct.pack("<1600f", *([0.0] * 1600))
    h.send({"type": "transcribe", "id": 7, "samples": 1600, "language": "ru"}, pcm)
    expect_error(h, None, 7)
    # дробное незнакомое поле в заголовке и 0x0A в звуке: ровно один ответ
    h.send(b'{"type":"transcribe","id":6,"samples":1000,"temperature":0.0,"opts":{"beam":[5]}}',
           (b"\n" * 7 + b"{") * 500)
    expect_error(h, None, 6)
    in_sync("float-field")
    h.send({"type": "transcribe", "id": 10, "samples": 0, "language": "ru"})
    expect_error(h, None, 10)
    in_sync("samples0")
    # в звуке байт '\n' и фигурные скобки — они не должны разобраться как заголовок
    tricky = (b"\n{}\n" * 400)
    h.send({"type": "transcribe", "id": 8, "samples": len(tricky) // 4}, tricky)
    expect_error(h, None, 8)
    # слишком длинный фрагмент: отказ, но байты вычитаны
    big = MAX_SAMPLES + 1
    h.send({"type": "transcribe", "id": 9, "samples": big}, bytes(big * 4))
    expect_error(h, None, 9)

    # --- кириллические пути по трубе (UTF-8 и \\u-escape) ---
    tmp = tempfile.mkdtemp(prefix="пдскз-")
    missing = os.path.join(tmp, "нет такой модели.bin")
    h.send({"type": "load", "model": missing, "device": -1, "flashAttn": True, "threads": 2})
    expect_error(h, "bad-model")

    wrong = os.path.join(tmp, "не модель.bin")
    with open(wrong, "wb") as f:
        f.write(b"RIFF" + bytes(64))
    h.send(json.dumps({"type": "load", "model": wrong}, ensure_ascii=True).encode("ascii"))
    expect_error(h, "bad-model")

    fake = os.path.join(tmp, "модель ggml.bin")
    with open(fake, "wb") as f:
        f.write(struct.pack("<I", 0x67676D6C) + bytes(64))
    h.send({"type": "load", "model": fake, "flashAttn": False})
    if no_gpu:
        # файл открылся по кириллическому пути (дошли до проверки устройств)
        expect_error(h, "no-device")
    else:
        h.recv(timeout=300)

    # --- quit: чистый выход, в stdout больше ничего ---
    h.send({"type": "quit"})
    code = h.proc.wait(timeout=60)
    check(code == 0, f"quit -> код 0 (получен {code})")
    check(h.lines.get(timeout=10) is None, "после quit в stdout ничего")

    # --- EOF на stdin -> выход ---
    h2 = Helper(exe)
    h2.recv(timeout=180)
    h2.proc.stdin.close()
    check(h2.proc.wait(timeout=60) == 0, "EOF на stdin -> выход с кодом 0")

    # --- граница сообщения неизвестна: одна ошибка и код 6, а не поток ответов на звук ---
    deep = b'{"type":"x","a":' + b"[" * 40 + b"]" * 40 + b"}"
    desync_cases = [
        ("не JSON", b"{bad json", b"", "bad-json", None),
        ("повтор ключа", b'{"type":"load","model":"a","model":"b"}', b"", "bad-json", None),
        ("строка 70 КБ", b"x" * (70 * 1024), b"", "bad-json", None),
        ("вложенность 40", deep, b"", "bad-json", None),
        ("samples дробное", b'{"type":"transcribe","id":1,"samples":1.5}', b"\n" * 6, None, 1),
        ("samples строкой", b'{"type":"transcribe","id":2,"samples":"1600"}', b"\n" * 64, None, 2),
        ("samples нет", b'{"type":"transcribe","id":3}', b"\n{}" * 100, None, 3),
        ("samples < 0", b'{"type":"transcribe","id":4,"samples":-4}', b"", None, 4),
        # 2^62+1: samples*4 переполнил бы uint64 и пропустил бы 4 байта вместо 2^64
        ("samples 2^62+1", b'{"type":"transcribe","id":15,"samples":4611686018427387905}', b"ABCD", None, 15),
        ("samples у load дробное", b'{"type":"load","id":5,"samples":2.5}', b"", None, 5),
    ]
    for name, header, payload, code, id_ in desync_cases:
        hd = Helper(exe)
        hd.recv(timeout=180)
        try:
            hd.send(header, payload)
        except OSError:
            pass  # помощник мог выйти раньше, чем дописан хвост
        expect_error(hd, code, id_)
        rc = hd.proc.wait(timeout=60)
        check(rc == 6, f"{name}: код выхода 6 (получен {rc})")
        check(hd.lines.get(timeout=10) is None, f"{name}: больше ответов нет")

    # --- родитель убит -> помощник выходит сам ---
    # Пишущий конец stdin помощника держим здесь, а не в убиваемом родителе: иначе
    # помощник вышел бы по EOF и наблюдение за PID осталось бы непроверенным.
    import msvcrt
    r, w = os.pipe()
    rh = msvcrt.get_osfhandle(r)
    os.set_handle_inheritable(rh, True)
    launcher = (
        "import msvcrt, subprocess, sys, os, time\n"
        "fd = msvcrt.open_osfhandle(int(sys.argv[2]), os.O_RDONLY)\n"
        "p = subprocess.Popen([sys.argv[1], '--parent-pid', str(os.getpid())],"
        " stdin=fd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)\n"
        "os.close(fd)\n"
        "p.stdout.readline()\n"
        "print(p.pid, flush=True)\n"
        "time.sleep(600)\n"
    )
    parent = subprocess.Popen([sys.executable, "-c", launcher, exe, str(rh)], stdout=subprocess.PIPE, close_fds=False)
    os.close(r)
    helper_pid = int(parent.stdout.readline().strip())
    ph = ProcHandle(helper_pid)
    check(not ph.wait(0.5), "помощник жив, пока жив родитель")
    t_kill = time.monotonic()
    parent.kill()  # TerminateProcess, как у Electron
    parent.wait()
    exited = ph.wait(10)
    dt = time.monotonic() - t_kill
    code = ph.exit_code()
    ph.close()
    check(exited and dt < 5, f"помощник вышел после смерти родителя ({dt:.2f} с)")
    check(code == 5, f"код выхода после смерти родителя 5 (получен {code})")
    os.close(w)

    # --- PID родителя, которого уже нет: сразу код 5 ---
    # stdin — труба, которую держим открытой: выйти по EOF с кодом 0 помощник не может.
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    q = subprocess.Popen([exe, "--parent-pid", str(gone.pid)], stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        code = q.wait(timeout=60)
    except subprocess.TimeoutExpired:
        q.kill()
        code = None
    q.stdin.close()
    check(code == 5, f"завершившийся родитель -> код 5 (получен {code})")

    print("stderr помощника (хвост):")
    print(h.stderr.decode("utf-8", "replace")[-3000:])
    print("SMOKE OK")


if __name__ == "__main__":
    main()
