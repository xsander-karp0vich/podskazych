"""
Локальный STT-сайдкар. Аудио НЕ покидает машину.

Два канала:
  them — системный звук, захватывается ЗДЕСЬ через WASAPI loopback.
         Через Electron это сделать не вышло: getDisplayMedia с audio='loopback'
         на Windows отдаёт NotReadableError даже при корректном источнике
         и при реально играющем звуке. Проверено на этой машине.
  me   — микрофон, приходит из рендерера по WebSocket (там getUserMedia работает).

Раздельные каналы дают точную диаризацию без speaker-diarization модели.

Whisper не потоковый (окно 30 с, на тишине галлюцинирует), поэтому режем сами:
VAD выделяет реплику, каждые Caps.partial_every_ms (engines.py) переспрашиваем
растущий буфер, показываем только префикс, совпавший в двух гипотезах подряд
(LocalAgreement-2) — иначе текст мерцает и читать его невозможно.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import os
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from urllib.parse import parse_qs, urlparse

import numpy as np
import websockets

# Первым: правит PATH под CUDA-библиотеки до любого обращения к CTranslate2.
from engines import SAMPLE_RATE, Engine, EngineError, probe, select_engine

# Частота промежуточных гипотез и потолок реплики зависят от устройства — см. Caps.
ENDPOINT_MS = 700
# С Silero конец речи определяет модель, а не таймер, поэтому ждать можно
# меньше: таймер здесь лишь подтверждает то, что уже решено.
ENDPOINT_SILERO_MS = 500
# Сколько тишины оставить в конце реплики: затухание последнего слова.
TAIL_KEEP_MS = 250
MIN_UTTERANCE_MS = 300
VAD_RMS_DBFS = -45.0        # системный звук
VAD_RMS_DBFS_MIC = -38.0    # микрофон: ближе ко рту, шум комнаты не должен будить
VAD_HANGOVER_MS = 250
# Silero не дребезжит: он распознаёт речь, а не громкость, и не проваливается
# внутри слова. Поэтому ему длинный hangover не нужен, а каждые лишние 150 мс
# здесь напрямую откладывают финал и мешают разделять реплики.
VAD_HANGOVER_SILERO_MS = 100
# Сколько звука ДО срабатывания порога подклеивать в начало реплики.
# Глухие начала русских слов (с-, ш-, ф-, х-, п-, т-, к-) поднимаются из шума
# медленно, и чем хуже микрофон, тем сильнее они срезаются. 400 мс — столько же
# держит сам faster-whisper в speech_pad_ms.
PREROLL_MS = 400

# --- решение «есть ли здесь речь» ---
# Энергетический порог отвечал на этот вопрос по громкости и потому терял
# тихого собеседника целиком: замер на записанной речи показал, что Silero
# уверенно находит её вплоть до −74 dBFS и при SNR 0 дБ, а наш порог −45 dBFS
# не открывал буфер вообще — то есть реплика не доходила до модели.
# Модель Silero уже лежит внутри faster-whisper (silero_vad_v6.onnx),
# отдельной зависимости не нужно. Цена — 3.5 мс на 3 секунды звука.
SPEECH_WINDOW_MS = 500      # на каком куске спрашиваем
GATE_EVERY_MS = 50          # как часто спрашиваем: вызов стоит около миллисекунды
# Спрашиваем не «есть ли речь в окне», а «есть ли речь В ХВОСТЕ окна».
# Разница дорогая: при вопросе про всё окно гейт держится ещё почти секунду
# после того, как человек замолчал, — его хвост всё ещё лежит в окне. Из-за
# этого пауза, нужная для разделения двух реплик, выросла с 0.95 до 1.8 с,
# а финал приезжал через 1.9 с вместо 0.93 с.
GATE_TAIL_MS = 120
SILERO_THRESHOLD = 0.35     # ниже дефолтных 0.5: потерять реплику дороже, чем пустить лишнее
SILERO_DUCK_THRESHOLD = 0.7 # пока звучит собеседник, от микрофона требуем больше уверенности
LEVEL_EVERY_MS = 120

# Пока звучит собеседник, микрофон почти наверняка ловит его же из динамиков.
# Не глушим канал совсем (иначе потеряем перебивку), а поднимаем порог.
DUCK_HANGOVER_MS = 900
DUCK_EXTRA_DB = 12.0
# Похожесть, при которой считаем реплику эхом уже сказанного собеседником
STATS_EVERY_S = 20.0
# Сколько раз подряд должна повториться цепочка слов, чтобы счесть её зацикливанием
LOOP_TIMES = 3
# Потолок темпа речи, слов в секунду: норма русской спонтанной речи 2.5-3
MAX_WORDS_PER_S = 5.0
ECHO_SIMILARITY = 0.72
ECHO_WINDOW_S = 12.0


def rms_dbfs(pcm: np.ndarray) -> float:
    if pcm.size == 0:
        return -100.0
    r = float(np.sqrt(np.mean(np.square(pcm))))
    return 20.0 * np.log10(r) if r > 0 else -100.0


def make_speech_gate():
    """Silero из состава faster-whisper. None, если onnxruntime недоступен.

    Возвращаем функцию, а не класс: модель кэшируется внутри библиотеки,
    сессия одна на процесс, и оба канала ходят в неё по очереди — они живут
    в одном event loop, так что гонки нет.
    """
    # Выключатель для A/B: без него не с чем сравнивать выигрыш от Silero.
    if os.environ.get("COPILOT_NO_SILERO") == "1":
        print(json.dumps({"error": "Silero выключен через COPILOT_NO_SILERO"}), flush=True)
        return None

    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
    except Exception as e:
        print(json.dumps({"error": f"Silero недоступен, остаётся порог по громкости: {e}"}), flush=True)
        return None

    tail = int(GATE_TAIL_MS * SAMPLE_RATE / 1000)

    def gate(audio: np.ndarray, threshold: float) -> bool:
        opts = VadOptions(
            threshold=threshold,
            min_speech_duration_ms=100,
            # Дефолтные 2000 мс рассчитаны на офлайн-расшифровку целого файла;
            # в потоке это склеило бы соседние реплики в одну.
            min_silence_duration_ms=200,
            speech_pad_ms=0,
        )
        spans = get_speech_timestamps(audio, opts)
        if not spans:
            return False
        # Речь считается идущей, только если последний найденный отрезок
        # кончается у самого края окна. Иначе мы бы ещё почти секунду
        # утверждали, что человек говорит, глядя на его же отзвучавший хвост.
        return (len(audio) - spans[-1]["end"]) < tail

    # Прогоняем вхолостую прямо сейчас: onnxruntime и сам файл модели грузятся
    # лениво, при первом вызове. Без прогрева отказ всплыл бы посреди созвона,
    # а так мы честно узнаём о нём на старте и уходим на порог по громкости.
    try:
        gate(np.zeros(SAMPLE_RATE, dtype=np.float32), SILERO_THRESHOLD)
    except Exception as e:
        print(json.dumps({"error": f"Silero не поднялся, остаётся порог по громкости: {e}"}), flush=True)
        return None

    return gate


class Levels:
    """Что слышно на канале: пол шума, уровень речи, запас над порогом.

    Нужно, чтобы на вопрос «у собеседника плохой микрофон?» отвечать числом,
    а не на слух. Порог VAD задан константой, и без этих цифр непонятно
    главное: попадает ли тихая речь в модель вообще или отсекается на входе.

    Пол шума берём как 10-й процентиль недавних уровней: медиана уехала бы
    вверх на разговорчивом собеседнике, а минимум скакал бы от одного
    тихого кадра.
    """

    __slots__ = ("recent", "speech", "utterances", "dropped", "clipped")

    def __init__(self) -> None:
        # 500 замеров по LEVEL_EVERY_MS — примерно минута наблюдения
        self.recent: deque = deque(maxlen=500)
        self.speech: deque = deque(maxlen=500)
        self.utterances = 0
        self.dropped = 0
        self.clipped = 0

    def note(self, db: float, speaking: bool) -> None:
        self.recent.append(db)
        if speaking:
            self.speech.append(db)

    @staticmethod
    def _pct(values: deque, q: float) -> float | None:
        if not values:
            return None
        return round(float(np.percentile(np.fromiter(values, dtype=np.float32), q)), 1)

    def report(self, threshold: float, detector: str) -> dict:
        floor = self._pct(self.recent, 10)
        speech = self._pct(self.speech, 50)
        out = {
            "detector": detector,
            "floorDb": floor,
            "speechDb": speech,
            # Насколько речь выше шума — главный ответ на вопрос «как у него
            # с микрофоном». Ниже ~10 дБ распознавание начинает сыпаться.
            "snrDb": None if (speech is None or floor is None) else round(speech - floor, 1),
            "utterances": self.utterances,
            "dropped": self.dropped,
            "clipped": self.clipped,
        }
        # Запас над порогом осмыслен ТОЛЬКО когда решение принимает порог.
        # При Silero громкость ни на что не влияет, и показывать этот запас
        # значило бы предлагать смотреть не туда.
        if detector != "silero":
            out["marginDb"] = None if speech is None else round(speech - threshold, 1)
        return out


# Whisper на тишине и шуме уверенно выдаёт один и тот же мусор —
# это известное поведение, лечится только фильтром на выходе.
HALLUCINATIONS = {
    "продолжение следует...",
    "субтитры сделал dimatorzok",
    "субтитры создавал dimatorzok",
    "редактор субтитров а.синецкая корректор а.егорова",
    "спасибо за просмотр!",
    "спасибо за внимание!",
    "подписывайтесь на канал",
    "продолжение следует",
    "！",
    "..",
}


# Семейства галлюцинаций, а не точные строки. Точный список пропускал варианты:
# модель подставляет разные фамилии — «Редактор субтитров А.Семкин» вместо
# «А.Синецкая», — и под подсказкой словаря выдаёт именно такие варианты. На
# замере с постоянной частью словаря все пять видов не-речи давали «Редактор
# субтитров А.Семкин…», и все пять проходили фильтр в расшифровку.
HALLUCINATION_PATTERNS = [
    re.compile(r"субтитр"),
    re.compile(r"продолжение следует"),
    re.compile(r"спасибо за (просмотр|внимание)"),
    re.compile(r"подписывайтесь"),
    re.compile(r"корректор\s+[а-яё]\.\s*[а-яё]+"),
]
# Пометки звука вместо речи: «ДИНАМИЧНАЯ МУЗЫКА», «[аплодисменты]». Отсекаем их
# только вместе со словом про звук: реплика «СКД» капсом — это речь, её трогать нельзя.
SOUND_WORDS = re.compile(r"музык|аплодисмент|смех|шум|тишин|гудок|звонок")


def loops(words: list[str]) -> bool:
    """Одна и та же цепочка слов повторяется подряд — Whisper зациклился.

    Цепочки берём от двух слов: «да да да» и «понял понял» — нормальная
    русская речь, а вот «спасибо за просмотр спасибо за просмотр спасибо
    за просмотр» — уже машина.
    """
    for n in (2, 3, 4, 5):
        if len(words) < n * LOOP_TIMES:
            break
        for i in range(len(words) - n * LOOP_TIMES + 1):
            gram = words[i:i + n]
            if all(words[i + k * n:i + (k + 1) * n] == gram for k in range(1, LOOP_TIMES)):
                return True
    return False


def looks_like_noise(text: str, dur_s: float = 0.0) -> bool:
    """Похоже ли это на выдумку, а не на речь.

    Опираться на no_speech_prob нельзя: на наших весах large-v3-turbo он
    равен РОВНО 0.0 у каждого сегмента (проверено запуском; в faster-whisper
    на это открыты issue #1028 и #1128). avg_logprob тоже не спасает — на
    чистом шуме модель выдала «Продолжение следует...» с уверенностью
    −0.142, то есть очень высокой. Поэтому решают текстовые признаки.
    """
    t = text.strip().lower().strip(".!? ")
    if not t:
        return True
    if t in HALLUCINATIONS or text.strip().lower() in HALLUCINATIONS:
        return True
    if any(p.search(t) for p in HALLUCINATION_PATTERNS):
        return True
    letters = [ch for ch in text if ch.isalpha()]
    shouted = bool(letters) and all(ch.isupper() for ch in letters)
    bracketed = bool(re.fullmatch(r"\s*[\[(].*[\])]\s*", text))
    if (shouted or bracketed) and SOUND_WORDS.search(t):
        return True
    # Одиночный короткий огрызок без гласных смысла не несёт
    if len(t) <= 2:
        return True

    words = t.split()
    if loops(words):
        return True
    # Русская спонтанная речь идёт 2.5-3 слова в секунду. Вдвое быстрее —
    # это не расшифровка, а поток, придуманный поверх тишины.
    if dur_s >= 1.0 and len(words) / dur_s > MAX_WORDS_PER_S:
        return True
    return False


def common_prefix(a: str, b: str) -> str:
    """LocalAgreement-2 по словам: отдаём только то, с чем согласны две гипотезы."""
    out: list[str] = []
    for x, y in zip(a.split(), b.split()):
        if x != y:
            break
        out.append(x)
    return " ".join(out)


class CrossTalk:
    """
    Общее состояние двух каналов.

    Звук собеседника из динамиков попадает в микрофон и распознаётся как речь
    пользователя — на записи это выглядит как будто он сам произнёс чужую фразу.
    Ловим это двумя способами: пока собеседник говорит, микрофону поднимаем
    порог; а уже распознанный текст сверяем с тем, что недавно сказал собеседник.
    """

    def __init__(self) -> None:
        self._them_until = 0.0
        self._recent: list[tuple[float, str]] = []

    def note_them_active(self) -> None:
        self._them_until = time.monotonic() + DUCK_HANGOVER_MS / 1000

    def them_active(self) -> bool:
        return time.monotonic() < self._them_until

    def note_them_text(self, text: str) -> None:
        probe = text.strip().lower()
        # Пустую реплику записывать нельзя: SequenceMatcher сравнивает с ней
        # что угодно достаточно похоже, и микрофон пользователя глохнет на все
        # ECHO_WINDOW_S секунд. Собеседник молчит — значит и эха нет.
        if not probe:
            return
        now = time.monotonic()
        self._recent.append((now, probe))
        self._recent = [(t, x) for t, x in self._recent if now - t < ECHO_WINDOW_S]

    def is_echo(self, text: str) -> bool:
        probe = text.strip().lower()
        if len(probe) < 6:
            return False
        now = time.monotonic()
        for t, said in self._recent:
            if now - t > ECHO_WINDOW_S:
                continue
            if probe in said or said in probe:
                return True
            if SequenceMatcher(None, probe, said).ratio() >= ECHO_SIMILARITY:
                return True
        return False


class Transcriber:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._lock = asyncio.Lock()
        # сколько заняло последнее распознавание: по нему разрежаются
        # промежуточные гипотезы, если движок не успевает
        self.last_run_s = 0.0

    def set_terms(self, terms: list) -> dict:
        return self.engine.set_terms(terms)

    async def run(self, audio: np.ndarray) -> str:
        # Одна модель на оба канала: на видеокарте они подрались бы за память,
        # на процессоре — за ядра.
        async with self._lock:
            started = time.monotonic()
            try:
                return await asyncio.to_thread(self._sync, audio)
            finally:
                self.last_run_s = time.monotonic() - started

    def _sync(self, audio: np.ndarray) -> str:
        text, span = self.engine.transcribe(audio)
        # Длительность нужна фильтру, чтобы поймать неправдоподобный темп речи.
        return "" if looks_like_noise(text, span) else text


@dataclass
class Pipeline:
    """Состояние одной реплики для одного говорящего."""

    channel: str
    transcriber: Transcriber
    emit: object
    t0: float
    cross: CrossTalk | None = None
    vad_threshold: float = VAD_RMS_DBFS
    buf: list = field(default_factory=list)
    samples: int = 0
    start_ms: int = 0
    speaking: bool = False
    silence_ms: int = 0
    hangover_ms: int = 0
    last_partial: float = 0.0
    last_level: float = 0.0
    prev_hyp: str = ""
    shown: str = ""
    levels: Levels = field(default_factory=Levels)
    # Кольцо последних чанков тишины: из него берётся начало реплики.
    pre: deque = field(default_factory=deque)
    pre_samples: int = 0
    # Скользящее окно для Silero: он смотрит на кусок, а не на один чанк.
    win: deque = field(default_factory=deque)
    win_samples: int = 0
    gate: object = None
    # Долг по опросу считаем в СЭМПЛАХ, а не по часам: когда очередь разгребается
    # после затыка на видеокарте, десяток чанков прилетает почти одновременно,
    # и опрос по времени случился бы один раз на секунду звука — остальное
    # получило бы устаревшее решение.
    gate_debt: int = 0
    gate_says: bool = False

    def reset(self) -> None:
        # Кольцо пред-ролла НЕ трогаем: оно наполняется в тишине между
        # репликами и нужно уже следующей.
        self.buf.clear()
        self.samples = 0
        self.speaking = False
        self.silence_ms = 0
        self.prev_hyp = ""
        self.shown = ""

    async def feed(self, chunk: np.ndarray) -> None:
        chunk_ms = int(chunk.size / SAMPLE_RATE * 1000)
        level = rms_dbfs(chunk)

        # Окно последней секунды: именно на него смотрит Silero.
        self.win.append(chunk)
        self.win_samples += chunk.size
        win_limit = int(SPEECH_WINDOW_MS * SAMPLE_RATE / 1000)
        while self.win and self.win_samples - self.win[0].size >= win_limit:
            self.win_samples -= self.win.popleft().size

        ducked = (
            self.channel == "me" and self.cross is not None and self.cross.them_active()
        )

        if self.gate is not None:
            # Спрашиваем не на каждый чанк: решение почти не меняется за 20 мс,
            # а вызов стоит около миллисекунды.
            self.gate_debt += chunk.size
            step = int(GATE_EVERY_MS * SAMPLE_RATE / 1000)
            if self.gate_debt >= step:
                self.gate_debt = 0
                # Цифровая тишина: спрашивать модель не о чем.
                if level <= -90.0:
                    self.gate_says = False
                else:
                    th = SILERO_DUCK_THRESHOLD if ducked else SILERO_THRESHOLD
                    try:
                        self.gate_says = self.gate(np.concatenate(self.win), th)
                    except Exception as e:
                        # Гейт отвалился на ходу — не роняем канал, а честно
                        # уходим на порог по громкости до конца сессии.
                        print(json.dumps({"error": f"Silero отказал, переходим на порог: {e}"}), flush=True)
                        self.gate = None
                        self.gate_says = False
            loud = self.gate_says
        else:
            # Запасной путь, если Silero не поднялся: порог по громкости.
            threshold = self.vad_threshold + (DUCK_EXTRA_DB if ducked else 0.0)
            loud = level > threshold

        if self.channel == "them" and loud and self.cross is not None:
            self.cross.note_them_active()
        hang = VAD_HANGOVER_SILERO_MS if self.gate is not None else VAD_HANGOVER_MS
        self.hangover_ms = hang if loud else max(0, self.hangover_ms - chunk_ms)
        active = loud or self.hangover_ms > 0

        # Уровень для индикатора: раз в LEVEL_EVERY_MS, иначе завалим сокет
        # сотнями сообщений в секунду.
        now_l = time.monotonic()
        if (now_l - self.last_level) * 1000 >= LEVEL_EVERY_MS:
            self.last_level = now_l
            self.levels.note(level, active)
            await self.emit("level", self.channel, "", 0, level)

        # Клиппинг: если собеседник в красной зоне, дело не в тихом микрофоне,
        # а в перегрузе, и лечится это ровно наоборот.
        if chunk.size and float(np.max(np.abs(chunk))) >= 0.999:
            self.levels.clipped += 1

        if active and not self.speaking:
            self.speaking = True
            # Подклеиваем накопленную тишину: реплика началась раньше, чем
            # уровень перешёл порог.
            self.buf.extend(self.pre)
            self.samples += self.pre_samples
            pre_ms = int(self.pre_samples / SAMPLE_RATE * 1000)
            # Не уходим в минус: у самого начала сессии пред-ролл длиннее,
            # чем всё прошедшее время, а отрицательная метка ломает ленту.
            self.start_ms = max(0, int((time.monotonic() - self.t0) * 1000) - pre_ms)
            self.pre.clear()
            self.pre_samples = 0

        if self.speaking:
            self.buf.append(chunk)
            self.samples += chunk.size
            self.silence_ms = 0 if active else self.silence_ms + chunk_ms
        else:
            # Молчим — копим кольцо, чтобы было что подклеить.
            self.pre.append(chunk)
            self.pre_samples += chunk.size
            limit = int(PREROLL_MS * SAMPLE_RATE / 1000)
            while self.pre and self.pre_samples - self.pre[0].size >= limit:
                self.pre_samples -= self.pre.popleft().size

        dur_ms = int(self.samples / SAMPLE_RATE * 1000)
        now = time.monotonic()
        caps = self.transcriber.engine.caps
        # Пока идёт распознавание, канал не читает звук: захват копится в очереди.
        # Если процессор слабый или реплика длинная, переспрос по расписанию съел
        # бы всё время, и очередь переполнилась бы. Поэтому на процессоре между
        # гипотезами выдерживается несколько длительностей последнего распознавания.
        partial_gap_ms = max(caps.partial_every_ms, self.transcriber.last_run_s * 1000 * caps.backoff)

        # Гипотеза, которая досчитается уже после принудительного закрытия реплики,
        # не нужна: финал всё равно придёт следом, а на процессоре она отнимает
        # секунду, пока звук копится в очереди. На CUDA (backoff 0) не трогаем.
        near_cut = caps.backoff > 0 and dur_ms + self.transcriber.last_run_s * 1000 >= caps.max_utterance_ms

        if (self.speaking and dur_ms >= max(MIN_UTTERANCE_MS, caps.min_partial_ms) and not near_cut
                and (now - self.last_partial) * 1000 >= partial_gap_ms):
            self.last_partial = now
            hyp = await self.transcriber.run(np.concatenate(self.buf))
            stable = common_prefix(self.prev_hyp, hyp)
            self.prev_hyp = hyp
            if stable and stable != self.shown:
                self.shown = stable
                await self.emit("partial", self.channel, stable, self.start_ms)

        endpoint = ENDPOINT_SILERO_MS if self.gate is not None else ENDPOINT_MS
        if self.speaking and (self.silence_ms >= endpoint or dur_ms >= caps.max_utterance_ms):
            # reset() обязан выполниться в любом случае: если распознавание
            # бросит исключение, а буфер останется, канал больше никогда не
            # закроет реплику — он будет расти и переспрашиваться целиком.
            # Потерять одну реплику дешевле, чем потерять канал.
            try:
                await self._finish(dur_ms)
            finally:
                self.reset()

    def _voiced(self) -> np.ndarray:
        """Буфер реплики без хвоста тишины, накопленного эндпойнтом.

        К моменту закрытия реплики в буфере лежит всё молчание, которое мы
        ждали: задержка гейта, hangover и сам эндпойнт. Раньше это резал
        внутренний vad_filter, но он же терял реплики целиком, и мы его
        выключили. Режем сами и оставляем немного на затухание — Whisper
        на длинном хвосте тишины склонен дописывать несуществующее.
        """
        audio = np.concatenate(self.buf)
        tail_ms = self.silence_ms + TAIL_KEEP_MS
        drop = int((tail_ms - TAIL_KEEP_MS) * SAMPLE_RATE / 1000)
        if drop <= 0 or audio.size - drop < MIN_UTTERANCE_MS * SAMPLE_RATE / 1000:
            return audio
        return audio[:-drop]

    async def _finish(self, dur_ms: int) -> None:
        if dur_ms < MIN_UTTERANCE_MS:
            return
        # Считаем только то, что реально ушло в модель: обрывки короче
        # MIN_UTTERANCE_MS отбрасываются, и в счётчике им не место — иначе
        # цифра врёт в разы, а на неё смотрят как на диагностику.
        self.levels.utterances += 1
        text = await self.transcriber.run(self._voiced())
        if self.cross is not None:
            if self.channel == "them":
                self.cross.note_them_text(text)
            elif text and self.cross.is_echo(text):
                # Это не пользователь, это динамики. Молча выбрасываем.
                text = ""
        await self.emit("final", self.channel, text, self.start_ms)


class Hub:
    """Держит подключённых клиентов и раздаёт им результаты по каналам."""

    def __init__(self) -> None:
        self.clients: dict = {"me": set(), "them": set()}

    def add(self, channel: str, ws) -> None:
        self.clients.setdefault(channel, set()).add(ws)

    def drop(self, channel: str, ws) -> None:
        self.clients.get(channel, set()).discard(ws)

    async def send(self, kind: str, channel: str, text: str, start_ms: int, db: float | None = None) -> None:
        if kind != "level" and not text:
            return
        msg: dict = {"type": kind, "channel": channel, "text": text, "startMs": start_ms}
        if db is not None:
            msg["db"] = round(db, 1)
        payload = json.dumps(msg, ensure_ascii=False)
        for ws in list(self.clients.get(channel, set())):
            try:
                await ws.send(payload)
            except Exception:
                self.drop(channel, ws)


def fatal(code: str, message: str) -> None:
    """Последнее слово перед выходом: приложение покажет message вместо трассировки."""
    print(json.dumps({"fatal": {"code": code, "message": message}}, ensure_ascii=False), flush=True)


def log_error(message: str) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False), flush=True)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int)
    ap.add_argument("--token")
    ap.add_argument("--model", default="large-v3-turbo")
    # тип для CUDA; на процессоре всегда int8
    ap.add_argument("--compute-type", default="int8_float16")
    ap.add_argument("--language", default="ru")
    ap.add_argument("--glossary", default="")
    # auto — видеокарта NVIDIA, если CUDA заработала, иначе процессор
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    # напечатать, что есть на машине, и выйти — без загрузки модели
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()
    if not args.probe and (args.port is None or not args.token):
        ap.error("нужны --port и --token")
    return args


async def main(args: argparse.Namespace) -> None:
    engine, fallback = select_engine(
        args.device,
        args.model,
        args.language,
        args.compute_type,
        args.glossary,
        log_error,
    )
    transcriber = Transcriber(engine)
    t0 = time.monotonic()
    hub = Hub()
    loop = asyncio.get_running_loop()

    cross = CrossTalk()
    gate = make_speech_gate()
    mic = Pipeline("me", transcriber, hub.send, t0, cross=cross,
                   vad_threshold=VAD_RMS_DBFS_MIC, gate=gate)
    sys_pipe = Pipeline("them", transcriber, hub.send, t0, cross=cross, gate=gate)

    # Системный звук: поток PyAudio -> очередь -> обработчик в event loop.
    sys_queue: asyncio.Queue = asyncio.Queue(maxsize=200)

    def push(chunk: np.ndarray) -> None:
        # Переполнение значит, что распознавание не успевает за захватом.
        # Раньше чанк выбрасывался молча — то есть кусок чужой речи пропадал,
        # и понять это по расшифровке было нельзя. Теперь считаем.
        if sys_queue.full():
            sys_pipe.levels.dropped += 1
            return
        sys_queue.put_nowait(chunk)

    def on_loopback(chunk: np.ndarray) -> None:
        loop.call_soon_threadsafe(push, chunk)

    from audio_loopback import LoopbackCapture

    capture = LoopbackCapture(on_loopback)
    capture.start()

    async def drain_system_audio() -> None:
        while True:
            chunk = await sys_queue.get()
            try:
                await sys_pipe.feed(chunk)
            except Exception as e:
                print(json.dumps({"error": "them: " + str(e)}), flush=True)

    asyncio.create_task(drain_system_audio())

    detector = "silero" if gate is not None else "порог"

    async def report_levels() -> None:
        """Раз в STATS_EVERY_S печатаем, что слышно на каждом канале.

        Это единственный способ обсуждать качество звука цифрами: где пол
        шума, насколько речь его превышает и остаётся ли запас над порогом,
        за которым реплика вообще попадает в модель.
        """
        while True:
            await asyncio.sleep(STATS_EVERY_S)
            print(
                json.dumps({
                    "stats": {
                        "me": mic.levels.report(mic.vad_threshold, detector),
                        "them": sys_pipe.levels.report(sys_pipe.vad_threshold, detector),
                    }
                }, ensure_ascii=False),
                flush=True,
            )

    asyncio.create_task(report_levels())

    async def on_control(ws, raw: str) -> None:
        """Текстовые кадры — управление; звук идёт бинарными.

        Пока одно сообщение: словарь распознавания. Он меняется посреди созвона
        без перезапуска — модель грузится секунды, а тема разговора сменяется
        за одну реплику. В ответ сообщаем, сколько терминов реально влезло.
        """
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(msg, dict) or msg.get("type") != "hotwords":
            return
        terms = msg.get("terms")
        if not isinstance(terms, list):
            return
        info = transcriber.set_terms(terms[:300])
        await ws.send(json.dumps({"type": "hotwords", **info}, ensure_ascii=False))

    async def handle(ws) -> None:
        q = parse_qs(urlparse(ws.request.path).query)
        if q.get("token", [""])[0] != args.token:
            await ws.close(code=4001, reason="unauthorized")
            return
        channel = q.get("ch", ["them"])[0]
        hub.add(channel, ws)
        try:
            async for raw in ws:
                if isinstance(raw, str):
                    await on_control(ws, raw)
                    continue
                # Собеседника захватываем сами; от клиента ждём только микрофон.
                if channel != "me":
                    continue
                await mic.feed(np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0)
        finally:
            hub.drop(channel, ws)

    # Ждём, пока поток захвата сообщит устройство или ошибку.
    await asyncio.sleep(0.6)
    print(
        json.dumps({
            "ready": True,
            "engine": engine.name,
            "label": engine.label,
            "model": args.model,
            "device": engine.device,
            "computeType": engine.compute_type,
            # почему работаем не на видеокарте NVIDIA; None — всё штатно
            "fallbackReason": fallback,
            "loopbackDevice": capture.device_name,
            "loopbackError": capture.error,
        }, ensure_ascii=False),
        flush=True,
    )

    async with websockets.serve(handle, "127.0.0.1", args.port, max_size=2 ** 20):
        await asyncio.Future()


if __name__ == "__main__":
    # В канале до Electron по умолчанию cp1251: русские имена устройств и
    # сообщения об ошибках приезжали бы кракозябрами.
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    if args.probe:
        print(json.dumps({"probe": probe(args.model)}, ensure_ascii=False), flush=True)
        sys.exit(0)
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        sys.exit(0)
    except EngineError as e:
        fatal(e.code, e.message)
        sys.exit(2)
    except Exception as e:
        # Трассировка уйдёт в stderr, а приложению — одна понятная строка.
        fatal("engine-failed", f"Распознавание речи не запустилось: {type(e).__name__}: {e}")
        raise
