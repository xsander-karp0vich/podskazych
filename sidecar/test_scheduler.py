"""
Очередь распознавания без модели: настоящие Pipeline, Transcriber, CrossTalk
и Hub из asr.py, а вместо Whisper — заглушка с заданной задержкой и сбоями.

Время подменено: asr.time отдаёт часы теста, и тест двигает их сам, по 50 мс
звука за шаг. Поэтому полминуты разговора проходят за секунды, а порядок
событий не зависит от того, чем занята машина. Два теста идут в реальном
времени: что feed не ждёт модель по-настоящему, и сквозной — asr.main()
с настоящим websockets.

Речь здесь — шум на −20 dBFS, тишина — нули, решает порог по громкости
(gate=None): Silero на шуме речи не услышит, а проверяем мы очередь, не его.

Запуск: python -E -s -X utf8 sidecar/test_scheduler.py
"""
from __future__ import annotations

import asyncio
import contextlib
import inspect
import io
import json
import os
import socket
import sys
import time
import traceback
import types
from collections import deque
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import engines  # noqa: E402  (первым, как в asr.py)
from engines import Caps  # noqa: E402

import asr  # noqa: E402

REAL_TIME = asr.time
SR = asr.SAMPLE_RATE
CHUNK = 800          # столько шлёт pcm-worklet.js
STEP = CHUNK / SR    # 50 мс
ZERO = np.zeros(CHUNK, dtype=np.float32)

CUDA = Caps(partial_every_ms=700, max_utterance_ms=30_000)
CPU = Caps(partial_every_ms=1500, max_utterance_ms=engines.CPU_MAX_UTTERANCE_MS, backoff=3.0, min_partial_ms=1500)

_rng = np.random.default_rng(7)


def speech(s: float, amp: float = 0.1) -> np.ndarray:
    return (_rng.standard_normal(int(round(s * SR))) * amp).astype(np.float32)


def silence(s: float) -> np.ndarray:
    return np.zeros(int(round(s * SR)), dtype=np.float32)


def track(*parts: np.ndarray) -> np.ndarray:
    return np.concatenate(parts)


WORDS = "раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать".split()


def growing(kind, ch, k, audio_s):
    """Гипотеза растёт с буфером, как у настоящей модели: префиксы совпадают."""
    n = max(1, min(len(WORDS), int(audio_s * 1.5)))
    return " ".join(WORDS[:n]), audio_s


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def monotonic(self) -> float:
        return self.t


class Stub:
    """Модель-заглушка. latency и texts — числа или функции (kind, ch, …)."""

    name = "stub"
    label = "stub"
    compute_type = "x"

    def __init__(self, caps, clock=None, device="cuda", latency=0.3, texts=None, fail=None, warm_up_s=0.0):
        self.caps = caps
        self.clock = clock
        self.device = device
        self.latency = latency
        self.texts = texts or growing
        self.fail = fail
        self.warm_up_s = warm_up_s
        self.tr = None
        self.runs: list = []
        self.busy = False
        self.deadline = 0.0
        self.abort = False
        self.terms_fail = False

    def set_terms(self, terms):
        if self.terms_fail:
            raise RuntimeError("словарь сломан (тест)")
        return {"kept": len(terms), "total": len(terms), "tokens": 0}

    def _now(self):
        return self.clock.t if self.clock else time.monotonic()

    def transcribe(self, audio):
        job = self.tr._running
        kind = "final" if isinstance(job, asr._Final) else "partial"
        ch = job.pipe.channel
        audio_s = audio.size / SR
        k = sum(1 for r in self.runs if r["kind"] == kind and r["ch"] == ch)
        lat = self.latency(kind, ch, audio_s) if callable(self.latency) else self.latency
        rec = {"kind": kind, "ch": ch, "start": self._now(), "end": None, "audio_s": audio_s, "k": k}
        self.runs.append(rec)
        self.busy = True
        try:
            if self.clock is not None:
                self.deadline = rec["start"] + lat
                while self.clock.t < self.deadline - 1e-6 and not self.abort:
                    time.sleep(0.0002)
            else:
                time.sleep(lat)
            rec["end"] = self._now()
            if self.fail is not None and self.fail(kind, ch, k):
                raise RuntimeError("CUDA failed with error out of memory (тест)")
            return self.texts(kind, ch, k, audio_s)
        finally:
            self.busy = False


SIMS: list = []


class Sim:
    """Два канала на настоящих Pipeline/Transcriber, время — часы теста."""

    def __init__(self, caps, *, latency=0.3, texts=None, fail=None, cross=True, device="cuda",
                 warm_up_s=0.0, emit=None):
        self.clock = Clock()
        asr.time = self.clock
        self.eng = Stub(caps, self.clock, device, latency, texts, fail, warm_up_s)
        SIMS.append(self)
        self.tr = asr.Transcriber(self.eng)
        self.eng.tr = self.tr
        self.cross = asr.CrossTalk() if cross else None
        self.events: list = []
        self.submits: list = []
        emit = emit or self.record
        self.me = asr.Pipeline("me", self.tr, emit, self.clock.t, cross=self.cross,
                               vad_threshold=asr.VAD_RMS_DBFS_MIC, gate=None)
        self.them = asr.Pipeline("them", self.tr, emit, self.clock.t, cross=self.cross, gate=None)
        orig = self.tr.submit_final

        def submit(pipe, *a):
            busy = bool(self.tr._partials) or self.tr._running is not None
            self.submits.append({"t": self.clock.t, "ch": pipe.channel, "busy": busy})
            orig(pipe, *a)

        self.tr.submit_final = submit
        self.tracks = {"me": None, "them": None}
        self.pos = {"me": 0, "them": 0}
        self.worst_feed = 0.0

    async def record(self, kind, ch, text, start_ms, db=None):
        if kind != "level":
            self.events.append({"t": self.clock.t, "kind": kind, "ch": ch, "text": text, "startMs": start_ms})

    async def settle(self) -> None:
        tr, eng = self.tr, self.eng
        if (tr._finals or tr._ready) and tr._wake is not None:
            # Финалы, ждущие сверки, пересматриваются по таймеру в реальном
            # времени, а срок у них — по часам теста. Будим воркер сами.
            tr._wake.set()
        for _ in range(50000):
            await asyncio.sleep(0)
            if tr._running is not None:
                if eng.busy and eng.deadline > self.clock.t + 1e-6:
                    return
                await asyncio.sleep(0.0005)
                continue
            if tr._wake is not None and tr._wake.is_set():
                continue
            return
        raise AssertionError("очередь не устаканилась")

    async def play(self, seconds: float, me=None, them=None) -> None:
        if me is not None:
            self.tracks["me"], self.pos["me"] = me, 0
        if them is not None:
            self.tracks["them"], self.pos["them"] = them, 0
        for _ in range(int(round(seconds / STEP))):
            self.clock.t = round(self.clock.t + STEP, 6)
            for pipe in (self.me, self.them):
                ch = pipe.channel
                src, p = self.tracks[ch], self.pos[ch]
                chunk = src[p:p + CHUNK] if src is not None else ZERO
                if chunk.size < CHUNK:
                    chunk = np.pad(chunk, (0, CHUNK - chunk.size))
                self.pos[ch] = p + CHUNK
                started = time.perf_counter()
                await pipe.feed(chunk, self.clock.t)
                self.worst_feed = max(self.worst_feed, time.perf_counter() - started)
            await self.settle()

    async def until_idle(self, limit_s: float = 60.0) -> None:
        for _ in range(int(limit_s / STEP)):
            tr = self.tr
            if not (tr._finals or tr._ready or tr._running or tr._partials or self.me.speaking or self.them.speaking):
                return
            await self.play(STEP)
        raise AssertionError("очередь не опустела")

    def rel(self, t: float) -> float:
        return round(t - 1000.0, 3)

    def runs(self, kind=None, ch=None) -> list:
        return [r for r in self.eng.runs if (kind is None or r["kind"] == kind) and (ch is None or r["ch"] == ch)]

    def ev(self, kind=None, ch=None) -> list:
        return [e for e in self.events if (kind is None or e["kind"] == kind) and (ch is None or e["ch"] == ch)]

    async def close(self) -> None:
        self.eng.abort = True
        await self.tr.aclose()


def check(cond, msg) -> None:
    if not cond:
        raise AssertionError(msg)


# --------------------------------------------------------------------------- тесты


async def test_feed_never_blocks_while_model_runs():
    """Реальное время: прогон 1.5 с, а feed каждого чанка укладывается в миллисекунды."""
    eng = Stub(CPU, clock=None, device="cpu", latency=1.5, texts=lambda *a: ("проверка связи", a[-1]))
    tr = asr.Transcriber(eng)
    eng.tr = tr
    got = []

    async def emit(kind, ch, text, start_ms, db=None):
        if kind != "level":
            got.append((kind, ch, text))

    me = asr.Pipeline("me", tr, emit, time.monotonic(), vad_threshold=asr.VAD_RMS_DBFS_MIC, gate=None)
    audio = track(speech(1.0), silence(1.2), speech(1.0), silence(1.6))
    worst, during_run = 0.0, 0
    t_start = time.monotonic()
    for i in range(0, audio.size, CHUNK):
        due = t_start + (i + CHUNK) / SR
        await asyncio.sleep(max(0.0, due - time.monotonic()))
        started = time.perf_counter()
        await me.feed(audio[i:i + CHUNK], time.monotonic())
        worst = max(worst, time.perf_counter() - started)
        during_run += eng.busy
    behind = time.monotonic() - t_start - audio.size / SR
    for _ in range(80):
        if sum(1 for k, *_ in got if k == "final") >= 2:
            break
        await asyncio.sleep(0.1)
    await tr.aclose()
    check(worst < 0.05, f"feed держал {worst:.3f} с")
    check(during_run >= 20, f"пока модель считала, скормлено всего {during_run} чанков")
    check(behind < 0.3, f"подача отстала на {behind:.2f} с")
    check(me.lag_max < 0.05, f"lagS {me.lag_max:.3f}")
    check([t for k, c, t in got if k == "final"] == ["проверка связи"] * 2, f"финалы: {got}")


async def test_finals_go_before_partials():
    """Финал, закрытый пока крутятся черновики, запускается следующим."""
    sim = Sim(CUDA, cross=False, latency=lambda kind, ch, a: 0.5 if kind == "partial" else 0.3)
    try:
        await sim.play(6.0, me=track(silence(0.5), speech(1.0), silence(4.5)), them=track(speech(5.0), silence(1.0)))
        await sim.until_idle()
        me_submit = next(s for s in sim.submits if s["ch"] == "me")
        check(me_submit["busy"], "к закрытию реплики модель должна быть занята черновиками")
        after = [r for r in sim.eng.runs if r["start"] >= me_submit["t"] - 1e-9]
        check(after and after[0]["kind"] == "final" and after[0]["ch"] == "me",
              f"следующим после закрытия шёл {after[0] if after else None}")
        check(any(r["kind"] == "partial" and r["ch"] == "them" for r in after[1:]),
              "черновики собеседника должны продолжиться после финала")
    finally:
        await sim.close()


async def test_stale_partial_is_dropped():
    """Черновик, досчитанный после закрытия реплики, не показывается."""
    sim = Sim(CUDA, cross=False, latency=lambda kind, ch, a: 0.9 if kind == "partial" else 0.3)
    try:
        await sim.play(4.0, me=track(speech(1.2), silence(2.8)))
        await sim.until_idle()
        submit = next(s for s in sim.submits if s["ch"] == "me")
        straddle = [r for r in sim.runs("partial", "me") if r["start"] < submit["t"] < r["end"]]
        check(straddle, f"сценарий не сложился: черновики {sim.runs('partial', 'me')}, закрытие {submit}")
        final = sim.ev("final", "me")[0]
        late = [e for e in sim.ev("partial", "me") if e["t"] >= final["t"] - 1e-9 or e["t"] > submit["t"]]
        check(not late, f"черновик после закрытия: {late}")
        run = sim.runs("final", "me")[0]
        check(run["start"] >= straddle[0]["end"] - 1e-9, "финал не может обогнать уже идущий прогон")
    finally:
        await sim.close()


async def test_cuda_partial_cadence_from_run_start():
    """CUDA: ритм черновиков 700 мс от начала прогона, как до очереди; прогон дольше
    интервала не тянет за собой следующий вплотную — старая ловушка «по прогону на чанк»."""
    rest = asr.PARTIAL_REST_MS / 1000
    for latency in (0.2, 0.4, 1.0):
        sim = Sim(CUDA, cross=False, latency=latency)
        try:
            await sim.play(9.5, me=track(speech(8.0), silence(1.5)))
            await sim.until_idle()
            parts = sim.runs("partial", "me")
            period = max(0.7, latency + rest)
            check(len(parts) >= 8.0 / (period + 0.05) - 2, f"L={latency}: мало черновиков {len(parts)}")
            starts = [round(b["start"] - a["start"], 3) for a, b in zip(parts, parts[1:])]
            rests = [round(b["start"] - a["end"], 3) for a, b in zip(parts, parts[1:])]
            if latency + rest <= 0.7:
                check(all(0.7 - 1e-6 <= g <= 0.75 + 1e-6 for g in starts), f"L={latency}: ритм {starts}")
            else:
                check(all(rest - 1e-6 <= g <= rest + 0.05 + 1e-6 for g in rests), f"L={latency}: паузы {rests}")
            check(len(sim.ev("partial", "me")) >= 3, f"L={latency}: показано {len(sim.ev('partial', 'me'))}")
            finals = sim.ev("final", "me")
            check(len(finals) == 1 and finals[0]["text"], f"L={latency}: финалы {finals}")
            speech_end = 1000.0 + 8.0
            check(finals[0]["t"] - speech_end <= 1.0 + latency * 2 + 0.2,
                  f"L={latency}: финал через {finals[0]['t'] - speech_end:.2f} с")
        finally:
            await sim.close()


async def test_cpu_partial_shown_immediately():
    """Процессор: первая же гипотеза показывается, без второй сверки."""
    sim = Sim(CPU, cross=False, device="cpu", latency=1.0, warm_up_s=1.0)
    try:
        await sim.play(8.0, me=track(speech(6.0), silence(2.0)))
        await sim.until_idle()
        parts = sim.runs("partial", "me")
        check(parts, "черновиков нет")
        first = parts[0]
        check(first["audio_s"] >= 1.5 - 1e-6, f"черновик раньше min_partial_ms: {first}")
        shown = sim.ev("partial", "me")
        check(shown and abs(shown[0]["t"] - first["end"]) < 1e-6, f"показан не сразу: {shown[:1]} vs {first}")
        check(shown[0]["text"] == growing("partial", "me", 0, first["audio_s"])[0], f"текст {shown[0]}")
        gaps = [round(b["start"] - a["end"], 3) for a, b in zip(parts, parts[1:])]
        check(all(g >= 1.5 - 1e-6 for g in gaps), f"паузы между черновиками {gaps}")
    finally:
        await sim.close()


async def test_cpu_partials_respect_load_and_cut():
    """Процессор: черновик не стартует при загрузке ≥ 0.5 за 12 с и если не успеет до обрезки."""
    lat = 3.0
    sim = Sim(CPU, cross=False, device="cpu", latency=lat, warm_up_s=lat)
    try:
        await sim.play(20.0, me=track(speech(18.0), silence(2.0)))
        await sim.until_idle()
        runs = sim.eng.runs
        parts = sim.runs("partial", "me")
        check(len(parts) >= 2, f"черновиков {len(parts)}")
        max_s = CPU.max_utterance_ms / 1000
        for p in parts:
            s = p["start"]
            busy = sum(max(0.0, min(r["end"], s) - max(r["start"], s - 12.0)) for r in runs if r["end"] is not None)
            check(busy / 12.0 < 0.5 + 1e-6, f"черновик в {sim.rel(s)} при загрузке {busy / 12:.2f}")
            check(p["audio_s"] + lat < max_s, f"черновик {p['audio_s']:.2f} с не успел бы до обрезки")
        check(len(sim.ev("final", "me")) == 2, f"финалы {sim.ev('final', 'me')}")
    finally:
        await sim.close()


async def test_cpu_partial_waits_for_idle_model():
    """Процессор: пока идёт финал собеседника, черновик микрофона не запускается."""
    sim = Sim(CPU, device="cpu", latency=lambda kind, ch, a: 3.0 if kind == "final" else 0.8, warm_up_s=1.0)
    try:
        await sim.play(12.0, them=track(speech(2.0), silence(10.0)), me=track(silence(2.5), speech(6.5), silence(3.0)))
        await sim.until_idle()
        them_final = sim.runs("final", "them")[0]
        me_parts = sim.runs("partial", "me")
        check(me_parts, "черновиков микрофона нет")
        check(all(p["start"] >= them_final["end"] - 1e-6 for p in me_parts),
              f"черновик во время финала: {me_parts[0]} / {them_final}")
        check(me_parts[0]["start"] - them_final["end"] <= 0.1 + 1e-6,
              f"черновик не стартовал сразу после финала: {sim.rel(me_parts[0]['start'])}")
    finally:
        await sim.close()


async def test_cpu_parked_final_does_not_block_partials():
    """Процессор: финал микрофона поверх идущей реплики собеседника считается сразу,
    а пока ждёт сверки, модель свободна — черновики собеседника идут."""
    sim = Sim(CPU, device="cpu", latency=0.8, warm_up_s=0.8, texts=_echo_texts)
    try:
        await sim.play(12.0, them=track(speech(8.0), silence(4.0)), me=track(silence(1.0), speech(1.0), silence(10.0)))
        await sim.until_idle()
        me_submit = next(s for s in sim.submits if s["ch"] == "me")
        them_submit = next(s for s in sim.submits if s["ch"] == "them")
        me_run = sim.runs("final", "me")[0]
        check(me_run["start"] - me_submit["t"] <= 0.8 + 1e-6, f"финал микрофона стоял в очереди: {me_run} / {me_submit}")
        me_final = sim.ev("final", "me")[0]
        check(me_final["t"] < them_submit["t"], "финал микрофона не должен ждать конца фразы собеседника")
        check(me_final["t"] - me_run["end"] <= asr.ECHO_OPEN_WAIT_S + 0.1, f"сверка ждала {me_final['t'] - me_run['end']:.2f} с")
        check(me_final["text"] == "" and sim.me.echo_dropped == 1, f"эхо сверено с гипотезой собеседника: {me_final}")
        check([r for r in sim.runs("partial", "them") if r["start"] >= me_run["end"] - 1e-6],
              "после финала микрофона черновики собеседника должны идти")
    finally:
        await sim.close()


class FakeWs:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


async def test_empty_final_is_sent():
    hub = asr.Hub()
    ws = FakeWs()
    hub.add("me", ws)
    await hub.send("partial", "me", "", 0)
    await hub.send("final", "me", "", 10)
    check(ws.sent == [{"type": "final", "channel": "me", "text": "", "startMs": 10}], f"ушло {ws.sent}")

    # Весь путь: модель выдала шум, финал пустой, но до клиента он доходит.
    hub = asr.Hub()
    ws = FakeWs()
    hub.add("me", ws)
    sim = Sim(CUDA, cross=False, emit=hub.send,
              texts=lambda kind, ch, k, a: ("Продолжение следует...", a) if kind == "final" else ("раз два", a))
    try:
        await sim.play(3.0, me=track(speech(1.5), silence(1.5)))
        await sim.until_idle()
        finals = [m for m in ws.sent if m["type"] == "final"]
        check(len(finals) == 1 and finals[0]["text"] == "", f"финалы {finals}")
        check(sim.me.empty_finals == 1, f"emptyFinals {sim.me.empty_finals}")
        check(any(m["type"] == "partial" for m in ws.sent), "черновик должен был показаться до пустого финала")
    finally:
        await sim.close()


async def test_exception_in_me_final_keeps_channel():
    out = io.StringIO()
    sim = Sim(CUDA, cross=False, fail=lambda kind, ch, k: kind == "final" and ch == "me" and k == 0)
    try:
        with contextlib.redirect_stdout(out):
            await sim.play(6.0, me=track(speech(1.0), silence(1.5), speech(1.0), silence(2.5)))
            await sim.until_idle()
        errors = [json.loads(line) for line in out.getvalue().splitlines() if line.startswith("{")]
        check(any(e.get("error", "").startswith("me: CUDA failed") for e in errors), f"лог: {out.getvalue()!r}")
        finals = sim.ev("final", "me")
        check(len(finals) == 2 and finals[0]["text"] == "" and finals[1]["text"], f"финалы {finals}")
        check(not sim.tr._worker.done(), "воркер умер")
    finally:
        await sim.close()


def test_echo_rules():
    n = time.monotonic()

    def cross(said, start=0.0, end=2.0):
        c = asr.CrossTalk()
        c.note_them_text(said, n + start, n + end)
        return c

    c = cross("Понятно.", 0.0, 1.0)
    got = c.is_echo("Ну, понятно. А что дальше делать?", n + 0.5, n + 3.0)
    check(got == "А что дальше делать?", f"вырезание эха: {got!r}")

    phrase = "Да, конечно, я сейчас посмотрю."
    check(cross(phrase).is_echo(phrase, n + 0.2, n + 2.1) == "", "точное эхо по времени должно выброситься")
    check(cross(phrase).is_echo(phrase, n + 10, n + 12) == phrase, "то же без пересечения по времени — речь")
    check(cross(phrase).is_echo(phrase, n + 3.4, n + 4) == "", "±1.5 с — ещё пересечение")
    check(cross(phrase).is_echo(phrase, n + 3.6, n + 4) == phrase, "дальше 1.5 с — уже нет")

    check(cross("Какие бывают виды регистров сведений?").is_echo("виды регистров", n, n + 1) == "",
          "реплика целиком внутри фразы собеседника — эхо")
    check(cross("Может это из-за того, что у тебя карта AMD-шная?").is_echo(
        "Может, это из-за того, что у тебя карта AMD?", n, n + 2) == "", "почти то же — эхо")
    check(cross("Расскажи про регистры накопления.").is_echo(
        "Расскажи про регистры накоплений.", n, n + 2) == "", "похожесть ≥ 0.72 при сравнимой длине — эхо")
    check(cross("Да.").is_echo("Да.", n, n + 1) == "Да.", "короче 6 символов — не эхо")
    check(cross("Ты меня слышишь?").is_echo("Ты меня слышишь? Да.", n, n + 2) == "", "остаток в одно слово — эхо")
    check(cross("Ты меня слышишь?").is_echo("Ты меня слышишь? Да, слышу.", n, n + 2) == "Да, слышу.",
          "остаток в два слова — реплика")
    check(cross("Хорошо, давай.").is_echo("Хорошо, давай так и сделаем, но после обеда.", n, n + 3)
          == "Так и сделаем, но после обеда.", "ответ после эха остаётся")
    check(cross("понятно").is_echo("Непонятно, давай ещё раз.", n, n + 2) == "Непонятно, давай ещё раз.",
          "совпадение внутри слова — не эхо")
    c = asr.CrossTalk()
    c.note_them_text("  ", n, n + 1)
    check(c._recent == [], "пустую реплику собеседника не записываем")


def test_short_word_whitelist():
    for text in ("Да.", "Ок.", "Ну", "Ну.", "Не.", "Я.", "Угу.", "Ага", "Нет."):
        check(not asr.looks_like_noise(text), f"{text!r} — речь")
    for text in ("Э.", "хм", "", "Продолжение следует...", "..", "мм"):
        check(asr.looks_like_noise(text), f"{text!r} — шум")


def test_words_per_second_uses_audio_duration():
    fast = "Ну, а я не знаю, да, это же не так."  # 10 слов
    check(asr.looks_like_noise(fast, 1.6), "по одному span это 6 слов в секунду")
    check(not asr.looks_like_noise(fast, 1.6, 2.4), "по длине звука — 4 слова в секунду")

    eng = Stub(CUDA, texts=lambda *a: (fast, 1.6))
    tr = asr.Transcriber(eng)
    eng.tr = tr

    class Job:
        pipe = types.SimpleNamespace(channel="me")

    eng.tr = types.SimpleNamespace(_running=Job())
    eng.latency = 0.0
    check(tr._sync(np.zeros(int(2.4 * SR), np.float32)) == fast, "звука 2.4 с — фраза остаётся")
    check(tr._sync(np.zeros(int(1.2 * SR), np.float32)) == "", "звука 1.2 с и span 1.6 — шум")


def _echo_texts(kind, ch, k, audio_s):
    return "Да, конечно, я сейчас посмотрю.", audio_s


def _two_voices(kind, ch, k, audio_s):
    """Разные слова у сторон: сверка с эхом ничего не выбросит."""
    if ch == "them":
        return "Остатки на складе считаем по регистру накопления", audio_s
    return f"Я бы сначала проверил отчёт номер {k}", audio_s


async def test_echo_check_waits_for_them_words_not_for_them_end():
    # Собеседник говорит 8 с, пользователь (эхо) — секунду в начале. Финал микрофона
    # не ждёт конца фразы собеседника: сверяется с его свежей гипотезой.
    sim = Sim(CUDA, latency=0.3, texts=_echo_texts)
    try:
        await sim.play(11.0, them=track(speech(8.0), silence(3.0)), me=track(silence(1.0), speech(1.0), silence(9.0)))
        await sim.until_idle()
        me_submit = next(s for s in sim.submits if s["ch"] == "me")
        them_submit = next(s for s in sim.submits if s["ch"] == "them")
        me_final = sim.ev("final", "me")[0]
        check(me_final["t"] - me_submit["t"] <= 1.0 + 1e-6, f"финал микрофона ждал {me_final['t'] - me_submit['t']:.2f} с")
        check(me_final["t"] < them_submit["t"], "финал микрофона не должен ждать конца фразы собеседника")
        check(me_final["text"] == "" and sim.me.echo_dropped == 1, f"эхо не выброшено: {me_final}")
        check([e["text"] for e in sim.ev("final", "them")] == ["Да, конечно, я сейчас посмотрю."], "финал собеседника")
    finally:
        await sim.close()

    # Гипотезы собеседника нет (процессор её не посчитал): ждём не дольше
    # ECHO_OPEN_WAIT_S после конца своей речи, а не 20 с и не конца его фразы.
    sim = Sim(CUDA, latency=0.3, texts=lambda kind, ch, k, a: (f"{ch} говорит про погоду", a))
    offer = sim.tr.offer_partial
    sim.tr.offer_partial = lambda pipe, *a: None if pipe.channel == "them" else offer(pipe, *a)
    try:
        await sim.play(14.0, them=track(speech(12.0), silence(2.0)), me=track(silence(1.0), speech(1.0), silence(12.0)))
        await sim.until_idle()
        me_submit = next(s for s in sim.submits if s["ch"] == "me")
        them_submit = next(s for s in sim.submits if s["ch"] == "them")
        me_final = sim.ev("final", "me")[0]
        ended = me_submit["t"] - asr.ENDPOINT_MS / 1000
        check(asr.ECHO_OPEN_WAIT_S - 1e-6 <= me_final["t"] - ended <= asr.ECHO_OPEN_WAIT_S + 0.1,
              f"финал через {me_final['t'] - ended:.2f} с после конца речи")
        check(me_final["t"] < them_submit["t"] and me_final["text"] == "me говорит про погоду", f"финал {me_final}")
    finally:
        await sim.close()

    # Собеседник уже замолчал, его финал в очереди: финал микрофона ждёт его —
    # это один прогон — и сверяется с готовым текстом.
    sim = Sim(CUDA, texts=_echo_texts, latency=lambda kind, ch, a: 1.0 if (kind, ch) == ("final", "them") else 0.3)
    try:
        await sim.play(8.0, them=track(speech(3.0), silence(5.0)), me=track(silence(1.5), speech(1.3), silence(5.2)))
        await sim.until_idle()
        me_run = sim.runs("final", "me")[0]
        them_run = sim.runs("final", "them")[0]
        check(me_run["end"] < them_run["end"], f"сценарий: микрофон досчитан раньше собеседника: {me_run} / {them_run}")
        me_final, them_final = sim.ev("final", "me")[0], sim.ev("final", "them")[0]
        check(me_final["t"] >= them_final["t"] and me_final["t"] - them_final["t"] <= 0.05 + 1e-6,
              f"финал микрофона {sim.rel(me_final['t'])}, собеседника {sim.rel(them_final['t'])}")
        check(me_final["text"] == "" and sim.me.echo_dropped == 1, f"эхо не выброшено: {me_final}")
    finally:
        await sim.close()

    # Собеседник уже замолкает, но реплика ещё не закрылась, а хвост эха в
    # микрофоне оборвался чуть раньше: черновик с его словами уже есть — сверяемся
    # с ним и не ждём финала (на 5060 Ti это была лишняя секунда к ответу).
    sim = Sim(CUDA, texts=_echo_texts, latency=0.1)
    try:
        await sim.play(8.0, them=track(speech(3.0), silence(5.0)), me=track(silence(0.5), speech(2.0), silence(5.5)))
        await sim.until_idle()
        me_run = sim.runs("final", "me")[0]
        them_submit = next(s for s in sim.submits if s["ch"] == "them")
        check(me_run["end"] < them_submit["t"], f"сценарий: микрофон досчитан до закрытия собеседника: {me_run}")
        me_final = sim.ev("final", "me")[0]
        check(me_final["t"] < them_submit["t"] and me_final["text"] == "", f"эхо сверено не с черновиком: {me_final}")
    finally:
        await sim.close()

    # Очередь реплик: собеседник отвечает сразу после вопроса. Не пересекаются —
    # вопрос не ждёт конца ответа.
    sim = Sim(CUDA, latency=0.3)
    try:
        await sim.play(8.0, me=track(speech(1.0), silence(7.0)), them=track(silence(1.3), speech(4.0), silence(2.7)))
        await sim.until_idle()
        me_submit = next(s for s in sim.submits if s["ch"] == "me")
        them_submit = next(s for s in sim.submits if s["ch"] == "them")
        me_run = sim.runs("final", "me")[0]
        check(me_run["start"] - me_submit["t"] <= 0.35 + 1e-6 and me_run["start"] < them_submit["t"],
              f"вопрос ждал ответа: закрыт {sim.rel(me_submit['t'])}, считался с {sim.rel(me_run['start'])}")
    finally:
        await sim.close()

    # Ответы пользователя во время длинной реплики собеседника на быстрой видеокарте:
    # задержка как без всякой сверки, ничего не выброшено.
    curve = lambda kind, ch, a: 0.135 + 0.017 * a  # noqa: E731  (5060 Ti)
    sim = Sim(CUDA, latency=curve, texts=_two_voices)
    try:
        me = track(silence(1.0), *(p for _ in range(5) for p in (speech(2.0), silence(3.0))), silence(6.0))
        await sim.play(32.0, them=track(speech(25.0), silence(7.0)), me=me)
        await sim.until_idle()
        me_finals = sim.ev("final", "me")
        subs = [s for s in sim.submits if s["ch"] == "me"]
        lat = [round(e["t"] - s["t"], 2) for e, s in zip(me_finals, subs)]
        check(len(me_finals) == 5 and all(e["text"] for e in me_finals), f"финалы микрофона {me_finals}")
        check(max(lat) <= 1.2, f"задержка финалов после закрытия реплики: {lat}")
    finally:
        await sim.close()


class _Pipe:
    def __init__(self, channel, own=None):
        self.channel = channel
        self.cross = None
        self._own = own

    def own_level(self):
        return self._own


def _job(pipe, audio_s, *, began=0.0, ended=None, ducked=0.0, queued=0.0, db=None):
    audio = np.zeros(int(audio_s * SR), np.float32)
    return asr._Final(pipe, 0, audio, 0, began, began + audio_s if ended is None else ended, ducked, queued, db)


def test_shedding_rules():
    tr = asr.Transcriber(Stub(CUDA))
    me = _Pipe("me", own=-20.0)
    now = 100.0
    old = now - asr.SHED_WAIT_S - 1

    def shed(*jobs):
        tr._finals = deque(jobs)
        return tr._shed(now)

    quiet = [_job(me, 8.0, ducked=0.9, queued=old, db=-32.0) for _ in range(4)]
    dropped = shed(*quiet)
    check(dropped == quiet[:2], f"тихое эхо под отставание — с самых старых и только до порога: {len(dropped)}")
    check(list(tr._finals) == quiet[2:], "остальные остаются в очереди")

    loud = [_job(me, 8.0, ducked=0.9, queued=old, db=-21.0) for _ in range(4)]
    check(shed(*loud) == [], "поверх собеседника, но обычным голосом — это пользователь, не эхо")
    check(shed(_job(me, 26.0, ducked=0.9, queued=old, db=-32.0)) == [], "одна длинная реплика — не отставание")
    fresh = [_job(me, 8.0, ducked=0.9, queued=now - 1.0, db=-32.0) for _ in range(4)]
    check(shed(*fresh) == [], "длинная очередь без ожидания — не отставание")
    half = [_job(me, 8.0, ducked=0.6, queued=old, db=-32.0) for _ in range(4)]
    check(shed(*half) == [], "поверх собеседника меньше чем на 80% — не выбрасываем")
    nobody = _Pipe("me", own=None)
    check(shed(*[_job(nobody, 8.0, ducked=0.9, queued=old, db=-32.0) for _ in range(4)]) == [],
          "своего голоса ещё не слышали — сравнивать не с чем")
    them = _Pipe("them", own=-20.0)
    check(shed(*[_job(them, 8.0, ducked=0.9, queued=old, db=-32.0) for _ in range(4)]) == [],
          "финалы собеседника не выбрасываются никогда")


def test_them_final_goes_first():
    tr = asr.Transcriber(Stub(CUDA))
    me, them = _Pipe("me"), _Pipe("them")
    now = 100.0

    def pick(*jobs):
        tr._finals = deque(jobs)
        return tr._pick_final(now)

    t = _job(them, 3.0, began=90.0, queued=now - 0.5)
    m = _job(me, 1.0, began=91.0, ducked=0.9, queued=now - 1.0)
    check(pick(m, t) is t, "микрофон, звучавший одновременно, всё равно ждал бы финала собеседника")
    solo = _job(me, 1.0, began=80.0, ducked=0.0, queued=now - 1.0)
    check(pick(solo, t) is solo, "реплика не поверх собеседника идёт по порядку")
    near = _job(me, 1.0, began=86.0, ducked=0.6, queued=now - 1.0)
    check(pick(near, t) is near, "модель не отстаёт — по порядку")
    near.queued = now - asr.THEM_FIRST_WAIT_S - 0.1
    check(pick(near, t) is t, "модель отстаёт — собеседник раньше вероятного эха")
    check(pick(near, solo, t) is near, "обогнать можно только вероятное эхо, речь пользователя — нет")
    tr._ready.append((m, "досчитано"))
    check(pick(solo, t) is t, "собеседника ждёт уже досчитанная реплика — он первым")


def test_unchecked_rules():
    """Когда досчитанный финал микрофона ещё рано отдавать."""
    tr = asr.Transcriber(Stub(CUDA))
    me = _Pipe("me")
    me.cross = asr.CrossTalk()
    them = types.SimpleNamespace(channel="them", speaking=True, began=5.0, silence_ms=0)
    tr.pipes["them"] = them
    job = _job(me, 1.0, began=9.0, ended=10.0)
    text = "я отвечаю"

    check(tr._unchecked(job, text, 10.5), "собеседник говорит, черновика нет — ждём")
    check(not tr._unchecked(job, "", 10.5), "пустой финал сверять не с чем")
    me.cross.note_them_draft("он говорит", 5.0, 10.0 + asr.ECHO_DRAFT_MARGIN_S / 2)
    check(tr._unchecked(job, text, 10.5), "черновик обрывается у самого конца нашей речи — ждём свежее")
    me.cross.note_them_draft("он говорит", 5.0, 10.0 + asr.ECHO_DRAFT_MARGIN_S)
    check(not tr._unchecked(job, text, 10.5), "черновик покрывает конец речи с запасом — отдаём")
    me.cross.drop_them_draft()
    check(not tr._unchecked(job, text, 10.0 + asr.ECHO_OPEN_WAIT_S), "без черновика ждём не дольше ECHO_OPEN_WAIT_S")
    them.speaking, them.silence_ms = False, 0
    check(not tr._unchecked(job, text, 10.5), "собеседник не говорит, финала в очереди нет — отдаём")
    them.speaking, them.began = True, 10.2
    check(not tr._unchecked(job, text, 10.5), "его реплика началась после нашей — не пересекаются")
    them.speaking = False
    closed = _job(_Pipe("them"), 6.0, began=5.0, ended=11.0)
    tr._finals.append(closed)
    check(tr._unchecked(job, text, 12.0), "его финал в очереди — ждём")
    check(not tr._unchecked(job, text, 10.0 + asr.ECHO_WAIT_S), "но не дольше ECHO_WAIT_S")


def test_cuda_early_draft_for_echo_check():
    """CUDA: реплика микрофона ждёт гипотезы собеседника — черновик просим сразу, не по ритму."""
    tr = asr.Transcriber(Stub(CUDA))
    tr._wake = asyncio.Event()
    tr._worker = types.SimpleNamespace(done=lambda: False)  # воркер не нужен: смотрим только очередь просьб
    cross = asr.CrossTalk()
    them = types.SimpleNamespace(channel="them", utt=1, cross=cross, began=5.0, speaking=True,
                                 partial_asked=9.8, partial_done=9.8)
    now = 10.2
    cross.note_them_draft("он говорит", 5.0, 9.8)
    tr.offer_partial(them, 5000, now)
    check(not tr._partials, "по ритму ещё рано: с прошлой просьбы 0.4 с")
    me = _Pipe("me")
    tr._ready.append((_job(me, 1.0, began=8.8, ended=9.8), "ответ"))
    tr.offer_partial(them, 5000, now)
    check("them" in tr._partials, "гипотеза не покрывает конец речи микрофона — просим сразу")
    tr._partials.clear()
    them.partial_done = now - asr.PARTIAL_REST_MS / 2000
    tr.offer_partial(them, 5000, now)
    check(not tr._partials, "но не вплотную к прошлому прогону")
    them.partial_done = 9.8
    cross.note_them_draft("он говорит", 5.0, 9.8 + asr.ECHO_DRAFT_MARGIN_S)
    tr.offer_partial(them, 5000, now)
    check(not tr._partials, "гипотеза уже покрывает — ждём обычного ритма")


async def test_no_shedding_without_real_lag():
    """Видеокарта: длинные реплики поверх собеседника не выбрасываются, пока модель успевает."""
    curve = lambda kind, ch, a: 0.135 + 0.017 * a  # noqa: E731  (5060 Ti)
    texts = _two_voices
    sim = Sim(CUDA, latency=curve, texts=texts)
    try:
        me = track(silence(1.0), *(p for _ in range(5) for p in (speech(5.0), silence(1.0))), silence(20.0))
        await sim.play(50.0, them=track(speech(29.5), silence(20.5)), me=me)
        await sim.until_idle()
        check(sim.me.echo_dropped == 0 and len(sim.runs("final", "me")) == 5, f"выброшено {sim.me.echo_dropped}")
        check(all(e["text"] for e in sim.ev("final", "me")), f"финалы {sim.ev('final', 'me')}")
    finally:
        await sim.close()

    sim = Sim(CUDA, latency=curve, texts=texts)
    try:
        await sim.play(30.0, me=track(silence(1.0), speech(26.0), silence(3.0)),
                      them=track(silence(2.0), speech(26.0), silence(2.0)))
        await sim.until_idle()
        check([bool(e["text"]) for e in sim.ev("final", "me")] == [True], f"реплика в 26 с: {sim.ev('final', 'me')}")
    finally:
        await sim.close()


async def test_shedding_drops_quiet_echo_under_lag():
    """Модель отстаёт: тихое эхо поверх собеседника выбрасывается, громкая речь поверх него — нет."""
    sim = Sim(CUDA, texts=_two_voices, latency=lambda kind, ch, a: 12.0 if kind == "final" else 0.05)
    offer = sim.tr.offer_partial
    sim.tr.offer_partial = lambda pipe, *a: None  # черновики не нужны, только очередь финалов
    try:
        # Свой голос, пока собеседник молчит, — по нему судим, что «тихо».
        # Дальше поверх собеседника: тихое эхо (q) вперемешку с ответами обычным голосом (L).
        loud = (2, 6)
        me = track(speech(3.0, 0.3), silence(2.0),
                   *(p for k in range(8) for p in (speech(7.0, 0.3 if k in loud else 0.1), silence(1.0))),
                   silence(40.0))
        them = track(silence(5.0), speech(65.0), silence(40.0))
        await sim.play(110.0, me=me, them=them)
        await sim.until_idle(300.0)
        finals = sim.ev("final", "me")
        check(len(finals) == 9, f"финалов {len(finals)}")
        check(sim.me.echo_dropped >= 2, f"эхо не сброшено: {sim.me.echo_dropped}")
        check(len(sim.runs("final", "me")) == 9 - sim.me.echo_dropped, "выброшенные не считались")
        # startMs реплики k — её начало минус пред-ролл (после прошлой реплики он короче)
        for k in (-1, *loud):
            at = 5000 + 8000 * k if k >= 0 else 0
            got = [e for e in finals if at - asr.PREROLL_MS - 100 <= e["startMs"] <= at + 100]
            check(got and got[0]["text"], f"реплика обычным голосом выброшена: k={k} {finals}")
    finally:
        sim.tr.offer_partial = offer
        await sim.close()


async def test_delay_is_time_not_audio():
    """delayS — сколько ждёт самая старая реплика, а не сколько в очереди звука."""
    sim = Sim(CUDA, cross=False, latency=lambda kind, ch, a: 0.4 if kind == "final" else 0.1)
    try:
        # Реплика в 25 с считается 0.4 с: звука в очереди много, ждать — недолго.
        await sim.play(26.1, me=track(speech(25.0), silence(1.1)))
        worst_audio, worst_delay = 0.0, 0.0
        for _ in range(30):
            worst_audio = max(worst_audio, sim.tr.backlog()[0])
            worst_delay = max(worst_delay, sim.tr.delay())
            await sim.play(STEP)
        await sim.until_idle()
        check(worst_audio >= 20.0, f"сценарий: в очереди было {worst_audio:.1f} с звука")
        check(worst_delay <= asr.ENDPOINT_MS / 1000 + 0.4 + 0.1, f"delayS {worst_delay:.2f}")
    finally:
        await sim.close()


async def test_main_socket_lifecycle():
    """asr.main() с заглушками: замена микрофона, сбой кадра, словарь, health, пустой финал, stats."""
    import websockets

    asr.time = REAL_TIME
    eng = Stub(CUDA, clock=None, latency=0.05,
               texts=lambda kind, ch, k, a: ("", a) if kind == "final" else ("раз два", a))
    eng.terms_fail = True
    orig_attach = asr.Transcriber.attach
    pipes: dict = {}

    def attach(self, pipe):
        self.engine.tr = self
        pipes[pipe.channel] = pipe
        orig_attach(self, pipe)

    loop_mod = types.ModuleType("audio_loopback")

    class LoopbackCapture:
        device_name = "stub"
        error = None

        def __init__(self, cb):
            self.cb = cb

        def start(self):
            pass

    loop_mod.LoopbackCapture = LoopbackCapture
    saved = (asr.select_engine, asr.HEALTH_EVERY_S, asr.STATS_EVERY_S, sys.modules.get("audio_loopback"),
             os.environ.get("COPILOT_NO_SILERO"))
    asr.select_engine = lambda *a, **k: (eng, None)
    asr.Transcriber.attach = attach
    asr.HEALTH_EVERY_S = 0.5
    asr.STATS_EVERY_S = 1.0
    sys.modules["audio_loopback"] = loop_mod
    os.environ["COPILOT_NO_SILERO"] = "1"

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    out = io.StringIO()
    server = None
    frames = [(speech(STEP) * 32767).astype(np.int16).tobytes() for _ in range(12)]
    quiet = (silence(STEP) * 32767).astype(np.int16).tobytes()
    try:
        with contextlib.redirect_stdout(out):
            ns = types.SimpleNamespace(port=port, token="tok", model="m", compute_type="x", language="ru",
                                       glossary="", device="auto", probe=False)
            server = asyncio.create_task(asr.main(ns))
            url = f"ws://127.0.0.1:{port}/?ch=me&token=tok"
            for _ in range(100):
                try:
                    a = await websockets.connect(url, ping_interval=None)
                    break
                except OSError:
                    await asyncio.sleep(0.05)
            else:
                raise AssertionError("сайдкар не поднялся")
            for f in frames:
                await a.send(f)
                await asyncio.sleep(STEP)
            await asyncio.sleep(0.1)
            mic = pipes["me"]
            check(mic.speaking and mic.buf, "сценарий: реплика должна быть открыта")

            b = await websockets.connect(url, ping_interval=None)
            await asyncio.wait_for(a.wait_closed(), 3)
            check(a.close_code == 4002 and a.close_reason == "replaced", f"старый сокет: {a.close_code} {a.close_reason}")
            check(not mic.speaking and not mic.buf and not mic.pre, "микрофон не сброшен при замене")

            got: list = []

            async def reader():
                async for m in b:
                    got.append(json.loads(m))

            rt = asyncio.create_task(reader())
            await b.send(b"\x00")                                   # нечётный кадр: feed бросит
            await b.send(json.dumps({"type": "hotwords", "terms": ["СКД"]}))  # словарь бросит
            for f in frames + [quiet] * 24:
                await b.send(f)
                await asyncio.sleep(STEP)
            await asyncio.sleep(1.2)
            check(b.close_code is None, f"сокет закрылся: {b.close_code}")
            finals = [m for m in got if m["type"] == "final"]
            check(finals and finals[0]["text"] == "", f"пустой финал не дошёл: {got}")
            health = [m for m in got if m["type"] == "health"]
            check(health and set(health[0]) == {"type", "device", "load", "backlogS", "delayS", "queuedFinals"},
                  f"health: {health[:1]}")
            check(health[0]["device"] == "cuda", f"health: {health[0]}")
            await b.close()
            rt.cancel()
            await asyncio.sleep(0.3)
            check(not mic.speaking, "после закрытия микрофон должен быть сброшен")
    finally:
        if server is not None:
            server.cancel()
            with contextlib.suppress(BaseException):
                await server
        asr.select_engine, asr.HEALTH_EVERY_S, asr.STATS_EVERY_S = saved[0], saved[1], saved[2]
        asr.Transcriber.attach = orig_attach
        if saved[3] is None:
            sys.modules.pop("audio_loopback", None)
        else:
            sys.modules["audio_loopback"] = saved[3]
        if saved[4] is None:
            os.environ.pop("COPILOT_NO_SILERO", None)

    lines = [json.loads(line) for line in out.getvalue().splitlines() if line.startswith("{")]
    events = [x for x in lines if "event" in x]
    check({"event": "mic-replaced"} in events, f"нет mic-replaced: {events}")
    closed = [x for x in events if x["event"] == "ws-closed"]
    check(any(x["channel"] == "me" and x["code"] == 4002 and x["reason"] == "replaced" for x in closed),
          f"ws-closed 4002: {closed}")
    check(any(x["channel"] == "me" and x["code"] == 1000 for x in closed), f"ws-closed 1000: {closed}")
    errors = [x["error"] for x in lines if "error" in x]
    check(any(e.startswith("me: ") for e in errors), f"сбой кадра не залогирован: {errors}")
    check(any("управляющее сообщение" in e for e in errors), f"сбой словаря не залогирован: {errors}")
    stats = [x["stats"] for x in lines if "stats" in x]
    check(stats, "stats не напечатан")
    want = {"lagS", "backlogS", "queuedFinals", "partialRuns", "partialsShown", "echoDropped", "emptyFinals"}
    check(want <= set(stats[0]["me"]) and want <= set(stats[0]["them"]) and "modelLoad" in stats[0],
          f"stats: {stats[0]}")
    check(all(s["me"]["lagS"] < 0.5 for s in stats), f"lagS: {[s['me']['lagS'] for s in stats]}")


TESTS = [
    test_short_word_whitelist,
    test_words_per_second_uses_audio_duration,
    test_echo_rules,
    test_feed_never_blocks_while_model_runs,
    test_finals_go_before_partials,
    test_stale_partial_is_dropped,
    test_cuda_partial_cadence_from_run_start,
    test_cpu_partial_shown_immediately,
    test_cpu_partials_respect_load_and_cut,
    test_cpu_partial_waits_for_idle_model,
    test_cpu_parked_final_does_not_block_partials,
    test_empty_final_is_sent,
    test_exception_in_me_final_keeps_channel,
    test_echo_check_waits_for_them_words_not_for_them_end,
    test_them_final_goes_first,
    test_unchecked_rules,
    test_cuda_early_draft_for_echo_check,
    test_shedding_rules,
    test_no_shedding_without_real_lag,
    test_shedding_drops_quiet_echo_under_lag,
    test_delay_is_time_not_audio,
    test_main_socket_lifecycle,
]


def main() -> int:
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
        finally:
            for sim in SIMS:
                sim.eng.abort = True
            SIMS.clear()
            asr.time = REAL_TIME
    print("всё прошло" if not failed else f"упало: {failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
