"""
Распознавание через Vulkan без видеокарты: настоящие vulkan.py и engines.py,
а вместо podskazych-vk.exe — заглушка test_vk_stub.py с тем же протоколом.

Проверяем правила, а не скорость машины. Пороги уровней уменьшены в 5 раз
(scaled), задержки заглушки — тоже: полминуты стартовых проверок идут за секунды,
а соотношения «быстрее/медленнее порога» те же, что в спецификации.

Нужен токенизатор из sidecar/models/whisper-large-v3-turbo — тот же, что в работе.

Запуск: python -E -s -X utf8 sidecar/test_vulkan.py [часть имени теста ...]
"""
from __future__ import annotations

import re
import asyncio
import contextlib
import inspect
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import engines  # noqa: E402  (первым, как в asr.py)
from engines import Caps, EngineError  # noqa: E402

import vulkan  # noqa: E402

RETRY_AT = re.compile(r"проверю снова \d\d\.\d\d после \d\d:\d\d")
import asr  # noqa: E402

SR = engines.SAMPLE_RATE
MODEL_DIR = str(HERE / "models" / "whisper-large-v3-turbo")
STUB = str(HERE / "test_vk_stub.py")
CPU_CAPS = Caps(partial_every_ms=1500, max_utterance_ms=engines.CPU_MAX_UTTERANCE_MS, backoff=3.0, min_partial_ms=1500)

NVIDIA = {"index": 0, "name": "NVIDIA GeForce RTX 5060 Ti", "type": "discrete", "vramMB": 16050, "freeMB": 15282,
          "vendorId": 0x10DE, "driverId": 4, "driverVersion": "610.47"}
AMD_OLD = {"index": 0, "name": "AMD Radeon RX 5700 XT", "type": "discrete", "vramMB": 8176, "freeMB": 7900,
           "vendorId": 0x1002, "driverId": 1, "driverName": "AMD proprietary driver", "driverVersion": "25.8.1"}
# Как в README помощника (artifact3): все поля устройства
AMD_FULL = {**AMD_OLD, "deviceId": 29471, "driverInfo": "24.9.1 (AMD proprietary shader compiler)", "driverVersion": "2.0.302",
            "driverVersionRaw": 8388910, "apiVersion": "1.3.260", "architecture": "amd-rdna1", "uma": False,
            "coopmat": False, "coopmat2": False, "integerDotProduct": True, "fp16": True}


def check(cond, msg="") -> None:
    if not cond:
        raise AssertionError(msg)


class FakeCpu:
    """Процессорный движок без модели: считаем, сколько раз его грузили."""

    name = "faster-whisper"
    compute_type = "int8"
    device = "cpu"
    label = "whisper-large-v3-turbo · процессор"
    caps = CPU_CAPS
    created = 0

    def __init__(self, lat: float = 0.0) -> None:
        FakeCpu.created += 1
        self.lat = lat
        self.hotwords = ""
        self.calls = 0
        self.warm_up_s = 0.9

    def set_terms(self, terms):
        return {"kept": len(terms), "total": len(terms), "tokens": 0}

    def transcribe(self, audio):
        time.sleep(self.lat)
        self.calls += 1
        return "процессор", audio.size / SR

    def encoder_window(self, audio_s):
        return engines.Engine._cpu_window(audio_s)


class Env:
    """Каталог теста: конфиг и журнал заглушки, модель-пустышка, кэш."""

    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="vk-test-")
        self.cfg_path = os.path.join(self.dir, "stub.json")
        self.log_path = os.path.join(self.dir, "stub.log")
        self.model = os.path.join(self.dir, "ggml-large-v3-turbo-q8_0.bin")
        with open(self.model, "wb") as f:
            f.write(b"lmgg" + b"\0" * 64)
        self.cache = os.path.join(self.dir, "stt-cache")
        self.events: list = []
        self.engines: list = []
        self.cfg: dict = {}

    def set(self, **cfg) -> None:
        self.cfg = {"log": self.log_path, **cfg}
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(self.cfg, f)
        os.environ["PODSKAZYCH_VK_STUB"] = self.cfg_path

    def update(self, **cfg) -> None:
        self.set(**{**self.cfg, **cfg})

    def event(self, name, **fields) -> None:
        self.events.append({"event": name, **fields})

    def records(self, kind=None) -> list:
        if not os.path.exists(self.log_path):
            return []
        with open(self.log_path, encoding="utf-8") as f:
            rows = [json.loads(x) for x in f if x.strip()]
        return [r for r in rows if kind is None or r["type"] == kind]

    def reset_log(self) -> None:
        with contextlib.suppress(OSError):
            os.remove(self.log_path)

    def open(self, forced=False, cache=True, cpu_lat=0.0, glossary="", noise=asr.looks_like_noise):
        res = vulkan.open_engine(
            forced=forced, vk_helper=STUB, ggml_model=self.model, whisper_model=MODEL_DIR,
            cache_dir=self.cache if cache else None, language="ru", glossary=glossary,
            cpu_factory=lambda: FakeCpu(cpu_lat), event=self.event, noise=noise)
        if res[0] is not None:
            self.engines.append(res[0])
        return res

    def close(self) -> None:
        for e in self.engines:
            with contextlib.suppress(Exception):
                e.close()
        shutil.rmtree(self.dir, ignore_errors=True)


@contextlib.contextmanager
def scaled():
    """Пороги уровней в 5 раз меньше — под задержки заглушки."""
    names = ("FAST_MS", "LADDER_FAST_MS", "MID_MS", "HOPELESS_FULL_MS")
    saved = {n: getattr(vulkan, n) for n in names}
    for n in names:
        setattr(vulkan, n, saved[n] / 5)
    env = Env()
    FakeCpu.created = 0
    try:
        yield env
    finally:
        for n, v in saved.items():
            setattr(vulkan, n, v)
        env.close()


def lat(full1=None, full0=None, l1024=None, l1280=None) -> dict:
    return {"1": {"0": full1 if full1 is not None else 5},
            "0": {"0": full0 if full0 is not None else 5,
                  "1024": l1024 if l1024 is not None else 5, "1280": l1280 if l1280 is not None else 5}}


# --- чистые правила ---

def test_ladder_ctx_and_max_tokens():
    check(vulkan.ladder_ctx(0.5) == 1024, "короткая фраза — пол 1024")
    check(vulkan.ladder_ctx(17.48) == 1024, f"17.48 с: {vulkan.ladder_ctx(17.48)}")
    check(vulkan.ladder_ctx(17.5) == 1280, f"17.5 с: {vulkan.ladder_ctx(17.5)}")
    check(vulkan.ladder_ctx(22.0) == 1280, "финал в 22 с — 1280")
    check(vulkan.ladder_ctx(22.6) == 1280, "25.6 с ровно влезает")
    check(vulkan.ladder_ctx(22.7) == 0, "не влезает в 1280 с запасом — полное окно")
    for dur, want in ((0.3, 24), (1.6, 24), (2.0, 30), (5.63, 85), (22.0, 330)):
        check(vulkan.max_tokens(dur) == want, f"maxTokens({dur}) = {vulkan.max_tokens(dur)}, ждали {want}")
    check(vulkan.LADDER_MAX_UTTERANCE_MS / 1000 + vulkan.LADDER_MARGIN_S <= vulkan.LADDER_MAX_CTX / 50,
          "потолок реплики должен влезать в 1280 с запасом")


def test_flash_attn_policy():
    cases = [
        (NVIDIA, True),
        ({"name": "Intel(R) Arc(TM) A770 Graphics", "vendorId": 0x8086, "driverId": 5}, True),
        (AMD_OLD, False),
        ({**AMD_OLD, "name": "AMD Radeon RX 7900 XTX"}, True),
        ({**AMD_OLD, "name": "AMD Radeon RX 6600"}, False),
        ({**AMD_OLD, "name": "AMD Radeon RX 7600", "architecture": "amd-rdna2"}, False),   # поле важнее имени
        ({**AMD_OLD, "name": "AMD Radeon RX 5700 XT", "architecture": "amd-rdna3"}, True),
        ({**AMD_OLD, "architecture": "amd-rdna1"}, False),
        ({**AMD_OLD, "name": "Radeon RX 580", "architecture": "amd-gcn"}, False),
        ({**AMD_OLD, "name": "AMD Radeon RX 6600", "architecture": "other"}, True),         # ggml сам не считает старым
        ({**NVIDIA, "architecture": "other", "vendorId": 4318}, True),
        ({**AMD_OLD, "driverId": 3, "driverName": "radv"}, True),                            # не фирменный драйвер
        ({"name": "AMD Radeon RX 6700 XT", "vendorId": "0x1002", "driverName": "AMD proprietary driver"}, False),
        ({"name": "AMD Radeon(TM) 680M"}, False),                                           # только имя
        ({"name": "AMD Radeon 780M Graphics"}, True),
        ({"name": "AMD Radeon(TM) Graphics"}, False),
        ({"name": "Radeon RX 580 Series"}, False),
        ({"name": "AMD Radeon 8060S Graphics"}, True),
    ]
    for dev, want in cases:
        got, why = vulkan.flash_attn_policy(dev)
        check(got == want, f"{dev.get('name')} {dev.get('architecture', '')}: FA {got} ({why}), ждали {want}")


def test_text_checks():
    check(vulkan.repeats("Сначала проверим обмен. Потом посмотрим. Сначала проверим обмен."), "повтор предложения")
    check(vulkan.repeats("раз два три четыре раз два три четыре"), "вторая половина повторяет первую")
    check(not vulkan.repeats("Сначала проверим обмен с бухгалтерией, потом посмотрим остатки."), "без повтора")
    check(vulkan.similarity("Мы переделали отчёт на СКД.", "мы переделали отчет на скд") == 1.0, "нормализация")


def test_prompt_tokens_match_production():
    from tokenizers import Tokenizer

    env = Env()
    try:
        tok = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
        selftest = vulkan.load_selftest()
        long_glossary = ", ".join(f"регистр сведений номер {i}" for i in range(200))
        e = vulkan.VulkanEngine(vk_helper=STUB, ggml_model=env.model, whisper_model=MODEL_DIR, language="ru",
                                glossary=long_glossary, cpu_factory=FakeCpu, event=env.event, forced=False,
                                selftest=selftest)
        # Сырой --glossary: как hotwords у faster-whisper — первые 223 токена
        full = tok.encode(" " + long_glossary, add_special_tokens=False).ids
        check(e.prompt_tokens == full[:223], "подсказка с запуска не совпала с faster-whisper")
        terms = [f"Термин{i} ЗУП ERP" for i in range(300)]
        info = e.set_terms(terms)
        text, info_ct2 = engines.fit_hotwords(lambda t: len(tok.encode(" " + t, add_special_tokens=False).ids), terms)
        check(e.hotwords == text and info == info_ct2, f"словарь не как у CT2: {info} vs {info_ct2}")
        check(text.startswith(engines.HOTWORDS_LEAD), text[:40])
        check(e.prompt_tokens == tok.encode(" " + text, add_special_tokens=False).ids, "номера токенов не те")
        check(0 < len(e.prompt_tokens) <= 223 and info["tokens"] <= 222, f"бюджет: {len(e.prompt_tokens)}")
        e.set_terms([])
        check(e.hotwords == "" and e.prompt_tokens == [], "пустой словарь")
    finally:
        env.close()


# --- стартовая проверка ---

def test_gate_fast_nvidia():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15))
        glossary = ", ".join(f"термин {i}" for i in range(300))
        eng, cpu, why, info = env.open(glossary=glossary)
        check(eng is not None and why is None, f"не поднялся: {why}")
        check(info["tier"] == "fast" and info["flashAttn"] is True and info["cached"] is False, f"info: {info}")
        check(eng.caps == vulkan.CUDA_CAPS and eng.device == "vulkan", f"caps {eng.caps}")
        check(eng.label == "whisper-large-v3-turbo · видеокарта NVIDIA GeForce RTX 5060 Ti (Vulkan)", eng.label)
        check(eng.compute_type == "q8_0", eng.compute_type)
        check(0 < eng.warm_up_s < 0.05, f"warm_up_s {eng.warm_up_s}")
        starts = env.records("start")
        check(starts and starts[0]["parentPid"] == str(os.getpid()), f"--parent-pid: {starts}")
        loads = env.records("load")
        check([r["flashAttn"] for r in loads] == [True] and loads[0]["device"] == 0, f"load: {loads}")
        calls = env.records("transcribe")
        check(len(calls) == vulkan.WARM_CALLS + 1, f"прогонов проверки: {len(calls)}")
        check(all(r["audioCtx"] == 0 for r in calls), "с FA окно только полное")
        check(all(r["promptTokens"] == 223 for r in calls), f"подсказка: {[r['promptTokens'] for r in calls]}")
        check(all(r["maxTokens"] == vulkan.max_tokens(r["samples"] / SR) for r in calls), "maxTokens")
        text, dur = eng.transcribe(np.zeros(3 * SR, dtype=np.float32))
        check(text == "раз два три" and abs(dur - 3.0) < 1e-6, f"{text!r} {dur}")
        check(eng.encoder_window(10.0) is None and eng.audio_ctx(10.0) == 0, "полное окно в работе")
        logs = [e["line"] for e in env.events if e["event"] == "vk-log"]
        check(any("ggml_vulkan" in x for x in logs), f"stderr помощника не в логе: {logs}")
        check(not any("-->" in x or "секретная" in x for x in logs), "текст сегмента попал в лог")
        check(FakeCpu.created == 0, "процессор не нужен")


def test_gate_amd_mid():
    with scaled() as env:
        env.set(devices=[AMD_FULL], lat=lat(full0=100, l1024=70, l1280=80))
        eng, cpu, why, info = env.open(cpu_lat=0.2)
        check(eng is not None, f"не поднялся: {why}")
        check(any(e.get("step") == "policy" and "amd-rdna1" in e.get("why", "") for e in env.events), "FA решён не по полю")
        check(info["tier"] == "mid" and info["flashAttn"] is False, f"info: {info}")
        check(eng.caps == vulkan.MID_CAPS, f"caps {eng.caps}")
        check(info["tCpuMs"] and info["tCpuMs"] >= 190, f"T_cpu {info}")
        check(cpu is None and FakeCpu.created == 1, "замерянный процессор не отпущен или не мерили")
        check([r["flashAttn"] for r in env.records("load")] == [False], "AMD RDNA1 на фирменном драйвере — без FA")
        ctxs = [r["audioCtx"] for r in env.records("transcribe")]
        check(ctxs == [0] * 7 + [1024] * 5 + [1280] * 2, f"окна проверки: {ctxs}")
        check(abs(eng.encoder_window(5.0) - 20.48) < 1e-9 and abs(eng.encoder_window(20.0) - 25.6) < 1e-9, "окна")
        check(eng.encoder_window(23.0) is None, "длиннее 1280 — полное окно")
        env.reset_log()
        eng.transcribe(np.zeros(10 * SR, dtype=np.float32))
        eng.transcribe(np.zeros(21 * SR, dtype=np.float32))
        check([r["audioCtx"] for r in env.records("transcribe")] == [1024, 1280], "лесенка в работе")


def test_gate_ladder_fast():
    with scaled() as env:
        env.set(devices=[AMD_OLD], lat=lat(full0=80, l1024=25, l1280=30))
        eng, cpu, why, info = env.open(cpu_lat=0.5)
        check(eng is not None and info["tier"] == "ladder", f"{why} {info}")
        check(eng.caps == vulkan.LADDER_CAPS and eng.caps.backoff == 0, f"caps {eng.caps}")
        check(FakeCpu.created == 0, "при быстрой лесенке процессор не меряют")


def test_gate_cpu_when_not_faster():
    with scaled() as env:
        env.set(devices=[AMD_OLD], lat=lat(full0=140, l1024=100, l1280=110))
        eng, cpu, why, info = env.open(cpu_lat=0.14)
        check(eng is None and info["tier"] == "cpu", f"{info}")
        check("не быстрее процессора" in why, why)
        check(isinstance(cpu, FakeCpu) and FakeCpu.created == 1, "процессор грузили дважды или не отдали")
        check(not [p for p in env.engines], "движок Vulkan не должен остаться")


def test_select_engine_reason_and_info():
    with scaled() as env:
        env.set(devices=[AMD_OLD], lat=lat(full0=140, l1024=100, l1280=110))
        saved = (engines.cuda_devices, engines.Engine)

        class CpuEngine(FakeCpu):
            def __init__(self, model, device, compute_type, language, glossary=""):
                super().__init__(0.14)

            def warm_up(self):
                pass

        engines.cuda_devices = lambda: 0
        engines.Engine = CpuEngine
        try:
            e, reason = engines.select_engine("auto", MODEL_DIR, "ru", "int8_float16", "", lambda m: None,
                                              vk_helper=STUB, ggml_model=env.model, cache_dir=env.cache,
                                              noise=asr.looks_like_noise, event=env.event)
            check(isinstance(e, CpuEngine) and FakeCpu.created == 1, "процессорный движок не переиспользован")
            check(reason.startswith("нет видеокарты NVIDIA с CUDA; Vulkan: видеокарта не быстрее"), reason)
            check(e.vulkan_info["tier"] == "cpu", f"{e.vulkan_info}")
            # Без пакета — как раньше
            e, reason = engines.select_engine("auto", MODEL_DIR, "ru", "x", "", lambda m: None)
            check(reason == "нет видеокарты NVIDIA с CUDA" and e.vulkan_info is None, reason)
            # Кэш: второй старт — сразу процессор, без загрузки модели в помощник
            env.reset_log()
            e, reason = engines.select_engine("auto", MODEL_DIR, "ru", "x", "", lambda m: None, vk_helper=STUB,
                                              ggml_model=env.model, cache_dir=env.cache, event=env.event)
            check(e.vulkan_info["cached"] and not env.records("load"), f"{e.vulkan_info} {env.records('load')}")
            try:
                engines.select_engine("vulkan", MODEL_DIR, "ru", "x", "", lambda m: None, vk_helper=None,
                                      ggml_model=None, event=env.event)
                raise AssertionError("vulkan без пакета должен падать")
            except EngineError as ex:
                check(ex.code == "no-vulkan", ex.code)
        finally:
            engines.cuda_devices, engines.Engine = saved


def test_fa_on_too_slow_reloads_without_fa():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=100, full0=120, l1024=25, l1280=30))
        eng, cpu, why, info = env.open()
        check(eng is not None and info["tier"] == "ladder" and eng.flash_attn is False, f"{why} {info}")
        check([r["flashAttn"] for r in env.records("load")] == [True, False], "перезагрузка без FA")
        rows = env.records()
        fa_on = True
        for r in rows:
            if r["type"] == "load":
                fa_on = r["flashAttn"]
            elif r["type"] == "transcribe" and fa_on:
                check(r["audioCtx"] == 0, f"с FA запрос с окном {r['audioCtx']}")


def test_garbage_with_fa_retries_without():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15, full0=15), garbage="fa")
        eng, cpu, why, info = env.open()
        check(eng is not None and info["tier"] == "fast" and info["flashAttn"] is False, f"{why} {info}")
        check([r["flashAttn"] for r in env.records("load")] == [True, False], "без FA не перезагрузили")
        check(any(e.get("step") == "full" and e.get("problem") for e in env.events), "причина не в логе")


def test_garbage_everywhere_is_cpu_or_error():
    with scaled() as env:
        env.set(devices=[NVIDIA], garbage="all")
        eng, cpu, why, info = env.open()
        check(eng is None and "искажён" in why, why)
        try:
            env.open(forced=True)
            raise AssertionError("vulkan принудительно с мусором должен падать")
        except EngineError as ex:
            check(ex.code == "no-vulkan" and "искажён" in ex.message, ex.message)


def test_crash_with_fa_during_gate():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full0=15), crash_fa=True)
        eng, cpu, why, info = env.open()
        check(eng is not None and info["flashAttn"] is False and info["tier"] == "fast", f"{why} {info}")
        check(len(env.records("start")) == 2, "после аварии с FA нужен новый процесс")


def test_cache_reuse_and_key_change():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15))
        eng, _, _, info = env.open()
        check(not info["cached"], "первый старт — проверка")
        eng.close()
        env.reset_log()
        eng, _, _, info = env.open()
        check(eng is not None and info["cached"] and info["tier"] == "fast", f"{info}")
        check(len(env.records("transcribe")) == 3, f"по кэшу только сверка текста: {len(env.records('transcribe'))}")
        check(abs(eng.warm_up_s - info["tFullMs"] / 1000) < 1e-3, "оценка стоимости из кэша")
        eng.close()
        env.reset_log()
        env.update(devices=[{**NVIDIA, "driverVersion": "611.00"}])
        eng, _, _, info = env.open()
        check(not info["cached"] and len(env.records("transcribe")) == vulkan.WARM_CALLS + 1, "новый драйвер — новая проверка")
        eng.close()
        # Другой путь шейдеров (например, выключен coopmat) — тоже новая проверка
        env.reset_log()
        env.update(devices=[{**NVIDIA, "driverVersion": "611.00", "coopmat": False}])
        eng, _, _, info = env.open()
        check(not info["cached"], "смена coopmat — новая проверка")
        eng.close()
        # Кэш соврал (текст теперь мусор) — полная проверка, итог честный
        env.reset_log()
        env.update(garbage="all")
        eng, _, why, info = env.open()
        check(eng is None and "искажён" in why, f"{why} {info}")


def test_crash_mid_session_falls_back_and_is_remembered():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15))
        eng, _, _, _ = env.open()
        pid = eng.helper.pid
        proc = eng.helper.proc
        env.update(crash=True)
        text, dur = eng.transcribe(np.zeros(3 * SR, dtype=np.float32))
        check(text == "процессор" and eng.device == "cpu" and eng.caps == CPU_CAPS, f"{text} {eng.device}")
        check(eng.epoch == 1 and eng.label.endswith("процессор"), eng.label)
        check(proc.poll() == 7, f"код выхода помощника {proc.poll()} (pid {pid})")
        names = [e["event"] for e in env.events]
        check("vulkan-failed" in names and "engine-fallback" in names, names)
        text, _ = eng.transcribe(np.zeros(SR, dtype=np.float32))
        check(text == "процессор" and FakeCpu.created == 1, "процессор грузится один раз")
        check(eng.set_terms(["СКД"])["kept"] == 1, "словарь после перехода")
        # Следующий старт — сразу процессор, помощнику модель не даём
        env.update(crash=False)
        env.reset_log()
        e2, cpu, why, info = env.open()
        check(e2 is None and "сбоила в прошлый раз" in why and not env.records("load"), f"{why}")
        # Принудительный Vulkan флаг не слушает
        e3, _, _, info = env.open(forced=True)
        check(e3 is not None and e3.device == "vulkan", "vulkan принудительно")


def test_timeout_mid_session_falls_back():
    saved = vulkan.RUNTIME_TIMEOUT_S
    vulkan.RUNTIME_TIMEOUT_S = 0.5
    try:
        with scaled() as env:
            env.set(devices=[NVIDIA], lat=lat(full1=15))
            eng, _, _, _ = env.open()
            proc = eng.helper.proc
            env.update(hang=True)
            started = time.monotonic()
            text, _ = eng.transcribe(np.zeros(2 * SR, dtype=np.float32))
            check(text == "процессор" and time.monotonic() - started < 5, "таймаут не сработал")
            check(proc.poll() is not None, "зависший помощник не убит")
            failed = [e for e in env.events if e["event"] == "vulkan-failed"]
            check(failed and "не ответила" in failed[0]["reason"], f"{failed}")
    finally:
        vulkan.RUNTIME_TIMEOUT_S = saved


def test_gate_hang_respects_total_deadline():
    saved = vulkan.GATE_TOTAL_S
    vulkan.GATE_TOTAL_S = 1.0
    try:
        with scaled() as env:
            env.set(devices=[NVIDIA], hang=True)
            started = time.monotonic()
            eng, _, why, info = env.open()
            check(eng is None and time.monotonic() - started < 6, f"проверка висела {time.monotonic() - started:.1f} с")
            check("не уложилась" in why or "не ответил" in why, why)
    finally:
        vulkan.GATE_TOTAL_S = saved


def test_slow_finals_watchdog():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15))
        eng, _, _, info = env.open()
        est = eng._estimate_ms(5.63)
        check(est and est < vulkan.MID_MS / 3, f"оценка {est}")
        for _ in range(vulkan.WATCH_FINALS * 2):
            eng.note_final(5.63, est * 3 / 1000)
        check(eng._degraded is None, "втрое медленнее, но дешевле порога MID — видеокарта всё ещё лучше процессора")
        slow = vulkan.MID_MS * 1.5 / 1000
        for _ in range(vulkan.WATCH_FINALS - 3):
            eng.note_final(5.63, slow)
        check(eng._degraded is None, "рано: медиана по последним финалам ещё не сдвинулась")
        for _ in range(3):
            eng.note_final(5.63, slow)
        check(eng._degraded is not None, "медиана выше оценки вдвое и выше порога — должен сработать")
        check(eng.device == "vulkan", "переход — в следующем transcribe, не в event loop")
        text, _ = eng.transcribe(np.zeros(SR, dtype=np.float32))
        check(eng.device == "cpu", "не перешёл на процессор")
        entry = vulkan.GateCache(env.cache).get(eng.key)
        check(entry and not entry.get("failed"), "медленность не сбой: флаг не ставим")
        forced, _, _, _ = env.open(forced=True)
        for _ in range(10):
            forced.note_final(5.63, 10.0)
        check(forced._degraded is None, "принудительный Vulkan по скорости не уходит")


def age_gates(env, seconds: float) -> None:
    """Сдвинуть все отметки времени кэша проверки в прошлое — как будто прошло seconds."""
    def fn(data):
        for entry in data.get("gates", {}).values():
            for k in ("at", "failedAt"):
                if isinstance(entry.get(k), (int, float)):
                    entry[k] -= seconds
    vulkan.GateCache(env.cache)._update(fn)


def only_gate(env) -> dict:
    gates = vulkan.GateCache(env.cache)._read().get("gates", {})
    check(len(gates) == 1, f"в кэше {len(gates)} итогов")
    return next(iter(gates.values()))


def test_gate_crash_is_retried_not_cpu_forever():
    with scaled() as env:
        # Разовая авария на проверке (и с FA, и без) — не замер скорости
        env.set(devices=[NVIDIA], lat=lat(full1=15), crash=True)
        eng, _, why, info = env.open()
        check(eng is None and info["tier"] == "cpu" and "сбоил на проверке" in why, why)
        entry = only_gate(env)
        check(entry.get("failed") and entry.get("fails") == 1 and entry.get("tier") is None, f"{entry}")
        # Драйвер в порядке, но пауза не вышла — процессор без прогонов, с обещанием повтора
        env.update(crash=False)
        env.reset_log()
        eng, _, why, info = env.open()
        # Дата повтора — сутки после сбоя, в абсолютном виде «ДД.ММ после ЧЧ:ММ»
        check(eng is None and info["cached"] and RETRY_AT.search(why) and not env.records("load"), why)
        # Прошли сутки — полная проверка, итог FAST; история сбоя осталась
        age_gates(env, vulkan.FAILED_RETRY_S + 60)
        eng, _, why, info = env.open()
        check(eng is not None and info["tier"] == "fast" and not info["cached"], f"{why} {info}")
        check(any(e.get("retry") == "после сбоя" for e in env.events), "повтор после сбоя не залогирован")
        entry = only_gate(env)
        check(not entry.get("failed") and entry.get("fails") == 1 and entry.get("tier") == "fast", f"{entry}")
        # Снова авария посреди сессии — счёт 2, пауза вдвое длиннее
        env.update(crash=True)
        eng.transcribe(np.zeros(SR, dtype=np.float32))
        entry = only_gate(env)
        check(entry.get("failed") and entry.get("fails") == 2, f"{entry}")
        env.update(crash=False)
        _, _, why, _ = env.open()
        check(RETRY_AT.search(why) and vulkan.retry_at_ru(vulkan.fail_history(only_gate(env))["failedAt"] + vulkan.failed_retry_s(2)) in why, why)
        age_gates(env, vulkan.FAILED_RETRY_S + 60)
        _, _, why, info = env.open()
        check(info["cached"] and "сбоила в прошлый раз" in why, f"сутки после второго сбоя — рано: {why}")
        # Второй сбой был больше месяца назад — третий считается первым
        age_gates(env, vulkan.FAILED_RETRY_MAX_S)
        eng, _, why, info = env.open()
        check(eng is not None and info["tier"] == "fast", f"{why}")
        env.update(crash=True)
        eng.transcribe(np.zeros(SR, dtype=np.float32))
        check(only_gate(env).get("fails") == 1, f"{only_gate(env)}")


def test_old_cache_failure_flag_and_retry_schedule():
    check(vulkan.failed_retry_s(1) == vulkan.FAILED_RETRY_S, "первый сбой — сутки")
    check(vulkan.failed_retry_s(3) == 4 * vulkan.FAILED_RETRY_S, "третий — четверо суток")
    check(vulkan.failed_retry_s(50) == vulkan.FAILED_RETRY_MAX_S, "не дольше месяца")
    check(vulkan.span_ru(600) == "час" and vulkan.span_ru(23.2 * 3600) == "24 ч" and vulkan.span_ru(70 * 3600) == "3 дн.",
          "подписи паузы")
    # Флаг первой версии кэша: только failed и at
    check(vulkan.fail_history({"failed": True, "at": 100.0}) == {"fails": 1, "failedAt": 100.0}, "старый флаг — один сбой")
    check(vulkan.fail_history({"tier": "fast", "at": 5}) == {}, "без сбоев истории нет")
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15))
        eng, _, _, _ = env.open()
        key = eng.key
        eng.close()
        # Сверка по кэшу не прошла — итог забыт, история сбоев нет: запись уходит целиком
        cache = vulkan.GateCache(env.cache)
        cache.drop(key)
        check(cache.get(key) is None, "без истории запись удаляется")
        cache.mark_failed(key, "тест", {})
        cache.drop(key)
        kept = cache.get(key)
        check(kept and kept.get("fails") == 1 and not kept.get("failed") and "tier" not in kept, f"{kept}")
        # Запись только с историей — не итог: следующий старт проверяет полностью
        env.reset_log()
        eng, _, _, info = env.open()
        check(eng is not None and not info["cached"] and len(env.records("transcribe")) == vulkan.WARM_CALLS + 1, f"{info}")


def test_cpu_verdict_expires():
    with scaled() as env:
        env.set(devices=[AMD_OLD], lat=lat(full0=140, l1024=100, l1280=110))
        eng, _, why, info = env.open(cpu_lat=0.14)
        check(eng is None and "не быстрее процессора" in why and not only_gate(env).get("failed"), why)
        env.reset_log()
        _, _, why, info = env.open(cpu_lat=0.14)
        check(info["cached"] and not env.records("load"), "свежий итог «процессор» — без проверки")
        # Видеокарту на старте занимала игра; через три дня она свободна
        age_gates(env, vulkan.CPU_VERDICT_TTL_S + 60)
        env.update(lat=lat(full0=140, l1024=20, l1280=30))
        eng, _, why, info = env.open(cpu_lat=0.14)
        check(eng is not None and info["tier"] == "ladder" and not info["cached"], f"{why} {info}")


def test_unavailable_reasons():
    with scaled() as env:
        env.set(vulkanLoader=False)
        eng, _, why, info = env.open()
        check(eng is None and why == "нет драйвера Vulkan" and info["tier"] == "cpu", why)
        env.set(devices=[{"index": 0, "name": "Microsoft Basic Render Driver", "type": "other"}])
        _, _, why, _ = env.open()
        check(why == "нет видеокарты с Vulkan", why)
        env.set(cpuOk=False)
        _, _, why, _ = env.open()
        check("AVX2" in why, why)
        env.set(devices=[NVIDIA], load_error="load-failed")
        _, _, why, _ = env.open()
        check("сбоил" in why and "load-failed" in why, why)
        r = vulkan.open_engine(forced=False, vk_helper=None, ggml_model=env.model, whisper_model=MODEL_DIR,
                               cache_dir=None, language="ru", glossary="", cpu_factory=FakeCpu, event=env.event)
        check(r[0] is None and "пакет не установлен" in r[2], r[2])
        try:
            env.set(vulkanLoader=False)
            env.open(forced=True)
            raise AssertionError("должна быть ошибка")
        except EngineError as ex:
            check(ex.code == "no-vulkan", ex.code)


def test_loop_output_is_dropped():
    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15), text="СКД, КД, " * 40)
        eng, _, _, _ = env.open()
        text, _ = eng.transcribe(np.zeros(4 * SR, dtype=np.float32))
        check(text == "", f"зацикливание дошло: {text[:40]}")


def test_transcriber_follows_vulkan_windows():
    with scaled() as env:
        env.set(devices=[AMD_OLD], lat=lat(full0=100, l1024=70, l1280=80))
        eng, _, _, _ = env.open(cpu_lat=0.2)
        tr = asr.Transcriber(eng)
        check(tr.idle_partials, "MID — черновики в простое")
        check(abs(tr._window(5.0) - 20.48) < 1e-9 and abs(tr._window(21.0) - 25.6) < 1e-9, "окна лесенки")
        check(abs(tr._window(24.0) - 30) < 1e-9, "полное окно")
        check(list(tr._cost) == [20.48] and abs(tr._cost[20.48] - eng.warm_up_s) < 1e-9, f"{tr._cost}")
        env.update(crash=True)
        eng.transcribe(np.zeros(SR, dtype=np.float32))
        tr._follow_engine()
        check(list(tr._cost) == [10] and tr._cost[10] == 0.9, f"оценки не сброшены: {tr._cost}")


async def test_main_ready_reports_vulkan():
    """asr.main() с Vulkan-движком: ready несёт device=vulkan и итог проверки, health — устройство."""
    import io
    import socket
    import types

    import websockets

    with scaled() as env:
        env.set(devices=[NVIDIA], lat=lat(full1=15))
        saved = (asr.select_engine, asr.HEALTH_EVERY_S, sys.modules.get("audio_loopback"), os.environ.get("COPILOT_NO_SILERO"))
        seen: dict = {}

        def fake_select(*a, **k):
            seen.update(k)
            return engines.select_engine(*a, **k)

        loop_mod = types.ModuleType("audio_loopback")

        class LoopbackCapture:
            device_name = "stub"
            error = None

            def __init__(self, cb):
                pass

            def start(self):
                pass

        loop_mod.LoopbackCapture = LoopbackCapture
        asr.select_engine = fake_select
        asr.HEALTH_EVERY_S = 0.3
        sys.modules["audio_loopback"] = loop_mod
        os.environ["COPILOT_NO_SILERO"] = "1"
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        out = io.StringIO()
        server = None
        try:
            with contextlib.redirect_stdout(out):
                ns = types.SimpleNamespace(port=port, token="tok", model=MODEL_DIR, compute_type="x", language="ru",
                                           glossary="", device="vulkan", probe=False, vk_helper=STUB,
                                           ggml_model=env.model, cache_dir=env.cache)
                server = asyncio.create_task(asr.main(ns))
                for _ in range(200):
                    try:
                        ws = await websockets.connect(f"ws://127.0.0.1:{port}/?ch=them&token=tok", ping_interval=None)
                        break
                    except OSError:
                        await asyncio.sleep(0.05)
                else:
                    raise AssertionError("сайдкар не поднялся")
                msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
                check(msg["type"] == "health" and msg["device"] == "vulkan", f"health: {msg}")
                await ws.close()
                await asyncio.sleep(0.2)  # ws-closed сайдкара — ещё в перехваченный stdout
        finally:
            if server is not None:
                server.cancel()
                with contextlib.suppress(BaseException):
                    await server
            asr.select_engine, asr.HEALTH_EVERY_S = saved[0], saved[1]
            if saved[2] is None:
                sys.modules.pop("audio_loopback", None)
            else:
                sys.modules["audio_loopback"] = saved[2]
            if saved[3] is None:
                os.environ.pop("COPILOT_NO_SILERO", None)
        check(seen.get("noise") is asr.looks_like_noise and seen.get("vk_helper") == STUB, f"аргументы: {seen}")
        lines = [json.loads(x) for x in out.getvalue().splitlines() if x.startswith("{")]
        ready = [x for x in lines if x.get("ready")]
        check(ready and ready[0]["device"] == "vulkan" and ready[0]["vulkan"]["tier"] == "fast", f"ready: {ready}")
        check(ready[0]["fallbackReason"] == "Vulkan выбран вручную" and "(Vulkan)" in ready[0]["label"], f"{ready[0]}")
        check(any(x.get("event") == "vulkan-gate" for x in lines), "проверка не залогирована")


TESTS = [
    test_ladder_ctx_and_max_tokens,
    test_flash_attn_policy,
    test_text_checks,
    test_prompt_tokens_match_production,
    test_gate_fast_nvidia,
    test_gate_amd_mid,
    test_gate_ladder_fast,
    test_gate_cpu_when_not_faster,
    test_select_engine_reason_and_info,
    test_fa_on_too_slow_reloads_without_fa,
    test_garbage_with_fa_retries_without,
    test_garbage_everywhere_is_cpu_or_error,
    test_crash_with_fa_during_gate,
    test_cache_reuse_and_key_change,
    test_crash_mid_session_falls_back_and_is_remembered,
    test_timeout_mid_session_falls_back,
    test_gate_hang_respects_total_deadline,
    test_slow_finals_watchdog,
    test_gate_crash_is_retried_not_cpu_forever,
    test_old_cache_failure_flag_and_retry_schedule,
    test_cpu_verdict_expires,
    test_unavailable_reasons,
    test_loop_output_is_dropped,
    test_transcriber_follows_vulkan_windows,
    test_main_ready_reports_vulkan,
]


def main() -> int:
    if not os.path.isfile(os.path.join(MODEL_DIR, "tokenizer.json")):
        print(f"нет токенизатора: {MODEL_DIR}", flush=True)
        return 2
    only = sys.argv[1:]
    failed = 0
    for fn in TESTS:
        if only and not any(o in fn.__name__ for o in only):
            continue
        started = time.perf_counter()
        try:
            if inspect.iscoroutinefunction(fn):
                asyncio.run(fn())
            else:
                fn()
            print(f"ok    {fn.__name__} ({time.perf_counter() - started:.1f} с)", flush=True)
        except Exception:
            failed += 1
            print(f"FAIL  {fn.__name__}", flush=True)
            traceback.print_exc()
    print("всё прошло" if not failed else f"упало: {failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
