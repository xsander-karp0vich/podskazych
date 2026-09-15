"""
Распознавание на видеокарте AMD/Intel через Vulkan.

Модель та же — whisper-large-v3-turbo, но в весах whisper.cpp (ggml q8_0) и в
отдельном процессе podskazych-vk.exe (gpu/vk-helper). Процесс отдельный, потому
что сбой драйвера (TDR, потеря устройства, abort в ggml) должен убить помощника,
а не сайдкар: сайдкар видит закрытую трубу и уходит на процессор посреди сессии.
Протокол и коды выхода — в README помощника.

Почему правила именно такие — замеры этапа 2 (gpu/bench/PHASE2.md), коротко:
  * q8_0 везде: q5_0 хуже на длинных репликах, а freeMB у помощника статичен
    и выбирать по нему нечего;
  * flash attention включён, кроме AMD на фирменном драйвере с GCN/RDNA1/RDNA2:
    там у ggml отдельный скалярный путь шейдеров с известными ошибками, а
    выигрыш от FA всего 15–20 %;
  * баг whisper.cpp 1.9.4: при FA хвост буфера до кратного 256 читается без маски
    и не чистится, поэтому текст зависит от audioCtx ПРОШЛЫХ запросов. С FA —
    только полное окно; без FA можно «лесенку» окон 1024/1280 (см. ladder_ctx);
  * подсказка — ровно производственная, те же номера токенов, что у CUDA;
  * выход режем лимитом токенов и степенью сжатия, дальше looks_like_noise.

Стоит ли видеокарта процессора, решает стартовая проверка (open_engine): модель
грузится, прогревается на встроенных фразах (selftest/), текст сверяется с
эталоном, время — с порогами уровней. Итог кэшируется по устройству, драйверу,
помощнику и модели: следующий старт проверяет только текст.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import queue
import re
import statistics
import subprocess
import sys
import threading
import time
import wave
from collections import deque
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher

import numpy as np

from engines import (
    COMPRESSION_RATIO_MAX,
    SAMPLE_RATE,
    Caps,
    EngineError,
    compression_ratio,
    cpu_threads,
    fit_hotwords,
)

HERE = os.path.dirname(os.path.abspath(__file__))
SELFTEST_DIR = os.path.join(HERE, "selftest")

# Меняется, когда меняются правила проверки: старые итоги в кэше не годятся.
GATE_VERSION = 1

# --- протокол помощника ---
HELLO_TIMEOUT_S = 30.0          # перечисление устройств — до пары секунд, с запасом на антивирус
GATE_TIMEOUT_S = 90.0           # загрузка и первый прогон: холодная сборка конвейеров Vulkan 5–8 с на 5060 Ti, у AMD не мерили
RUNTIME_TIMEOUT_S = 20.0        # дольше реплика не считается даже на iGPU: это зависание, а не медленная карта
# Вся проверка целиком. Приложение ждёт ready 3 минуты (sidecar.ts), а после
# проверки ещё может понадобиться CT2 на процессоре: зависание на каждом из
# десятка прогонов по 90 с съело бы этот срок, и сайдкар убили бы без причины.
GATE_TOTAL_S = 120.0
MAX_PROMPT_TOKENS = 223         # окно 224 минус <|startofprev|>
MAX_SAMPLES = 960_000           # 60 с — предел помощника
HELPER_THREADS = 2
EXIT_FATAL = 7
EXIT_NAMES = {0: "вышел штатно", 1: "исключение C++", 2: "неверные аргументы", 4: "закрыт stdout",
              5: "завершился родитель", 6: "рассинхронизация протокола", 7: "аварийная остановка ggml"}
# stderr помощника идёт в лог событиями. При загрузке это ~40 строк, дальше
# почти тишина; если драйвер начнёт сыпать предупреждениями на каждый прогон,
# лог сессии не должен из-за этого вырасти в сотни мегабайт.
STDERR_LINES_MAX = 300
STDERR_IMPORTANT = re.compile(r"error|fail|abort|assert|exception|lost|out of memory", re.I)
STDERR_LINE_CHARS = 400

# --- выход модели ---
# Лимит токенов на сегмент. Зацикливание на словаре без него крутится до 220
# токенов (0.5–1 с на медленной карте на КАЖДЫЙ кусок шума); самая плотная
# настоящая речь в замерах — 5.1 токена в секунду, 15 не режет ничего.
TOKENS_PER_S = 15
MIN_TOKENS = 24

# --- лесенка окон (только без flash attention) ---
# Окно кратно 256 кадрам: только такие не зависят от прошлых запросов даже при FA,
# а без FA — просто быстрее ровно подобранные буферы. 768 и меньше теряли фразы
# и пропускали повтор предложения, поэтому пол 1024 (20.48 с), потолок 1280 (25.6 с).
FRAMES_PER_S = 50
CTX_STEP = 256
LADDER_MIN_CTX = 1024
LADDER_MAX_CTX = 1280
LADDER_MARGIN_S = 3.0
# Реплика в режиме лесенки закрывается раньше, чтобы с запасом 3 с влезать в 25.6 с.
LADDER_MAX_UTTERANCE_MS = 22_000

# --- уровни ---
# FAST: CT2 CUDA на 5060 Ti — 177 мс на фразу и черновики раз в 700 мс работают;
# длинный буфер стоит в 1.5–2 раза дороже, поэтому до 250 мс ритм 700 мс держится.
FAST_MS = 250.0
# Лесенка вдвое дешевле полного окна на коротких фразах: при 200 мс на окне 1024
# длинная реплика в 1280 укладывается в тот же ритм, что на CUDA.
LADDER_FAST_MS = 200.0
# MID: финал в 22 с на окне 1280 стоит около 2× окна 1024, при 600 мс это 1.2 с —
# ещё терпимо. Ниже 0.6× процессора выигрыш не окупает риск драйвера и дележа
# видеокарты с Zoom/Teams.
MID_MS = 600.0
MID_CPU_SHARE = 0.6
# Лесенка в замерах ускоряла короткие фразы вдвое (263 → 134 мс). Полное окно
# медленнее 2.4 с не даст и 600 мс даже при четырёхкратном выигрыше — не тратим
# на него ещё десяток прогонов старта.
HOPELESS_FULL_MS = 2400.0

# Сколько прогонов и какие брать в зачёт. Первые 1–2 после загрузки на noCM
# медленнее на 10–30 % (компиляция, кэши), поэтому медиана прогонов 4–6.
WARM_CALLS = 6
MEASURE_FROM = 3
LADDER_WARM = 2
LADDER_MEASURE = 3

SHORT_MIN_SIM = 0.85
LONG_MIN_SIM = 0.80
# На короткой фразе все 19 конфигураций этапа 2 дали 1.0 и распознали «СКД»:
# промах значит сломанный путь шейдеров, а не трудную фразу.
SHORT_MUST_HAVE = "скд"

# Сторож во время работы: медиана отношения «цена финала / оценка гейта» по
# последним финалам. Вдвое дороже — видеокарту заняли (игра, рендер, второй
# созвон) или драйвер деградировал: процессор предсказуемее.
WATCH_FINALS = 5
WATCH_RATIO = 2.0

# --- сколько помним плохой итог ---
# Сбой помощника — авария, зависание, ошибка — посреди сессии или на самой проверке. Следующий старт
# сразу на процессоре: сбой драйвера посреди созвона дороже секунды. Но не до смены ключа: разовый TDR
# из-за игры, сна ноутбука или снятого снаружи процесса выключал бы ускорение до обновления драйвера,
# а переустановка тех же файлов ключ не меняет. Повтор через сутки; сбоит снова — вдвое дольше, до
# месяца. Сбой старше месяца забыт, счёт с начала.
FAILED_RETRY_S = 24 * 3600.0
FAILED_RETRY_MAX_S = 30 * 24 * 3600.0
# «Не быстрее процессора» и «текст искажён» — замер, а не авария, но и он бывает случайным: на старте
# видеокарту занимали игра или кодирование видео. Перепроверяем раз в три дня: проверка — секунд десять.
CPU_VERDICT_TTL_S = 3 * 24 * 3600.0

CUDA_CAPS = Caps(partial_every_ms=700, max_utterance_ms=30_000)
LADDER_CAPS = Caps(partial_every_ms=700, max_utterance_ms=LADDER_MAX_UTTERANCE_MS)
# Черновик — только когда модель свободна и показывается сразу, как на процессоре:
# второй гипотезы для LocalAgreement при 0.3–0.6 с на прогон не дождаться.
MID_CAPS = Caps(partial_every_ms=1000, max_utterance_ms=LADDER_MAX_UTTERANCE_MS, backoff=1.0, min_partial_ms=800)

TIER_FAST = "fast"
TIER_LADDER = "ladder"
TIER_MID = "mid"
TIER_CPU = "cpu"

VENDOR_AMD = 0x1002
VENDOR_INTEL = 0x8086
VENDOR_NVIDIA = 0x10DE
DRIVER_AMD_PROPRIETARY = 1      # VkDriverId

# Имена — только запасной путь, когда помощник не прислал архитектуру и драйвер.
# Новые AMD (RDNA3/RDNA4) — у ggml там путь coopmat, flash attention полезен.
_AMD_NEW = re.compile(
    r"RX\s*[79]\d{3}|Radeon\s*(?:PRO\s*)?W[79]\d{3}|\b(?:7[4-9]0|8[0-9]0)M\b|\b80[4-9]0S\b|Radeon\s*AI", re.I)
# Остальные AMD на фирменном драйвере считаем старыми: GCN (RX 4xx/5xx, Vega),
# RDNA1 (RX 5000), RDNA2 (RX 6000, 610M/660M/680M) и безымянные «AMD Radeon(TM)
# Graphics», за которыми бывают и Vega, и RDNA2. Ошибиться в эту сторону дёшево:
# без FA на скалярном пути теряется 15–20 %, а с FA на старых — мусор в тексте.
_AMD_NAME = re.compile(r"\b(amd|radeon|ati)\b", re.I)


class HelperError(RuntimeError):
    """Помощник ответил {"type":"error"}."""

    def __init__(self, msg: dict) -> None:
        super().__init__(f"{msg.get('code') or 'error'}: {msg.get('message', '')}")
        self.msg = msg
        self.code = msg.get("code")


class HelperDied(RuntimeError):
    """Процесс помощника завершился или закрыл трубу."""

    def __init__(self, what: str, exit_code: int | None) -> None:
        name = EXIT_NAMES.get(exit_code, "падение") if exit_code is not None else "не завершился"
        super().__init__(f"{what} (код выхода {exit_code}: {name})")
        self.exit_code = exit_code


class HelperTimeout(RuntimeError):
    """Помощник не ответил вовремя; процесс уже убит — граница ответа потеряна."""


# OSError — не запустился новый процесс помощника (антивирус удалил exe и подобное)
HELPER_FAILURES = (HelperDied, HelperTimeout, HelperError, OSError)


def _print_event(name: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": name, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def helper_argv(path: str, parent_pid: int) -> list:
    # .py — заглушка помощника в тестах: тот же протокол без видеокарты
    base = [sys.executable, "-X", "utf8", path] if path.lower().endswith(".py") else [path]
    # --parent-pid: Electron гасит python.exe через TerminateProcess, atexit не
    # срабатывает, и без этого флага помощник держал бы видеопамять сиротой.
    return base + ["--parent-pid", str(int(parent_pid))]


class Helper:
    """Один процесс помощника. Запросы строго по одному; ответ на запрос — следующая строка stdout."""

    def __init__(self, path: str, event, hello_timeout: float = HELLO_TIMEOUT_S) -> None:
        self.event = event
        self._lines: queue.Queue = queue.Queue()
        self._next_id = 1
        self._stderr_count = 0
        self.proc = subprocess.Popen(
            helper_argv(path, os.getpid()),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.pid = self.proc.pid
        threading.Thread(target=self._pump_stdout, name="vk-stdout", daemon=True).start()
        # stderr вычитывать обязательно: переполненная труба остановит помощника на записи лога
        threading.Thread(target=self._pump_stderr, name="vk-stderr", daemon=True).start()
        started = time.perf_counter()
        msg = self._recv(hello_timeout)
        self.hello_ms = (time.perf_counter() - started) * 1000
        if msg.get("type") != "hello":
            self.kill()
            raise HelperDied(f"вместо hello пришло {msg.get('type')!r}", self.proc.returncode)
        self.hello = msg

    def _pump_stdout(self) -> None:
        try:
            for raw in self.proc.stdout:
                self._lines.put(raw)
        except (OSError, ValueError):
            pass
        finally:
            self._lines.put(None)

    def _pump_stderr(self) -> None:
        try:
            for raw in self.proc.stderr:
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                self._stderr_count += 1
                # Текста речи помощник в stderr не пишет (README), но строки вида
                # «[00:00.000 --> …]» whisper.cpp печатает текст сегмента — их не пускаем.
                if line.startswith("[") and "-->" in line:
                    continue
                if self._stderr_count > STDERR_LINES_MAX and not STDERR_IMPORTANT.search(line):
                    continue
                self.event("vk-log", pid=self.pid, line=line[:STDERR_LINE_CHARS])
        except (OSError, ValueError):
            pass

    def alive(self) -> bool:
        return self.proc.poll() is None

    def _exit_code(self) -> int | None:
        try:
            return self.proc.wait(2)
        except subprocess.TimeoutExpired:
            return None

    def _send(self, obj: dict, payload: bytes = b"") -> None:
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            self.proc.stdin.write(data + b"\n" + payload)
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise HelperDied(f"запись в помощника не удалась: {e}", self._exit_code()) from None

    def _recv(self, timeout: float) -> dict:
        try:
            raw = self._lines.get(timeout=timeout)
        except queue.Empty:
            # Ответ может прийти позже и встать на место следующего: процесс
            # дальше не годится.
            self.kill()
            raise HelperTimeout(f"помощник не ответил за {timeout:g} с") from None
        if raw is None:
            self._lines.put(None)
            raise HelperDied("помощник закрыл stdout", self._exit_code())
        try:
            msg = json.loads(raw.decode("utf-8"))
        except ValueError:
            self.kill()
            raise HelperDied(f"не JSON от помощника: {raw[:120]!r}", self._exit_code()) from None
        if not isinstance(msg, dict):
            self.kill()
            raise HelperDied("ответ помощника — не объект", self._exit_code())
        return msg

    def load(self, model: str, device: int, flash_attn: bool, timeout: float = GATE_TIMEOUT_S) -> dict:
        self._send({"type": "load", "model": os.path.abspath(model), "device": int(device),
                    "flashAttn": bool(flash_attn), "threads": HELPER_THREADS})
        msg = self._recv(timeout)
        if msg.get("type") != "loaded":
            raise HelperError(msg)
        return msg

    def transcribe(self, audio: np.ndarray, tokens: list, audio_ctx: int, max_tokens: int,
                   language: str, timeout: float) -> dict:
        pcm = np.ascontiguousarray(np.asarray(audio, dtype=np.float32).reshape(-1), dtype="<f4")
        if pcm.size > MAX_SAMPLES:
            # Caps не пускают реплики длиннее 30 с; если всё же пришла — хвост свежее
            pcm = pcm[-MAX_SAMPLES:]
        rid = self._next_id
        self._next_id += 1
        self._send({"type": "transcribe", "id": rid, "samples": int(pcm.size), "language": language,
                    "audioCtx": int(audio_ctx), "promptTokens": list(tokens), "maxTokens": int(max_tokens)},
                   pcm.tobytes())
        msg = self._recv(timeout)
        if msg.get("type") != "result":
            raise HelperError(msg)
        if msg.get("id") != rid:
            self.kill()
            raise HelperDied(f"ответ на чужой запрос: ждали {rid}, пришёл {msg.get('id')}", self._exit_code())
        return msg

    def quit(self, timeout: float = 5.0) -> None:
        try:
            self._send({"type": "quit"})
            self.proc.wait(timeout)
        except (HelperDied, subprocess.TimeoutExpired):
            pass
        self.kill()

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        # В буфере stdin могут остаться байты недописанного запроса: закрываем
        # сами, иначе сборщик мусора позже шумит в stderr «Invalid argument».
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass


# --- правила ---

def _int(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        try:
            return int(v, 0)
        except ValueError:
            return None
    return None


def flash_attn_policy(dev: dict) -> tuple[bool, str]:
    """Включать ли flash attention на этом устройстве и почему.

    Верим полям помощника (vendorId, driverId/driverName, архитектура); имя
    устройства — только когда полей нет. Все поля необязательны: старый помощник
    их не присылает.
    """
    name = str(dev.get("name") or "")
    vendor = _int(dev.get("vendorId"))
    amd = vendor == VENDOR_AMD if vendor is not None else bool(_AMD_NAME.search(name))
    if not amd:
        return True, "не AMD"
    driver_id = _int(dev.get("driverId"))
    driver_name = str(dev.get("driverName") or "").lower()
    if driver_id is not None:
        proprietary = driver_id == DRIVER_AMD_PROPRIETARY
    elif driver_name:
        proprietary = "amd" in driver_name and "propriet" in driver_name
    else:
        # На Windows у AMD это почти всегда Adrenalin
        proprietary = True
    if not proprietary:
        return True, "AMD не на фирменном драйвере: у ggml там нет старого пути FA"
    # Помощник называет архитектуру по правилам ggml: amd-gcn, amd-rdna1, amd-rdna2,
    # amd-rdna3, … или other. Раз поле есть, ему и верим: «other» у AMD значит, что
    # и сам ggml не включит старый путь FA (old_amd_windows), — имя тут не нужно.
    raw_arch = dev.get("architecture")
    arch = str(raw_arch or "").lower().replace("-", "").replace("_", "")
    if re.search(r"gcn|polaris|vega|rdna[12]|navi[12]", arch):
        return False, f"AMD {raw_arch} на фирменном драйвере: старый путь FA"
    if arch:
        return True, f"AMD {raw_arch}: у ggml не старый путь FA"
    if _AMD_NEW.search(name):
        return True, "AMD RDNA3+ по имени устройства"
    return False, "AMD на фирменном драйвере, по имени GCN/RDNA1/RDNA2 или неизвестна"


def ladder_ctx(dur_s: float) -> int:
    """Окно кодировщика в кадрах для режима лесенки; 0 — полное окно.

    ctx = min(1280, max(1024, ceil((dur + 3) * 50 / 256) * 256)). Не влезает с
    запасом и в 1280 — полное окно: без FA смешивать окна можно, а обрезать
    хвост реплики нельзя.
    """
    need = (dur_s + LADDER_MARGIN_S) * FRAMES_PER_S
    ctx = min(LADDER_MAX_CTX, max(LADDER_MIN_CTX, math.ceil(need / CTX_STEP) * CTX_STEP))
    return ctx if need <= ctx else 0


def max_tokens(dur_s: float) -> int:
    return max(MIN_TOKENS, math.ceil(dur_s * TOKENS_PER_S))


def normalize(text: str) -> str:
    t = re.sub(r"[^\w ]", " ", text.lower().replace("ё", "е"))
    return " ".join(t.split())


def similarity(ref: str, text: str) -> float:
    return SequenceMatcher(None, normalize(ref), normalize(text)).ratio()


def repeats(text: str) -> bool:
    """Повтор, который looks_like_noise не ловит: предложение целиком дважды или
    вторая половина текста, повторяющая первую. На окне 768 так прошла реплика
    с одним продублированным предложением (степень сжатия ниже 2.4)."""
    sentences = [normalize(s) for s in re.split(r"[.!?…]+", text)]
    sentences = [s for s in sentences if len(s.split()) >= 3]
    if len(sentences) != len(set(sentences)):
        return True
    words = normalize(text).split()
    half = len(words) // 2
    return half >= 3 and words[:half] == words[half:2 * half]


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError(f"{os.path.basename(path)}: нужен PCM16 16 кГц моно")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def load_selftest(folder: str = SELFTEST_DIR) -> dict:
    """{'short': (звук, эталон), 'long': (звук, эталон)} — встроенные фразы проверки."""
    refs: dict = {}
    with open(os.path.join(folder, "phrases.tsv"), encoding="utf-8-sig") as f:
        for row in f:
            if "\t" in row:
                k, v = row.rstrip("\n").split("\t", 1)
                refs[k] = v.strip()
    return {k: (read_wav(os.path.join(folder, f"{k}.wav")), refs[k]) for k in ("short", "long")}


def pick_device(devices: list) -> dict | None:
    """Сначала дискретная, потом встроенная. «other» — Vulkan поверх D3D12 и прочие прослойки."""
    for kind in ("discrete", "integrated"):
        for d in devices or []:
            if isinstance(d, dict) and d.get("type") == kind:
                return d
    return None


# --- кэш итогов ---

class GateCache:
    """Итоги проверки и флаги сбоев в userData/stt-cache. Без каталога — ничего не помним."""

    def __init__(self, cache_dir: str | None) -> None:
        self.path = os.path.join(cache_dir, "vulkan-gate.json") if cache_dir else None
        self._lock = threading.Lock()

    def _read(self) -> dict:
        if not self.path:
            return {}
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict) -> None:
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            # Замена атомарна: сайдкар гасят TerminateProcess в любой момент,
            # и полузаписанный файл выглядел бы как «кэша нет».
            os.replace(tmp, self.path)
        except OSError:
            pass

    def _update(self, fn) -> None:
        with self._lock:
            data = self._read()
            fn(data)
            self._write(data)

    def get(self, key: str) -> dict | None:
        entry = self._read().get("gates", {}).get(key)
        return entry if isinstance(entry, dict) else None

    def put(self, key: str, entry: dict) -> None:
        def fn(data):
            gates = data.setdefault("gates", {})
            # История сбоев переживает удачную проверку: видеокарта, падающая каждый день, иначе каждый
            # день и получала бы повтор через сутки вместо растущей паузы.
            gates[key] = {**entry, **fail_history(gates.get(key))}
            # Храним несколько последних: драйвер обновили — старое не нужно, но и не мешает
            for old in sorted(gates, key=lambda k: gates[k].get("at", 0))[:-8]:
                gates.pop(old, None)
        self._update(fn)

    def drop(self, key: str) -> None:
        """Забыть итог проверки; историю сбоев — оставить (см. put)."""
        def fn(data):
            gates = data.get("gates", {})
            history = fail_history(gates.get(key))
            if history:
                gates[key] = {"parts": (gates.get(key) or {}).get("parts", {}), **history, "at": time.time()}
            else:
                gates.pop(key, None)
        self._update(fn)

    def mark_failed(self, key: str, reason: str, parts: dict | None = None) -> None:
        now = time.time()

        def fn(data):
            entry = data.setdefault("gates", {}).setdefault(key, {"parts": parts or {}})
            history = fail_history(entry)
            fails = history.get("fails", 0)
            if fails and now - history["failedAt"] > FAILED_RETRY_MAX_S:
                fails = 0  # прошлый сбой был давно — это новая история, а не повторение
            entry.update(failed=True, failReason=reason, fails=fails + 1, failedAt=now, at=now)
        self._update(fn)

    def cpu_ms(self, key: str) -> float | None:
        v = self._read().get("cpu", {}).get(key)
        return float(v) if isinstance(v, (int, float)) and v > 0 else None

    def put_cpu_ms(self, key: str, ms: float) -> None:
        self._update(lambda data: data.setdefault("cpu", {}).__setitem__(key, round(ms, 1)))

    def file_sha(self, path: str) -> str:
        """sha256 файла; модель в 874 МБ считается секунду, поэтому помним по размеру и времени."""
        st = os.stat(path)
        ident = f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}"
        known = self._read().get("files", {}).get(ident)
        if isinstance(known, str):
            return known
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 22), b""):
                h.update(block)
        sha = h.hexdigest()
        self._update(lambda data: data.setdefault("files", {}).__setitem__(ident, sha))
        return sha


def fail_history(entry: dict | None) -> dict:
    """{"fails": N, "failedAt": t} записи кэша; пусто — сбоев не было.
    Записи первой версии кэша знали только failed и at — это один сбой в момент at."""
    if not isinstance(entry, dict):
        return {}
    fails = entry.get("fails")
    at = entry.get("failedAt")
    if not (isinstance(fails, int) and fails > 0):
        fails = 1 if entry.get("failed") else 0
    if not fails:
        return {}
    if not isinstance(at, (int, float)):
        at = entry.get("at") if isinstance(entry.get("at"), (int, float)) else 0.0
    return {"fails": fails, "failedAt": float(at)}


def failed_retry_s(fails: int) -> float:
    """Через сколько после сбоя проверить видеокарту снова: сутки, двое, четверо… до месяца."""
    return min(FAILED_RETRY_MAX_S, FAILED_RETRY_S * 2 ** max(0, fails - 1))


def span_ru(seconds: float) -> str:
    """«час», «23 ч», «3 дн.» — для «проверю снова через …»."""
    hours = seconds / 3600
    if hours <= 1:
        return "час"
    if hours <= 36:
        return f"{math.ceil(hours)} ч"
    return f"{math.ceil(hours / 24)} дн."


def retry_at_ru(ts: float) -> str:
    """«16.09 после 14:05» — когда видеокарту проверят снова.

    Абсолютное время, а не «через 24 ч»: причина из готовности сайдкара остаётся в строке
    настроек до следующей сессии, и отсчёт, замороженный в момент старта, через пару дней врал бы.
    """
    return time.strftime("%d.%m после %H:%M", time.localtime(ts))


def gate_key(hello: dict, dev: dict, exe_sha: str, model_sha: str) -> tuple[str, dict]:
    """Ключ итога: устройство + драйвер + помощник + модель. Сменилось что-то — проверяем заново."""
    parts = {
        "gate": GATE_VERSION,
        "name": dev.get("name"),
        "vendorId": dev.get("vendorId"),
        "deviceId": dev.get("deviceId"),
        # всё про драйвер, что прислал помощник: версия сырая и строкой, id, имя
        **{k: v for k, v in sorted(dev.items()) if k.startswith("driver")},
        # какой путь шейдеров выберет ggml: сменился — прошлые замеры о другом пути
        **{k: dev.get(k) for k in ("apiVersion", "architecture", "uma", "coopmat", "coopmat2",
                                   "integerDotProduct", "fp16") if k in dev},
        "helper": hello.get("version"),
        "helperBuild": hello.get("helperVersion") or hello.get("build"),
        "protocol": hello.get("protocol"),
        "exe": exe_sha,
        "model": model_sha,
    }
    blob = json.dumps(parts, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:24], parts


def cpu_key(whisper_model: str) -> str:
    try:
        size = os.path.getsize(os.path.join(whisper_model, "model.bin"))
    except OSError:
        size = 0
    return f"{GATE_VERSION}|{platform.processor()}|{os.cpu_count()}|{cpu_threads()}|{size}"


@dataclass
class GateResult:
    tier: str
    flash_attn: bool | None = None
    t_full_ms: float | None = None
    t_long_full_ms: float | None = None
    t_ladder_ms: float | None = None
    t_long_ladder_ms: float | None = None
    t_cpu_ms: float | None = None
    reason: str | None = None
    # итог CPU из-за аварии или зависания помощника на проверке, а не из замера:
    # в кэш идёт флагом сбоя с повтором, а не вердиктом «процессор»
    helper_failed: bool = False


# --- движок ---

class VulkanEngine:
    """Тот же интерфейс, что у engines.Engine: name, label, device, compute_type, caps,
    set_terms, warm_up, transcribe → (текст, длительность).

    После сбоя помощника движок сам становится процессорным: грузит CT2 на
    процессоре (лениво — память нужна только при сбое) и дальше отдаёт всё ему.
    Очередь asr.py читает caps и окно на каждом шаге, поэтому подхватывает смену сама.
    """

    name = "whisper.cpp"

    def __init__(self, *, vk_helper: str, ggml_model: str, whisper_model: str, language: str,
                 glossary: str, cpu_factory, event, forced: bool, selftest: dict,
                 noise=None, cache: GateCache | None = None) -> None:
        from tokenizers import Tokenizer

        self.vk_helper = vk_helper
        self.ggml_model = ggml_model
        self.language = language
        self.forced = forced
        self.event = event
        self.noise = noise
        self.cache = cache or GateCache(None)
        self.selftest = selftest
        self._cpu_factory = cpu_factory
        self._tok = Tokenizer.from_file(os.path.join(whisper_model, "tokenizer.json"))
        self.model_name = os.path.basename(os.path.normpath(whisper_model))
        m = re.search(r"(q\d_\d|q\d_k|f16|f32)", os.path.basename(ggml_model), re.I)
        self._compute_type = m.group(1).lower() if m else "ggml"
        # Подсказка с запуска — как у CT2: сырой --glossary, первые 223 токена
        # (faster-whisper режет hotwords с конца, сохраняя начало).
        text = glossary.strip()
        self._prompt = (text, self._encode(text)[:MAX_PROMPT_TOKENS] if text else [])
        self.helper: Helper | None = None
        self.device_info: dict = {}
        self.device_index = -1
        self.flash_attn: bool | None = None
        self.mode = "full"
        self.tier: str | None = None
        self.result: GateResult | None = None
        self._caps = CUDA_CAPS
        self._warm_up_s = 0.0
        self.key: str | None = None
        self.key_parts: dict = {}
        # общий срок стартовой проверки (time.monotonic); None — без срока
        self.gate_deadline: float | None = None
        self._cpu = None
        self._lock = threading.Lock()
        self._switch = threading.Lock()
        # растёт при каждой смене устройства: очередь сбрасывает свои оценки стоимости
        self.epoch = 0
        # (цена / оценка, цена в мс) последних финалов — для сторожа
        self._ratios: deque = deque(maxlen=WATCH_FINALS)
        self._degraded: str | None = None
        # цена фразы на процессоре, если известна (замер проверки или кэш)
        self.t_cpu_ms: float | None = None

    # --- то, что видит asr.py; после сбоя — процессорный движок ---

    @property
    def device(self) -> str:
        return self._cpu.device if self._cpu is not None else "vulkan"

    @property
    def caps(self) -> Caps:
        return self._cpu.caps if self._cpu is not None else self._caps

    @property
    def label(self) -> str:
        if self._cpu is not None:
            return self._cpu.label
        return f"{self.model_name} · видеокарта {self.device_info.get('name', '?')} (Vulkan)"

    @property
    def compute_type(self) -> str:
        return self._cpu.compute_type if self._cpu is not None else self._compute_type

    @property
    def warm_up_s(self) -> float:
        return float(getattr(self._cpu, "warm_up_s", 0.0) or 0.0) if self._cpu is not None else self._warm_up_s

    @property
    def hotwords(self) -> str:
        return self._prompt[0]

    @property
    def prompt_tokens(self) -> list:
        return self._prompt[1]

    def _encode(self, text: str) -> list:
        # как faster-whisper: ведущий пробел, без служебных токенов
        return self._tok.encode(" " + text, add_special_tokens=False).ids

    def set_terms(self, terms: list) -> dict:
        """Тот же текст словаря, что у CT2 (fit_hotwords), и те же номера токенов.

        Пара (текст, токены) заменяется одним присваиванием: прогон, который уже
        идёт, дойдёт со старым словарём, следующий возьмёт новый целиком.
        """
        text, info = fit_hotwords(lambda t: len(self._encode(t)), terms)
        tokens = self._encode(text) if text else []
        if len(tokens) > MAX_PROMPT_TOKENS:  # бюджет 222 это исключает; страховка от смены токенизатора
            tokens = tokens[:MAX_PROMPT_TOKENS]
        self._prompt = (text, tokens)
        cpu = self._cpu
        if cpu is not None:
            cpu.hotwords = text
        return info

    def warm_up(self) -> None:
        """Прогрев уже прошёл в стартовой проверке: там же и замер для очереди."""

    def encoder_window(self, audio_s: float) -> float | None:
        if self._cpu is not None:
            pick = getattr(self._cpu, "encoder_window", None)
            return pick(audio_s) if pick is not None else None
        if self.mode != "ladder":
            return None
        ctx = ladder_ctx(audio_s)
        return ctx / FRAMES_PER_S if ctx else None

    def audio_ctx(self, dur_s: float) -> int:
        # С flash attention — только полное окно: иначе текст зависит от прошлых запросов
        if self.flash_attn or self.mode != "ladder":
            return 0
        return ladder_ctx(dur_s)

    def transcribe(self, audio: np.ndarray) -> tuple[str, float]:
        if self._cpu is None and self._degraded is not None:
            self._fall_back(self._degraded, remember=False)
        if self._cpu is not None:
            return self._cpu.transcribe(audio)
        dur = audio.size / SAMPLE_RATE
        tokens = self._prompt[1]
        try:
            with self._lock:
                helper = self.helper
                if helper is None or not helper.alive():
                    raise HelperDied("помощник не запущен", None if helper is None else helper.proc.returncode)
                r = helper.transcribe(audio, tokens, self.audio_ctx(dur), max_tokens(dur),
                                      self.language, RUNTIME_TIMEOUT_S)
        except HelperTimeout:
            self._fall_back(f"видеокарта не ответила за {RUNTIME_TIMEOUT_S:g} с", remember=True)
            return self._cpu.transcribe(audio)
        except HelperDied as e:
            what = ("помощник Vulkan аварийно остановился" if e.exit_code == EXIT_FATAL
                    else "помощник Vulkan завершился")
            self._fall_back(f"{what} (код {e.exit_code})", remember=True)
            return self._cpu.transcribe(audio)
        except HelperError as e:
            # После исключения ggml-vulkan модель потеряна до нового load: это сбой устройства
            self._fall_back(f"помощник Vulkan вернул ошибку: {e}", remember=True)
            return self._cpu.transcribe(audio)
        text = " ".join(str(r.get("text", "")).split())
        # Зацикливание: пересчёт не поможет — та же подсказка и нулевая температура
        if compression_ratio(text) > COMPRESSION_RATIO_MAX:
            text = ""
        return text, dur

    def note_final(self, audio_s: float, cost_s: float) -> None:
        """Цена финала от очереди asr.py. Зовётся из event loop — здесь только счёт,
        сам переход на процессор (секунды загрузки CT2) делает следующий transcribe."""
        if self.forced or self._cpu is not None or self._degraded is not None or self.result is None:
            return
        est = self._estimate_ms(audio_s)
        if not est:
            return
        self._ratios.append((cost_s * 1000 / est, cost_s * 1000))
        if len(self._ratios) < WATCH_FINALS:
            return
        ratio = statistics.median(r for r, _ in self._ratios)
        cost = statistics.median(c for _, c in self._ratios)
        # Вдвое медленнее проверки — ещё не повод: 108 мс на FAST, ставшие 250 мс
        # из-за кодирования видео в Zoom, всё равно впятеро быстрее процессора.
        # Уходим, только когда финалы дороже порога MID — того, выше которого
        # видеокарту на старте не пустили бы вовсе.
        floor = min(MID_MS, MID_CPU_SHARE * self.t_cpu_ms) if self.t_cpu_ms else MID_MS
        if ratio > WATCH_RATIO and cost > floor:
            self._degraded = (f"видеокарта замедлилась: финалы в {ratio:.1f} раза дольше, "
                              f"чем на стартовой проверке ({cost:.0f} мс)")
            self.event("vulkan-slow", ratio=round(ratio, 2), costMs=round(cost), estimateMs=round(est),
                       floorMs=round(floor))

    def _estimate_ms(self, audio_s: float) -> float | None:
        r = self.result
        a, b = (r.t_full_ms, r.t_long_full_ms) if self.mode == "full" else (r.t_ladder_ms, r.t_long_ladder_ms)
        if a is None:
            return None
        if b is None:
            return a
        short_s = self.selftest["short"][0].size / SAMPLE_RATE
        long_s = self.selftest["long"][0].size / SAMPLE_RATE
        x = min(1.0, max(0.0, (audio_s - short_s) / max(1e-6, long_s - short_s)))
        return a + (b - a) * x

    def _fall_back(self, reason: str, remember: bool) -> None:
        with self._switch:
            if self._cpu is not None:
                return
            self.event("vulkan-failed", reason=reason, remembered=remember)
            if self.helper is not None:
                self.helper.kill()
            if remember and self.key:
                # Следующий старт сразу на процессоре, пока не сменится драйвер,
                # помощник или модель: сбой драйвера посреди созвона дороже секунды.
                self.cache.mark_failed(self.key, reason, self.key_parts)
            cpu = self._cpu_factory()
            cpu.hotwords = self._prompt[0]
            self._cpu = cpu
            self.epoch += 1
            self.event("engine-fallback", device=cpu.device, label=cpu.label, reason=reason)

    def close(self) -> None:
        if self.helper is not None:
            self.helper.quit()
            self.helper = None

    # --- стартовая проверка ---

    def start_helper(self) -> dict:
        self.helper = Helper(self.vk_helper, self.event)
        return self.helper.hello

    def _restart_helper(self) -> None:
        if self.helper is not None:
            self.helper.kill()
        self.start_helper()

    def _gate_timeout(self) -> float:
        """Таймаут очередного шага проверки: не больше GATE_TIMEOUT_S и не дальше общего срока."""
        if self.gate_deadline is None:
            return GATE_TIMEOUT_S
        left = self.gate_deadline - time.monotonic()
        if left <= 0:
            if self.helper is not None:
                self.helper.kill()
            raise HelperTimeout(f"проверка видеокарты не уложилась в {GATE_TOTAL_S:g} с")
        return min(GATE_TIMEOUT_S, left)

    def _load(self, fa: bool) -> None:
        timeout = self._gate_timeout()
        if self.helper is None or not self.helper.alive():
            self._restart_helper()
        started = time.perf_counter()
        info = self.helper.load(self.ggml_model, self.device_index, fa, timeout)
        self.flash_attn = bool(fa)
        self.event("vulkan-gate", step="load", flashAttn=bool(fa),
                   ms=round((time.perf_counter() - started) * 1000), device=info.get("name"))

    def _call(self, clip: str, ctx: int) -> tuple[str, float]:
        audio, _ = self.selftest[clip]
        dur = audio.size / SAMPLE_RATE
        if self.flash_attn and ctx:
            raise AssertionError("с flash attention окно только полное")
        timeout = self._gate_timeout()
        started = time.perf_counter()
        r = self.helper.transcribe(audio, self._prompt[1], ctx, max_tokens(dur), self.language, timeout)
        ms = (time.perf_counter() - started) * 1000
        return " ".join(str(r.get("text", "")).split()), ms

    def _problem(self, clip: str, text: str) -> str | None:
        """Что не так с текстом встроенной фразы; None — годится. Текст — наш синтез, не речь пользователя."""
        audio, ref = self.selftest[clip]
        dur = audio.size / SAMPLE_RATE
        sim = similarity(ref, text)
        cr = compression_ratio(text)
        if cr > COMPRESSION_RATIO_MAX:
            return f"{clip}: зацикливание (сжатие {cr:.2f}): {text[:120]}"
        if self.noise is not None and self.noise(text, dur, dur):
            return f"{clip}: похоже на выдумку: {text[:120]}"
        if clip == "short":
            if sim < SHORT_MIN_SIM:
                return f"short: сходство {sim:.2f}: {text[:120]}"
            if SHORT_MUST_HAVE not in normalize(text).split():
                return f"short: нет «СКД»: {text[:120]}"
        else:
            if sim < LONG_MIN_SIM:
                return f"long: сходство {sim:.2f}: {text[:120]}"
            if repeats(text):
                return f"long: повтор: {text[:120]}"
        return None

    def _phase_full(self, fa: bool) -> tuple[str | None, float | None, float | None]:
        """Полное окно: загрузка, WARM_CALLS прогонов короткой фразы, одна длинная."""
        self._load(fa)
        times = []
        for _ in range(WARM_CALLS):
            text, ms = self._call("short", 0)
            problem = self._problem("short", text)
            if problem:
                self.event("vulkan-gate", step="full", flashAttn=fa, problem=problem)
                return problem, None, None
            times.append(ms)
        t_full = statistics.median(times[MEASURE_FROM:])
        text, t_long = self._call("long", 0)
        problem = self._problem("long", text)
        self.event("vulkan-gate", step="full", flashAttn=fa, tFullMs=round(t_full), tLongMs=round(t_long),
                   callsMs=[round(t) for t in times], problem=problem)
        return problem, t_full, t_long

    def _phase_ladder(self) -> tuple[str | None, float | None, float | None]:
        """Лесенка без FA: короткая в 1024, длинная в 1280 — те окна, что пойдут в работу."""
        short_ctx = ladder_ctx(self.selftest["short"][0].size / SAMPLE_RATE)
        long_ctx = ladder_ctx(self.selftest["long"][0].size / SAMPLE_RATE)
        times = []
        for _ in range(LADDER_WARM + LADDER_MEASURE):
            text, ms = self._call("short", short_ctx)
            problem = self._problem("short", text)
            if problem:
                self.event("vulkan-gate", step="ladder", problem=problem)
                return problem, None, None
            times.append(ms)
        t_ladder = statistics.median(times[LADDER_WARM:])
        t_long = None
        for _ in range(2):  # первый прогон в новом окне может собирать конвейеры
            text, t_long = self._call("long", long_ctx)
            problem = self._problem("long", text)
            if problem:
                self.event("vulkan-gate", step="ladder", problem=problem)
                return problem, None, None
        self.event("vulkan-gate", step="ladder", ctx=[short_ctx, long_ctx], tLadderMs=round(t_ladder),
                   tLongMs=round(t_long), callsMs=[round(t) for t in times])
        return None, t_ladder, t_long

    def run_gate(self, fa_default: bool, cpu_ms) -> GateResult:
        """Уровни из п.6 спецификации. cpu_ms() — цена фразы на процессоре (кэш или замер)."""
        res = GateResult(TIER_CPU)
        fa = fa_default
        try:
            problem, t_full, t_long = self._phase_full(fa)
        except HELPER_FAILURES as e:
            if not fa:
                return GateResult(TIER_CPU, False, reason=f"помощник сбоил на проверке: {e}", helper_failed=True)
            # Сбой именно с FA — возможно, тот самый путь шейдеров. _load сам поднимет
            # свежий процесс, если этот умер или убит по таймауту.
            self.event("vulkan-gate", step="full", flashAttn=True, problem=f"сбой: {e}")
            problem, t_full, t_long = f"сбой: {e}", None, None
        if problem and fa:
            fa = False
            try:
                problem, t_full, t_long = self._phase_full(False)
            except HELPER_FAILURES as e:
                return GateResult(TIER_CPU, False, reason=f"помощник сбоил на проверке: {e}", helper_failed=True)
        res.flash_attn = fa
        if problem:
            res.reason = f"текст на видеокарте искажён ({problem})"
            return res
        res.t_full_ms, res.t_long_full_ms = t_full, t_long
        if t_full <= FAST_MS:
            res.tier = TIER_FAST
            return res
        if not self.forced and t_full > HOPELESS_FULL_MS:
            res.reason = f"видеокарта медленная: {t_full:.0f} мс на фразу"
            return res
        try:
            if fa:
                # С FA окна смешивать нельзя — лесенка только в процессе без FA
                fa = False
                res.flash_attn = False
                self._load(False)
            problem, t_ladder, t_long_ladder = self._phase_ladder()
        except HELPER_FAILURES as e:
            res.reason = f"помощник сбоил на проверке окон: {e}"
            res.helper_failed = True
            return res
        if problem:
            res.reason = f"текст на видеокарте искажён ({problem})"
            return res
        res.t_ladder_ms, res.t_long_ladder_ms = t_ladder, t_long_ladder
        if t_ladder <= LADDER_FAST_MS:
            res.tier = TIER_LADDER
            return res
        if self.forced:
            res.tier = TIER_MID
            return res
        res.t_cpu_ms = t_cpu = cpu_ms()
        limit = min(MID_MS, MID_CPU_SHARE * t_cpu)
        if t_ladder <= limit:
            res.tier = TIER_MID
        else:
            res.reason = (f"видеокарта не быстрее процессора: {t_ladder:.0f} мс на фразу "
                          f"при пороге {limit:.0f} мс (процессор {t_cpu:.0f} мс)")
        return res

    def verify_cached(self, entry: dict) -> str | None:
        """Кэшированный итог: без замеров, но с загрузкой, прогревом и сверкой текста.
        None — всё сходится; иначе что не так."""
        tier = entry.get("tier")
        fa = bool(entry.get("flash_attn"))
        if tier not in (TIER_FAST, TIER_LADDER, TIER_MID) or (fa and tier != TIER_FAST):
            return f"неизвестный итог в кэше: {tier}"
        try:
            self._load(fa)
            self.mode = "full" if tier == TIER_FAST else "ladder"
            ctx_short = self.audio_ctx(self.selftest["short"][0].size / SAMPLE_RATE)
            ctx_long = self.audio_ctx(self.selftest["long"][0].size / SAMPLE_RATE)
            for clip, ctx in (("short", ctx_short), ("short", ctx_short), ("long", ctx_long)):
                text, _ = self._call(clip, ctx)
                problem = self._problem(clip, text)
                if problem:
                    return problem
        except HELPER_FAILURES as e:
            return f"сбой: {e}"
        return None

    def apply(self, res: GateResult) -> None:
        if res.tier == TIER_FAST:
            self.mode, self._caps, warm = "full", CUDA_CAPS, res.t_full_ms
        elif res.tier == TIER_LADDER:
            self.mode, self._caps, warm = "ladder", LADDER_CAPS, res.t_ladder_ms
        elif res.tier == TIER_MID:
            self.mode, self._caps, warm = "ladder", MID_CAPS, res.t_ladder_ms
        else:
            raise ValueError(f"уровень {res.tier} не для видеокарты")
        if res.flash_attn and self.mode != "full":
            raise ValueError("лесенка с flash attention недопустима")
        self.flash_attn = bool(res.flash_attn)
        self.tier = res.tier
        self.result = res
        if res.t_cpu_ms:
            self.t_cpu_ms = res.t_cpu_ms
        # Первая оценка стоимости прогона для очереди — как warm_up_s у CT2
        self._warm_up_s = (warm or 0.0) / 1000


def _info(res: GateResult | None, dev: dict | None, cached: bool, reason: str | None) -> dict:
    """Итог для ready сайдкара: приложение показывает устройство или причину, почему процессор."""
    r = res or GateResult(TIER_CPU)
    rnd = (lambda v: None if v is None else round(v))
    return {
        "tier": r.tier,
        "device": (dev or {}).get("name"),
        "flashAttn": r.flash_attn,
        "tFullMs": rnd(r.t_full_ms),
        "tLadderMs": rnd(r.t_ladder_ms),
        "tCpuMs": rnd(r.t_cpu_ms),
        "cached": cached,
        "reason": reason if reason is not None else r.reason,
    }


def open_engine(*, forced: bool, vk_helper: str | None, ggml_model: str | None, whisper_model: str,
                cache_dir: str | None, language: str, glossary: str, cpu_factory, log=None,
                event=None, noise=None, selftest_dir: str = SELFTEST_DIR):
    """Поднять VulkanEngine или объяснить, почему нет.

    Возвращает (движок | None, процессорный движок | None, причина | None, итог для ready).
    Процессорный движок бывает уже загружен: для порога MID его пришлось замерить,
    и грузить его второй раз ради того же процессора незачем.
    forced (--device vulkan): без перехода на процессор по скорости; недоступен — EngineError.
    """
    event = event or _print_event
    cache = GateCache(cache_dir)
    holder: dict = {}
    engine: VulkanEngine | None = None
    dev: dict | None = None

    def unavailable(why: str, res: GateResult | None = None, cached: bool = False):
        if engine is not None:
            engine.close()
        info = _info(res, dev, cached, why)
        event("vulkan-gate", step="result", **info)
        if forced:
            raise EngineError("no-vulkan", f"Распознавание на видеокарте через Vulkan недоступно: {why}")
        return None, holder.get("cpu"), why, info

    if not vk_helper or not os.path.isfile(vk_helper):
        return unavailable("пакет не установлен: нет помощника podskazych-vk")
    if not ggml_model or not os.path.isfile(ggml_model):
        return unavailable("пакет не установлен: нет модели ggml")
    if not os.path.isfile(os.path.join(whisper_model, "tokenizer.json")):
        return unavailable("нет tokenizer.json рядом с моделью распознавания")
    try:
        selftest = load_selftest(selftest_dir)
    except (OSError, ValueError, KeyError) as e:
        return unavailable(f"нет встроенных фраз проверки: {e}")

    engine = VulkanEngine(vk_helper=vk_helper, ggml_model=ggml_model, whisper_model=whisper_model,
                          language=language, glossary=glossary, cpu_factory=cpu_factory, event=event,
                          forced=forced, selftest=selftest, noise=noise, cache=cache)
    engine.gate_deadline = time.monotonic() + GATE_TOTAL_S
    try:
        hello = engine.start_helper()
    except (OSError, HelperDied, HelperTimeout) as e:
        engine.helper = None
        return unavailable(f"помощник не запустился: {e}")
    event("vulkan-gate", step="hello", ms=round(engine.helper.hello_ms), version=hello.get("version"),
          vulkanLoader=hello.get("vulkanLoader"), cpuOk=hello.get("cpuOk"), devices=hello.get("devices"))
    if not hello.get("vulkanLoader"):
        return unavailable("нет драйвера Vulkan")
    if not hello.get("cpuOk"):
        return unavailable("процессор без AVX2: сборка помощника на нём не работает")
    dev = pick_device(hello.get("devices") or [])
    if dev is None:
        return unavailable("нет видеокарты с Vulkan")
    engine.device_info = dev
    engine.device_index = _int(dev.get("index")) if _int(dev.get("index")) is not None else -1
    fa_default, fa_why = flash_attn_policy(dev)

    try:
        engine.key, engine.key_parts = gate_key(hello, dev, cache.file_sha(vk_helper), cache.file_sha(ggml_model))
    except OSError as e:
        return unavailable(f"не читается файл пакета: {e}")
    engine.t_cpu_ms = cache.cpu_ms(cpu_key(whisper_model))

    def cpu_ms() -> float:
        ck = cpu_key(whisper_model)
        known = cache.cpu_ms(ck)
        if known is not None:
            return known
        # Процессор меряем на той же фразе: окно 10 с у CT2 и 1024 у помощника — сопоставимы
        e = cpu_factory()
        holder["cpu"] = e
        started = time.perf_counter()
        e.transcribe(selftest["short"][0])
        ms = (time.perf_counter() - started) * 1000
        cache.put_cpu_ms(ck, ms)
        event("vulkan-gate", step="cpu", tCpuMs=round(ms))
        return ms

    if not forced:
        entry = cache.get(engine.key)
        now = time.time()
        if entry and entry.get("failed"):
            history = fail_history(entry)
            wait = failed_retry_s(history["fails"]) - (now - history["failedAt"])
            if wait > 0:
                return unavailable(f"видеокарта сбоила в прошлый раз: {entry.get('failReason')}; "
                                   f"проверю снова {retry_at_ru(now + wait)}", cached=True)
            # Пауза после сбоя вышла — полная проверка: прошлые замеры были до сбоя.
            event("vulkan-gate", step="cache", retry="после сбоя", fails=history["fails"])
            entry = None
        if entry and entry.get("tier") == TIER_CPU:
            age = now - float(entry.get("at") or 0)
            if age < CPU_VERDICT_TTL_S:
                res = GateResult(**{k: entry.get(k) for k in GateResult.__dataclass_fields__})
                return unavailable(res.reason or "процессор быстрее", res, cached=True)
            event("vulkan-gate", step="cache", retry="итог «процессор» устарел", ageH=round(age / 3600))
            entry = None
        # Запись только с историей сбоев (итог забыт после неудачной сверки) — не итог.
        if entry and entry.get("tier") in (TIER_FAST, TIER_LADDER, TIER_MID):
            problem = engine.verify_cached(entry)
            if problem is None:
                res = GateResult(**{k: entry.get(k) for k in GateResult.__dataclass_fields__})
                engine.apply(res)
                info = _info(res, dev, True, None)
                event("vulkan-gate", step="result", **info)
                return engine, None, None, info
            event("vulkan-gate", step="cache", problem=problem)
            cache.drop(engine.key)

    event("vulkan-gate", step="policy", flashAttn=fa_default, why=fa_why)
    res = engine.run_gate(fa_default, cpu_ms)
    if not forced:
        if res.helper_failed:
            # Авария или зависание на проверке — не замер скорости: холодная сборка шейдеров, занятая
            # видеопамять. Помним как сбой, с повтором через паузу, а не «процессор» до смены драйвера.
            cache.mark_failed(engine.key, res.reason or "помощник сбоил на проверке", engine.key_parts)
        else:
            cache.put(engine.key, {**asdict(res), "parts": engine.key_parts, "at": time.time()})
    if res.tier == TIER_CPU:
        return unavailable(res.reason or "процессор быстрее", res)
    holder.clear()  # замерянный процессорный движок не нужен: при сбое загрузим заново
    engine.apply(res)
    info = _info(res, dev, False, None)
    event("vulkan-gate", step="result", **info)
    return engine, None, None, info
