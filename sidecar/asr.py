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
VAD выделяет реплику, а модель переспрашивает растущий буфер, когда до неё
доходит очередь (Transcriber). На видеокарте переспрос идёт каждые
Caps.partial_every_ms (engines.py), и показывается только префикс, совпавший
в двух гипотезах подряд (LocalAgreement-2) — иначе текст мерцает и читать его
невозможно. На процессоре второй гипотезы не дождаться, поэтому черновик
считается, только пока модель свободна, и показывается сразу.
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
STATS_EVERY_S = 20.0
# Сколько раз подряд должна повториться цепочка слов, чтобы счесть её зацикливанием
LOOP_TIMES = 3
# Потолок темпа речи, слов в секунду: норма русской спонтанной речи 2.5-3
MAX_WORDS_PER_S = 5.0

# --- эхо собеседника в микрофоне ---
# Похожесть, при которой считаем реплику эхом уже сказанного собеседником
ECHO_SIMILARITY = 0.72
# ...и только если длины сравнимы: иначе короткое «да, конечно» похоже на
# длинный ответ, который с него начинается
ECHO_LEN_RATIO = (0.6, 1.6)
# Сверяем только с репликами собеседника, звучавшими в то же время, с запасом:
# эхо приходит в микрофон одновременно с оригиналом, а не через 12 с.
ECHO_OVERLAP_S = 1.5
# Короче — не эхо: «да», «ага» говорят обе стороны
ECHO_MIN_CHARS = 6
# Сколько слов должно остаться от реплики, когда из неё вырезано эхо
ECHO_REST_MIN_WORDS = 2
# Сколько хранить реплики собеседника. Сверка идёт по времени звучания, так
# что старые реплики ни с чем лишним не совпадут, а финал микрофона под
# нагрузкой приходит заметно позже самой речи.
ECHO_KEEP_S = 90.0

# --- очередь модели (Transcriber) ---
# Загрузка модели, выше которой процессор не тратит время на черновики:
# финалам всегда должен оставаться свободный воркер.
PARTIAL_LOAD_WINDOW_S = 12.0
PARTIAL_LOAD_MAX = 0.5
# За какое время считаем загрузку модели для health и stats
LOAD_WINDOW_S = 20.0
# Сглаживание оценки стоимости прогона: один выброс (шум, долгое декодирование)
# не должен надолго выключать черновики
COST_EMA = 0.3
# Досчитанный финал микрофона, звучавший поверх собеседника, отдаётся только
# после сверки с его словами — иначе эхо сверялось бы с ещё не распознанной
# фразой и проходило. Ждём не модель, а готовый текст, и не дольше этого.
ECHO_WAIT_S = 20.0
# Реплику собеседника, которая ещё идёт, не ждём до конца: он может говорить
# полминуты, а ответ пользователя висел бы всё это время. Сверяем с его
# свежей гипотезой; нет такой, что покрывает конец нашей речи, — ждём её
# не дольше этого после конца речи. На видеокарте гипотеза обновляется
# каждые 700 мс и ожидание почти не срабатывает, на процессоре финал
# и так приходит позже.
ECHO_OPEN_WAIT_S = 2.0
# Гипотеза годится для сверки, только если в её звук вошло ещё столько после
# конца нашей речи: слово на самом краю буфера модель обрывает или теряет,
# и эхо, совпавшее со всем, кроме последнего слова, прошло бы как речь.
ECHO_DRAFT_MARGIN_S = 0.3
# Как часто пересматривать финалы, которые ждут сверки
HOLD_RECHECK_S = 0.25
# Когда голова очереди ждёт дольше этого, модель отстаёт, и финалы собеседника
# идут раньше реплик микрофона, прозвучавших поверх него: на слова собеседника
# отвечает подсказчик, а такие реплики чаще всего эхо.
THEM_FIRST_WAIT_S = 2.0
ECHO_LIKELY_DUCKED = 0.5
# Сброс нагрузки: реплики микрофона выбрасываются без прогона, только когда
# модель по-настоящему отстаёт (в очереди больше SHED_ME_BACKLOG_S звука
# и старейшая реплика ждёт дольше SHED_WAIT_S) и реплика похожа на эхо:
# почти целиком поверх собеседника и заметно тише обычного голоса
# пользователя. Одна длинная очередь без ожидания — не отставание: реплика
# в 26 с на видеокарте считается за полсекунды. А «поверх собеседника» само
# по себе не эхо: перебивку и ответ во время его фразы терять нельзя.
SHED_ME_BACKLOG_S = 20.0
SHED_WAIT_S = 6.0
SHED_DUCKED_SHARE = 0.8
SHED_QUIET_DB = 6.0
# Сколько замеров своего голоса нужно, чтобы судить, что реплика тише обычного
OWN_LEVEL_MIN_SAMPLES = 20
# На видеокарте ритм черновиков — от прошлой просьбы о прогоне, но между концом
# одного прогона и следующим оставляем хотя бы столько: на медленной
# видеокарте прогоны иначе шли бы вплотную и занимали модель целиком.
PARTIAL_REST_MS = 150
HEALTH_EVERY_S = 5.0
# Шаг, которым меряем, насколько event loop не успевает к своим задачам
LOOP_TICK_S = 0.1


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
# Короткие, но настоящие ответы. Проверка «две буквы и меньше — огрызок»
# выбрасывала «Да.», «Ок.» и «Ну», а черновик реплики так и висел на экране.
SHORT_WORDS = frozenset({
    "да", "ок", "ну", "не", "но", "а", "и", "я", "ты", "вы", "мы", "он", "от", "до",
    "на", "за", "по", "так", "вот", "нет", "ага", "угу",
})


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


def looks_like_noise(text: str, dur_s: float = 0.0, audio_s: float = 0.0) -> bool:
    """Похоже ли это на выдумку, а не на речь.

    Опираться на no_speech_prob нельзя: на наших весах large-v3-turbo он
    равен РОВНО 0.0 у каждого сегмента (проверено запуском; в faster-whisper
    на это открыты issue #1028 и #1128). avg_logprob тоже не спасает — на
    чистом шуме модель выдала «Продолжение следует...» с уверенностью
    −0.142, то есть очень высокой. Поэтому решают текстовые признаки.

    dur_s — сколько речи насчитал движок, audio_s — сколько звука ушло в модель.
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
    # Одиночный короткий огрызок без гласных смысла не несёт — если это не
    # короткий ответ из SHORT_WORDS
    if len(t) <= 2 and re.sub(r"\W", "", t) not in SHORT_WORDS:
        return True

    words = t.split()
    if loops(words):
        return True
    # Русская спонтанная речь идёт 2.5-3 слова в секунду. Вдвое быстрее —
    # это не расшифровка, а поток, придуманный поверх тишины. Делим на длину
    # звука, а не только на span сегментов: на CUDA span короче звучания, и
    # быстрая, но настоящая фраза «Ну, а я не знаю, да, это же не так.» за
    # 1.6 с span выходила за 6 слов в секунду и пропадала.
    dur = max(dur_s, audio_s)
    if dur >= 1.0 and len(words) / dur > MAX_WORDS_PER_S:
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


_WORD = re.compile(r"\w+")


def _words(text: str) -> list[str]:
    """Слова без знаков и регистра: «Ну, понятно.» и «ну понятно» — одно и то же."""
    return [w.lower() for w in _WORD.findall(text)]


def _find(needle: list[str], hay: list[str]) -> int:
    """С какого слова цепочка needle стоит в hay подряд; -1 — нигде."""
    n = len(needle)
    if n == 0:
        return -1
    for i in range(len(hay) - n + 1):
        if hay[i:i + n] == needle:
            return i
    return -1


class CrossTalk:
    """
    Общее состояние двух каналов.

    Звук собеседника из динамиков попадает в микрофон и распознаётся как речь
    пользователя — на записи это выглядит как будто он сам произнёс чужую фразу.
    Ловим это двумя способами: пока собеседник говорит, микрофону поднимаем
    порог; а уже распознанный текст сверяем с тем, что собеседник говорил
    В ТО ЖЕ ВРЕМЯ.
    """

    def __init__(self) -> None:
        self._them_until = 0.0
        # (начало, конец звучания по time.monotonic(), текст)
        self._recent: list[tuple[float, float, str]] = []
        # Свежая гипотеза ещё идущей реплики собеседника: (начало, до какого
        # момента звук вошёл в прогон, текст). Финал её придёт не скоро.
        self._draft: tuple[float, float, str] | None = None

    def note_them_active(self) -> None:
        self._them_until = time.monotonic() + DUCK_HANGOVER_MS / 1000

    def them_active(self) -> bool:
        return time.monotonic() < self._them_until

    def note_them_text(self, text: str, start: float, end: float) -> None:
        # Пустую реплику записывать нельзя: сравнивать с ней нечего, а совпасть
        # «по похожести» с пустотой может что угодно. Собеседник молчит — эха нет.
        if not _words(text):
            return
        now = time.monotonic()
        # Храним интервал ЗВУЧАНИЯ, а не момент распознавания: под нагрузкой
        # финал приходит на секунды позже, и окно «последние 12 с» сравнивало
        # микрофон с чем попало.
        self._recent.append((start, end, text))
        self._recent = [r for r in self._recent if now - r[1] < ECHO_KEEP_S]

    def note_them_draft(self, text: str, start: float, until: float) -> None:
        """Гипотеза идущей реплики собеседника. Пустой текст тоже знание: слов пока нет."""
        self._draft = (start, until, text)

    def drop_them_draft(self) -> None:
        # Реплика закрылась: дальше сверяемся с её финалом, а не с черновиком.
        self._draft = None

    def draft_until(self) -> float:
        """До какого момента звук собеседника уже распознан черновиком; 0 — черновика нет."""
        return self._draft[1] if self._draft is not None else 0.0

    def is_echo(self, text: str, start: float, end: float) -> str:
        """Что остаётся от реплики пользователя после вычета эха. Пусто — это всё эхо.

        Раньше выбрасывалась вся реплика, если в ней нашлась фраза собеседника:
        «Ну, понятно. А что дальше делать?» пропадала целиком из-за «Понятно.»,
        сказанного им за 10 секунд до того.
        """
        heard = list(self._recent)
        if self._draft is not None and _words(self._draft[2]):
            heard.append(self._draft)
        for t_start, t_end, said in heard:
            if t_start - ECHO_OVERLAP_S > end or start > t_end + ECHO_OVERLAP_S:
                continue
            text = self._strip(text, said)
            if not text:
                return ""
        return text

    @staticmethod
    def _strip(text: str, said: str) -> str:
        mine, theirs = _words(text), _words(said)
        probe, heard = " ".join(mine), " ".join(theirs)
        if len(probe) < ECHO_MIN_CHARS:
            return text
        # Реплика целиком внутри фразы собеседника — это его голос из динамиков.
        if _find(mine, theirs) >= 0:
            return ""
        # Фраза собеседника внутри реплики: эхо и ответ пользователя попали
        # в один буфер. Проверяем раньше похожести: «Ты меня слышишь? Да,
        # слышу.» похожа на «Ты меня слышишь?» на 0.77 и ушла бы целиком.
        at = _find(theirs, mine) if len(heard) >= ECHO_MIN_CHARS else -1
        if at < 0:
            ratio = len(probe) / max(1, len(heard))
            if ECHO_LEN_RATIO[0] <= ratio <= ECHO_LEN_RATIO[1] and \
                    SequenceMatcher(None, probe, heard).ratio() >= ECHO_SIMILARITY:
                return ""
            return text
        # Вырезаем эхо, ответ оставляем.
        spans = [m.span() for m in _WORD.finditer(text)]
        left = text[:spans[at][0]].rstrip(" ,;:—–-")
        right = text[spans[at + len(theirs) - 1][1]:].lstrip(" .,!?;:…—–-")
        parts = [p for p in (left, right) if _words(p)]
        # Одно слово, прилипшее к эху с краю, — скорее обрывок той же фразы,
        # чем мысль пользователя: «Ну, понятно.» → «Ну» не нужно.
        if len(parts) == 2:
            sizes = [len(_words(p)) for p in parts]
            if max(sizes) >= ECHO_REST_MIN_WORDS > min(sizes):
                parts = [parts[sizes.index(max(sizes))]]
        rest = " ".join(parts)
        if len(_words(rest)) < ECHO_REST_MIN_WORDS:
            return ""
        return rest[0].upper() + rest[1:]


@dataclass
class _Final:
    """Закрытая реплика в очереди модели. Звук — копия: буфер канала уже живёт дальше."""

    pipe: "Pipeline"
    # номер реплики в канале (Pipeline.utt на момент закрытия)
    utt: int
    audio: np.ndarray
    start_ms: int
    # интервал звучания по time.monotonic(): по нему сверяется эхо
    began: float
    ended: float
    # доля реплики, прозвучавшая поверх собеседника
    ducked: float
    queued: float
    # типичный уровень реплики, dBFS; None — не мерили
    db: float | None = None


@dataclass
class _Partial:
    """Просьба переспросить открытую реплику. Звук снимается при ЗАПУСКЕ прогона."""

    pipe: "Pipeline"
    utt: int
    queued: float


class Transcriber:
    """Единственная очередь к модели и единственный воркер при ней.

    Одна модель на оба канала: на видеокарте они подрались бы за память,
    на процессоре — за ядра.

    Раньше модель звали прямо из Pipeline.feed под общим замком. Пока шло
    распознавание — своё или чужого канала, — обработчик микрофона не читал
    сокет: на процессоре всегда, на видеокарте — как только прогон вместе
    с ожиданием замка дорастал до 700 мс. Звук копился в TCP, через ~20 с
    websockets закрывал сокет по keepalive, и голос пропадал до Стоп/Старт.
    Теперь feed только режет реплики и ставит работу сюда: финалы идут
    первыми и по порядку, черновики — если на них есть время.

    Финал микрофона считается сразу, а отдаётся после сверки с собеседником,
    если тот звучал тогда же (_unchecked). Раньше такой финал ждал в очереди
    конца всей фразы собеседника: ответ, сказанный во время его длинной
    реплики, приходил через 6–20 с, хотя модель простаивала.
    """

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        # сколько заняло последнее распознавание
        self.last_run_s = 0.0
        # каналы по имени: финалу микрофона надо знать, говорит ли ещё собеседник
        self.pipes: dict = {}
        self._finals: deque = deque()
        # досчитанные финалы микрофона (финал, текст), ждущие сверки с собеседником;
        # отдаются строго по порядку, иначе строки в ленте встанут вперемешку
        self._ready: deque = deque()
        # не больше одной просьбы о черновике на канал
        self._partials: dict = {}
        self._running: _Final | _Partial | None = None
        self._run_started = 0.0
        # (начало, конец) недавних прогонов — для загрузки модели
        self._busy: deque = deque()
        # окно кодировщика, с -> скользящее среднее длительности прогона
        self._cost: dict = {}
        # Первая оценка — прогрев из select_engine. Отдельный холостой прогон
        # ради замера стоил бы на процессоре ещё секунду старта.
        warm = float(getattr(engine, "warm_up_s", 0.0) or 0.0)
        if warm > 0:
            self._cost[self._window(1.0)] = warm
        self._epoch = getattr(engine, "epoch", 0)
        self._wake: asyncio.Event | None = None
        self._worker: asyncio.Task | None = None

    @property
    def idle_partials(self) -> bool:
        """Черновики только в простое модели — так на процессоре (Caps.backoff > 0).

        Там LocalAgreement-2 не дожидается второй гипотезы: переспрос стоит
        секунду и больше, реплика кончается раньше. Замер: почти половина
        времени модели уходила на черновики, из которых не показывался ни один.
        """
        return self.engine.caps.backoff > 0

    def attach(self, pipe: "Pipeline") -> None:
        self.pipes[pipe.channel] = pipe

    def set_terms(self, terms: list) -> dict:
        return self.engine.set_terms(terms)

    def start(self) -> None:
        """Поднять воркер. Нужен работающий event loop."""
        if self._worker is None or self._worker.done():
            self._wake = asyncio.Event()
            self._worker = asyncio.get_running_loop().create_task(self._work())

    async def aclose(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except BaseException:
                pass
            self._worker = None

    # --- оценка стоимости и загрузки ---

    def _window(self, audio_s: float) -> float:
        # Окно называет сам движок: у процессора 10/15/20 с, у Vulkan в режиме
        # лесенки 20.48/25.6 с, у CUDA и полного окна — None, то есть 30 с.
        enc = getattr(self.engine, "encoder_window", None)
        if enc is not None:
            return enc(audio_s) or 30
        pick = getattr(self.engine, "_cpu_window", None)
        w = pick(audio_s) if (pick is not None and self.idle_partials) else None
        return w or 30

    def _follow_engine(self) -> None:
        """Движок сменил устройство посреди сессии (Vulkan упал — теперь процессор):
        оценки стоимости прошлого устройства к новому не относятся."""
        epoch = getattr(self.engine, "epoch", 0)
        if epoch == self._epoch:
            return
        self._epoch = epoch
        self._cost.clear()
        warm = float(getattr(self.engine, "warm_up_s", 0.0) or 0.0)
        if warm > 0:
            self._cost[self._window(1.0)] = warm

    def expected_cost(self, audio_s: float) -> float:
        """Сколько, скорее всего, займёт прогон такой длины. Стоимость задаёт окно
        кодировщика, а не длина фразы: 1.5 с и 7 с в окне 10 с стоят почти одинаково."""
        w = self._window(audio_s)
        if w in self._cost:
            return self._cost[w]
        if self._cost:
            known = min(self._cost, key=lambda k: abs(k - w))
            return self._cost[known] * w / known
        return max(self.last_run_s, 0.5) * w / 10

    def load(self, window_s: float, now: float | None = None) -> float:
        """Доля времени, которую модель считала за последние window_s секунд."""
        now = time.monotonic() if now is None else now
        lo = now - window_s
        busy = sum(min(e, now) - max(s, lo) for s, e in self._busy if e > lo)
        if self._running is not None:
            busy += now - max(self._run_started, lo)
        return min(1.0, max(0.0, busy / window_s))

    def backlog(self, channel: str | None = None) -> tuple[float, int]:
        """Секунды звука в очереди финалов и в идущем финале; сколько финалов ждёт.

        Идущий черновик не считаем: на видеокарте он переспрашивает буфер до
        30 с каждые 700 мс, и отставание «в 25 с» пугало бы на ровном месте.
        """
        queued = [j for j in self._finals if channel is None or j.pipe.channel == channel]
        samples = sum(j.audio.size for j in queued)
        run = self._running
        if isinstance(run, _Final) and (channel is None or run.pipe.channel == channel):
            samples += run.audio.size
        return samples / SAMPLE_RATE, len(queued)

    def delay(self, channel: str | None = None, now: float | None = None) -> float:
        """Сколько уже ждёт самая старая недоставленная реплика — от конца её звучания.

        Это и есть отставание, которое видит пользователь. backlog меряет звук,
        а не время: одна длинная реплика, которая просто считается, давала
        «задержку 57 с» при финалах за 2 с.
        """
        now = time.monotonic() if now is None else now
        jobs = [*self._finals, *(job for job, _ in self._ready)]
        if isinstance(self._running, _Final):
            jobs.append(self._running)
        ends = [j.ended for j in jobs if channel is None or j.pipe.channel == channel]
        return max(0.0, now - min(ends)) if ends else 0.0

    # --- постановка работы (из feed, модель не ждёт) ---

    def submit_final(self, pipe: "Pipeline", audio: np.ndarray, start_ms: int,
                     began: float, ended: float, ducked: float, db: float | None = None) -> None:
        self.start()
        # Реплика закрыта: черновик для неё уже не нужен, финал придёт следом.
        self._partials.pop(pipe.channel, None)
        self._finals.append(_Final(pipe, pipe.utt, audio, start_ms, began, ended, ducked, time.monotonic(), db))
        self._wake.set()

    def offer_partial(self, pipe: "Pipeline", dur_ms: int, now: float) -> None:
        req = self._partials.get(pipe.channel)
        if req is not None and req.utt == pipe.utt:
            return  # уже ждёт; звук возьмём самый свежий, когда до него дойдёт
        run = self._running
        if isinstance(run, _Partial) and run.pipe is pipe:
            return  # ещё считается: следующий попросим, когда он кончится
        every = self.engine.caps.partial_every_ms / 1000
        if self.idle_partials:
            # Процессор: интервал от КОНЦА прошлого прогона — он и так идёт
            # только в простое, и частить здесь незачем.
            if now - pipe.partial_done < every:
                return
            if not self._affordable(dur_ms / 1000, now):
                return
        else:
            # Видеокарта: ритм от НАЧАЛА прошлого прогона, как до очереди, —
            # 700 мс на 5060 Ti. Отсчёт от конца добавлял к ритму сам прогон,
            # и черновиков становилось на треть меньше. Старая ловушка «прогон на
            # каждый чанк» не вернётся: пока черновик канала считается, новый не
            # просим (выше), feed модель не ждёт, а финалы идут вперёд черновиков.
            # Досчитанная реплика микрофона ждёт гипотезы собеседника для сверки
            # эха — её просим сразу, не дожидаясь ритма: иначе ответ пользователя
            # стоял бы до следующего черновика, на 5060 Ti это до 0.7 с. На
            # процессоре так не делаем: там прогон дольше, чем само ожидание.
            wanted = self._draft_wanted(pipe)
            if (now - pipe.partial_asked < every and not wanted) or (now - pipe.partial_done) * 1000 < PARTIAL_REST_MS:
                return
        self.start()
        self._partials[pipe.channel] = _Partial(pipe, pipe.utt, now)
        self._wake.set()

    def _draft_wanted(self, pipe: "Pipeline") -> bool:
        """Ждёт ли какая-нибудь досчитанная реплика микрофона свежей гипотезы этого канала."""
        if pipe.channel != "them" or pipe.cross is None or not self._ready:
            return False
        until = pipe.cross.draft_until()
        return any(until < job.ended + ECHO_DRAFT_MARGIN_S and pipe.began <= job.ended for job, _ in self._ready)

    def _affordable(self, dur_s: float, now: float) -> bool:
        """Может ли процессор сейчас потратиться на черновик."""
        if self._running is not None or self._finals:
            return False
        if self.load(PARTIAL_LOAD_WINDOW_S, now) >= PARTIAL_LOAD_MAX:
            return False
        # Гипотеза, которая досчитается уже после принудительного закрытия
        # реплики, не нужна: финал всё равно придёт следом, а время он ждал бы.
        return (dur_s + self.expected_cost(dur_s)) * 1000 < self.engine.caps.max_utterance_ms

    # --- воркер ---

    @staticmethod
    def _overlap(a: _Final, b: _Final) -> bool:
        """Звучали ли две реплики одновременно.

        Пересечение строгое, без запаса ECHO_OVERLAP_S: эхо не может начаться
        раньше оригинала. С запасом вопрос пользователя, на который собеседник
        ответил через секунду, ждал бы конца всего ответа.
        """
        return a.began <= b.ended and a.ended >= b.began

    def _unchecked(self, job: _Final, text: str, now: float) -> bool:
        """Рано ли отдавать досчитанный финал микрофона: собеседник звучал тогда
        же, а его слова ещё неизвестны, и эхо прошло бы в расшифровку строкой «Я»."""
        if job.pipe.channel != "me" or job.pipe.cross is None or not text:
            return False
        if now - job.ended >= ECHO_WAIT_S:
            return False
        # Реплика собеседника уже закрыта и стоит в очереди или считается —
        # ждём её финала: это один прогон, и _pick_final пустит его первым.
        for other in (*self._finals, self._running):
            if isinstance(other, _Final) and other.pipe.channel == "them" and self._overlap(other, job):
                return True
        them = self.pipes.get("them")
        if them is None or not them.speaking or them.began > job.ended:
            return False
        # Ещё говорит: хватит гипотезы, в которую вошёл конец нашей речи. Даже
        # если он уже замолкает — ждать финала ради того же текста значило бы
        # добавить к ответу пользователя секунду: так и было на 5060 Ti, когда
        # обе стороны договаривали длинные реплики почти одновременно.
        if job.pipe.cross.draft_until() >= job.ended + ECHO_DRAFT_MARGIN_S:
            return False
        return now - job.ended < ECHO_OPEN_WAIT_S

    async def _flush(self, now: float) -> None:
        """Отдать досчитанные финалы микрофона, для которых сверка уже возможна."""
        while self._ready:
            job, text = self._ready[0]
            if self._unchecked(job, text, now):
                return
            self._ready.popleft()
            try:
                await job.pipe._deliver_final(job, text)
            except Exception as e:
                log_error(f"{job.pipe.channel}: {e}")

    def _shed(self, now: float) -> list[_Final]:
        me = [j for j in self._finals if j.pipe.channel == "me"]
        total = sum(j.audio.size for j in me) / SAMPLE_RATE
        if len(me) < 2 or total <= SHED_ME_BACKLOG_S or now - me[0].queued < SHED_WAIT_S:
            return []
        own = me[0].pipe.own_level()
        if own is None:
            return []  # не с чем сравнить громкость — не выбрасываем ничего
        # Финалы собеседника не трогаем никогда: на них отвечает подсказчик.
        # Выбрасываем с самых старых и ровно столько, чтобы очередь вернулась
        # под порог: каждая лишняя выброшенная реплика может оказаться речью.
        drop = []
        for j in me:
            if total <= SHED_ME_BACKLOG_S:
                break
            if j.ducked >= SHED_DUCKED_SHARE and j.db is not None and j.db <= own - SHED_QUIET_DB:
                drop.append(j)
                total -= j.audio.size / SAMPLE_RATE
        for j in drop:
            self._finals.remove(j)
        return drop

    def _pick_final(self, now: float) -> _Final:
        """Какой финал считать следующим. По порядку закрытия, с одним исключением.

        Финал собеседника идёт раньше реплик микрофона, если те всё равно ждали бы
        его для сверки (звучали одновременно) или если модель отстаёт, а они
        прозвучали в основном поверх собеседника. Реплику, сказанную не поверх
        него, финал собеседника не обгоняет никогда — кроме случая, когда его ждёт
        уже досчитанная реплика микрофона: та закрылась раньше всей очереди.
        """
        head = self._finals[0]
        if head.pipe.channel != "me":
            return head
        them = [j for j in self._finals if j.pipe.channel == "them"]
        for t in them:
            if any(self._overlap(t, job) for job, _ in self._ready):
                return t
        lagging = now - head.queued >= THEM_FIRST_WAIT_S
        for job in self._finals:
            if job.pipe.channel == "them":
                return job
            waits = any(self._overlap(t, job) for t in them)
            if not (waits or (lagging and job.ducked >= ECHO_LIKELY_DUCKED)):
                break
        return head

    def _next(self, now: float) -> _Final | _Partial | None:
        if self._finals:
            job = self._pick_final(now)
            self._finals.remove(job)
            return job
        while self._partials:
            ch = min(self._partials, key=lambda c: self._partials[c].queued)
            req = self._partials.pop(ch)
            pipe = req.pipe
            if req.utt != pipe.utt or not pipe.speaking or not pipe.buf:
                continue  # реплика уже закрыта
            if self.idle_partials and not self._affordable(pipe.samples / SAMPLE_RATE, now):
                continue  # пока ждала, появилась работа поважнее; feed попросит снова
            return req
        return None

    async def _work(self) -> None:
        while True:
            try:
                now = time.monotonic()
                await self._flush(now)
                for job in self._shed(now):
                    await job.pipe._drop_final(job)
                job = self._next(now)
                if job is None:
                    self._wake.clear()
                    try:
                        # Финалы, ждущие сверки, надо пересматривать и без
                        # внешнего повода: срок ожидания истекает сам.
                        await asyncio.wait_for(self._wake.wait(), HOLD_RECHECK_S if self._ready else None)
                    except asyncio.TimeoutError:
                        pass
                    continue
                await self._execute(job)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Воркер один на оба канала: если он умрёт, распознавание встанет
                # целиком и молча. Пишем и живём дальше.
                log_error(f"очередь распознавания: {type(e).__name__}: {e}")
                await asyncio.sleep(0.1)

    async def _execute(self, job: _Final | _Partial) -> None:
        pipe = job.pipe
        final = isinstance(job, _Final)
        # Черновик считаем по звуку на момент запуска: он самый свежий.
        audio = job.audio if final else np.concatenate(pipe.buf)
        self._running = job
        started = self._run_started = time.monotonic()
        if not final:
            pipe.partial_runs += 1
            # Ритм — от просьбы, которая привела к прогону: feed просит на границе
            # чанка, а воркер стартует на миллисекунды позже, и отсчёт от старта
            # сдвигал бы каждый следующий черновик на целый чанк, 50 мс.
            pipe.partial_asked = job.queued
        text, failed = "", False
        try:
            text = await asyncio.to_thread(self._sync, audio)
        except Exception as e:
            # CUDA out of memory, cuBLAS после сброса драйвера и прочее: реплику
            # теряем, канал — нет. Раньше такое исключение закрывало сокет
            # микрофона, и голос пропадал до конца сессии.
            failed = True
            log_error(f"{pipe.channel}: {e}")
        finally:
            ended = time.monotonic()
            self._running = None
            self.last_run_s = ended - started
            self._busy.append((started, ended))
            while self._busy and self._busy[0][1] < ended - LOAD_WINDOW_S:
                self._busy.popleft()
            if getattr(self.engine, "epoch", 0) != self._epoch:
                # Этот прогон уже шёл на новом устройстве после сбоя старого,
                # и в его цене — загрузка модели: в оценку не берём.
                self._follow_engine()
            elif not failed:
                w = self._window(audio.size / SAMPLE_RATE)
                old = self._cost.get(w)
                self._cost[w] = self.last_run_s if old is None else old + COST_EMA * (self.last_run_s - old)
                if final:
                    # Сторож Vulkan: финалы вдвое дороже, чем на стартовой проверке, —
                    # видеокарту заняли, пора на процессор (vulkan.VulkanEngine.note_final)
                    watch = getattr(self.engine, "note_final", None)
                    if watch is not None:
                        watch(audio.size / SAMPLE_RATE, self.last_run_s)
            if not final:
                pipe.partial_done = ended
        try:
            if final and pipe.channel == "me" and (self._ready or self._unchecked(job, text, ended)):
                # Сверять эхо ещё не с чем, или раньше ждёт своей сверки прошлая
                # реплика. Модель при этом свободна для остального.
                self._ready.append((job, text))
            elif final:
                await pipe._deliver_final(job, text)
            elif not failed:
                await pipe._deliver_partial(job.utt, text, started)
        except Exception as e:
            log_error(f"{pipe.channel}: {e}")

    def _sync(self, audio: np.ndarray) -> str:
        text, span = self.engine.transcribe(audio)
        # Длительность нужна фильтру, чтобы поймать неправдоподобный темп речи.
        return "" if looks_like_noise(text, span, audio.size / SAMPLE_RATE) else text


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
    # когда в реплике услышана речь, по time.monotonic()
    began: float = 0.0
    speaking: bool = False
    silence_ms: int = 0
    hangover_ms: int = 0
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
    # Номер реплики: черновик, досчитанный для уже закрытой, выбрасывается.
    utt: int = 0
    # сколько сэмплов реплики прозвучало, пока говорил собеседник, и сколько
    # в ней подклеенного пред-ролла: его в долю не считаем ни туда, ни сюда
    ducked_samples: int = 0
    pre_used: int = 0
    # когда попросили прошлый прогон черновика этого канала и когда он кончился
    partial_asked: float = 0.0
    partial_done: float = 0.0
    # Уровни речи текущей реплики и голоса без собеседника, dBFS. Сброс
    # нагрузки по ним отличает тихое эхо из динамиков от пользователя,
    # который говорит поверх собеседника обычным голосом.
    utt_db: list = field(default_factory=list)
    own_db: deque = field(default_factory=lambda: deque(maxlen=500))
    # --- для stats ---
    lag_max: float = 0.0
    partial_runs: int = 0
    partials_shown: int = 0
    echo_dropped: int = 0
    empty_finals: int = 0

    def __post_init__(self) -> None:
        attach = getattr(self.transcriber, "attach", None)
        if attach is not None:
            attach(self)

    def reset(self) -> None:
        # Кольцо пред-ролла НЕ трогаем: оно наполняется в тишине между
        # репликами и нужно уже следующей.
        self.utt += 1
        # Новый список, а не clear(): закрытая реплика уже скопирована в финал,
        # и ничто не должно увидеть, как её буфер меняется.
        self.buf = []
        self.samples = 0
        self.speaking = False
        self.silence_ms = 0
        self.prev_hyp = ""
        self.shown = ""
        self.ducked_samples = 0
        self.pre_used = 0
        self.utt_db = []
        if self.channel == "them" and self.cross is not None:
            self.cross.drop_them_draft()

    def own_level(self) -> float | None:
        """Обычный уровень голоса на канале, пока собеседник молчит; None — мало замеров."""
        if len(self.own_db) < OWN_LEVEL_MIN_SAMPLES:
            return None
        return float(np.median(np.fromiter(self.own_db, dtype=np.float32)))

    def restart(self) -> None:
        """Звук пошёл заново: переподключился микрофон или его сокет закрылся.

        Недосказанная реплика и пред-ролл принадлежат старому потоку. Если их
        оставить, новый поток продолжит чужую реплику с середины.
        """
        self.reset()
        self.pre.clear()
        self.pre_samples = 0
        self.win.clear()
        self.win_samples = 0
        self.hangover_ms = 0
        self.gate_debt = 0
        self.gate_says = False

    async def feed(self, chunk: np.ndarray, arrived: float | None = None) -> None:
        """Режет звук на реплики. Модель здесь не ждём никогда — см. Transcriber.

        arrived — когда чанк пришёл в процесс, по time.monotonic(): по нему
        считается задержка чтения для stats.
        """
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
            if active:
                self.utt_db.append(level)
                if not ducked:
                    self.own_db.append(level)
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
            self.pre_used = self.pre_samples
            pre_ms = int(self.pre_samples / SAMPLE_RATE * 1000)
            # Время реплики — по приходу звука сюда: feed больше не ждёт модель
            # и идёт вровень с речью. Не уходим в минус: у самого начала сессии
            # пред-ролл длиннее, чем всё прошедшее время, а отрицательная метка
            # ломает ленту.
            now_s = time.monotonic()
            self.start_ms = max(0, int((now_s - self.t0) * 1000) - pre_ms)
            # Звучание — с момента, когда речь услышана, без пред-ролла: тот
            # подклеен про запас и сдвигал бы начало на 0.4 с раньше речи.
            self.began = now_s
            self.pre.clear()
            self.pre_samples = 0

        if self.speaking:
            self.buf.append(chunk)
            self.samples += chunk.size
            if ducked:
                self.ducked_samples += chunk.size
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

        if self.speaking and dur_ms >= max(MIN_UTTERANCE_MS, caps.min_partial_ms):
            self.transcriber.offer_partial(self, dur_ms, now)

        endpoint = ENDPOINT_SILERO_MS if self.gate is not None else ENDPOINT_MS
        if self.speaking and (self.silence_ms >= endpoint or dur_ms >= caps.max_utterance_ms):
            # reset() обязан выполниться в любом случае: если постановка финала
            # бросит исключение, а буфер останется, канал больше никогда не
            # закроет реплику — он будет расти и переспрашиваться целиком.
            # Потерять одну реплику дешевле, чем потерять канал.
            try:
                self._finish(dur_ms, now)
            finally:
                self.reset()

        if arrived is not None:
            self.lag_max = max(self.lag_max, time.monotonic() - arrived)

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

    def _finish(self, dur_ms: int, now: float) -> None:
        """Поставить закрытую реплику в очередь. Модель не ждём."""
        if dur_ms < MIN_UTTERANCE_MS:
            return
        # Считаем только то, что реально уходит в модель: обрывки короче
        # MIN_UTTERANCE_MS отбрасываются, и в счётчике им не место — иначе
        # цифра врёт в разы, а на неё смотрят как на диагностику.
        self.levels.utterances += 1
        audio = self._voiced()
        self.transcriber.submit_final(
            self, audio, self.start_ms, self.began,
            # конец звучания, а не момент закрытия: эндпойнт ещё ждал тишину
            now - self.silence_ms / 1000,
            # Без пред-ролла: это тишина до речи, и чистое эхо на 8 с набирало
            # долю «поверх собеседника» только 0.79 — ниже порога сброса нагрузки.
            self.ducked_samples / max(1, self.samples - self.pre_used),
            # Верхняя четверть, а не среднее: паузы между словами тянули бы
            # уровень вниз, и обычная речь выглядела бы тихим эхом.
            float(np.percentile(self.utt_db, 75)) if self.utt_db else rms_dbfs(audio),
        )

    async def _deliver_partial(self, utt: int, hyp: str, at: float | None = None) -> None:
        """at — когда начался прогон: звук реплики до этого момента в гипотезу вошёл."""
        if utt != self.utt or not self.speaking:
            return  # реплика закрылась, пока считался черновик: финал уже в очереди
        if self.channel == "them" and self.cross is not None:
            # Финал идущей реплики собеседника может прийти через полминуты,
            # а сверять с ней эхо микрофона надо уже сейчас.
            self.cross.note_them_draft(hyp, self.began, time.monotonic() if at is None else at)
        if self.transcriber.idle_partials:
            # Второй гипотезы на процессоре не дождаться — показываем первую.
            stable = hyp
        else:
            stable = common_prefix(self.prev_hyp, hyp)
            self.prev_hyp = hyp
        if stable and stable != self.shown:
            self.shown = stable
            self.partials_shown += 1
            await self.emit("partial", self.channel, stable, self.start_ms)

    async def _deliver_final(self, job: _Final, text: str) -> None:
        if self.cross is not None:
            if self.channel == "them":
                self.cross.note_them_text(text, job.began, job.ended)
            elif text:
                kept = self.cross.is_echo(text, job.began, job.ended)
                if not kept:
                    # Это не пользователь, это динамики.
                    self.echo_dropped += 1
                text = kept
        await self._emit_final(text, job.start_ms)

    async def _drop_final(self, job: _Final) -> None:
        """Реплика выброшена без прогона при сбросе нагрузки — почти наверняка эхо."""
        self.echo_dropped += 1
        await self._emit_final("", job.start_ms)

    async def _emit_final(self, text: str, start_ms: int) -> None:
        # Пустой финал тоже отправляем: он значит «реплика закрыта, строки нет».
        # Без него черновик этой реплики оставался на экране навсегда.
        if not text:
            self.empty_finals += 1
        await self.emit("final", self.channel, text, start_ms)

    def report(self, detector: str) -> dict:
        """Уровни плюс здоровье очереди для stats. Задержку чтения копим до отчёта."""
        backlog, queued = self.transcriber.backlog(self.channel)
        out = self.levels.report(self.vad_threshold, detector)
        out.update({
            "lagS": round(self.lag_max, 2),
            "backlogS": round(backlog, 1),
            "delayS": round(self.transcriber.delay(self.channel), 1),
            "queuedFinals": queued,
            "partialRuns": self.partial_runs,
            "partialsShown": self.partials_shown,
            "echoDropped": self.echo_dropped,
            "emptyFinals": self.empty_finals,
        })
        self.lag_max = 0.0
        return out


class Hub:
    """Держит подключённых клиентов и раздаёт им результаты по каналам."""

    def __init__(self) -> None:
        self.clients: dict = {"me": set(), "them": set()}

    def add(self, channel: str, ws) -> None:
        self.clients.setdefault(channel, set()).add(ws)

    def drop(self, channel: str, ws) -> None:
        self.clients.get(channel, set()).discard(ws)

    async def send(self, kind: str, channel: str, text: str, start_ms: int, db: float | None = None) -> None:
        # Пустой черновик ничего не значит, а пустой финал значит «реплика
        # закрыта, строки нет, убери черновик» — его отправляем всегда.
        if kind == "partial" and not text:
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

    async def broadcast(self, payload: str) -> None:
        """Во все открытые сокеты, какого бы канала они ни были."""
        for channel, sockets in list(self.clients.items()):
            for ws in list(sockets):
                try:
                    await ws.send(payload)
                except Exception:
                    self.drop(channel, ws)


def _emit(obj: dict) -> None:
    # Одной записью, а не print: print пишет строку и перевод строки двумя
    # вызовами, а события теперь идут и из потока, читающего stderr помощника
    # Vulkan. Чужая строка между ними склеила бы два JSON в одну нечитаемую.
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fatal(code: str, message: str) -> None:
    """Последнее слово перед выходом: приложение покажет message вместо трассировки."""
    _emit({"fatal": {"code": code, "message": message}})


def log_error(message: str) -> None:
    _emit({"error": message})


def log_event(name: str, **fields) -> None:
    _emit({"event": name, **fields})


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int)
    ap.add_argument("--token")
    ap.add_argument("--model", default="large-v3-turbo")
    # тип для CUDA; на процессоре всегда int8
    ap.add_argument("--compute-type", default="int8_float16")
    ap.add_argument("--language", default="ru")
    ap.add_argument("--glossary", default="")
    # auto — видеокарта NVIDIA, если CUDA заработала; иначе Vulkan, если пакет
    # скачан и стартовая проверка его пустила; иначе процессор.
    # vulkan — только Vulkan (разработка и проверка на AMD/Intel)
    ap.add_argument("--device", choices=("auto", "cuda", "cpu", "vulkan"), default="auto")
    # Пакет ускорения на AMD/Intel: помощник podskazych-vk.exe и модель ggml.
    # Приложение передаёт оба, только если пакет установлен.
    ap.add_argument("--vk-helper")
    ap.add_argument("--ggml-model")
    # Куда помнить итог стартовой проверки Vulkan и сбои (userData/stt-cache)
    ap.add_argument("--cache-dir")
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
        vk_helper=getattr(args, "vk_helper", None),
        ggml_model=getattr(args, "ggml_model", None),
        cache_dir=getattr(args, "cache_dir", None),
        noise=looks_like_noise,
        event=log_event,
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
    transcriber.start()

    # Системный звук: поток PyAudio -> очередь -> обработчик в event loop.
    sys_queue: asyncio.Queue = asyncio.Queue(maxsize=200)

    def push(chunk: np.ndarray, arrived: float) -> None:
        # Переполнение значит, что обработка не успевает за захватом.
        # Раньше чанк выбрасывался молча — то есть кусок чужой речи пропадал,
        # и понять это по расшифровке было нельзя. Теперь считаем.
        if sys_queue.full():
            sys_pipe.levels.dropped += 1
            return
        sys_queue.put_nowait((chunk, arrived))

    def on_loopback(chunk: np.ndarray) -> None:
        # Время прихода берём в потоке захвата: так в lagS попадает и ожидание
        # в очереди, и задержка самого event loop.
        loop.call_soon_threadsafe(push, chunk, time.monotonic())

    from audio_loopback import LoopbackCapture

    capture = LoopbackCapture(on_loopback)
    capture.start()

    async def drain_system_audio() -> None:
        while True:
            chunk, arrived = await sys_queue.get()
            try:
                await sys_pipe.feed(chunk, arrived)
            except Exception as e:
                print(json.dumps({"error": "them: " + str(e)}), flush=True)

    asyncio.create_task(drain_system_audio())

    detector = "silero" if gate is not None else "порог"

    async def report_levels() -> None:
        """Раз в STATS_EVERY_S печатаем, что слышно на каждом канале.

        Это единственный способ обсуждать качество звука цифрами: где пол
        шума, насколько речь его превышает и остаётся ли запас над порогом,
        за которым реплика вообще попадает в модель. Там же — успевает ли
        модель: задержка чтения, очередь финалов, судьба черновиков и эха.
        """
        while True:
            await asyncio.sleep(STATS_EVERY_S)
            print(
                json.dumps({
                    "stats": {
                        "me": mic.report(detector),
                        "them": sys_pipe.report(detector),
                        "modelLoad": round(transcriber.load(LOAD_WINDOW_S), 2),
                    }
                }, ensure_ascii=False),
                flush=True,
            )

    asyncio.create_task(report_levels())

    async def report_health() -> None:
        """Раз в HEALTH_EVERY_S — во все сокеты: успевает ли распознавание.

        Отставание раньше было видно только по тому, что строки перестали
        приходить. Теперь приложение может сказать об этом словами.
        """
        while True:
            await asyncio.sleep(HEALTH_EVERY_S)
            backlog, queued = transcriber.backlog()
            await hub.broadcast(json.dumps({
                "type": "health",
                # Каждый раз заново: Vulkan после сбоя посреди сессии становится процессором
                "device": getattr(engine, "device", "cpu"),
                "load": round(transcriber.load(LOAD_WINDOW_S), 2),
                # секунды звука в очереди — для диагностики
                "backlogS": round(backlog, 1),
                # сколько ждёт самая старая реплика — это приложение и показывает
                "delayS": round(transcriber.delay(), 1),
                "queuedFinals": queued,
            }))

    asyncio.create_task(report_health())

    async def watch_loop() -> None:
        """Насколько event loop опаздывает к своим задачам.

        Сокет микрофона читается в том же loop. Время, которое кадр пролежал
        в TCP до чтения, изнутри не увидеть, а вот сам затык loop — видно:
        он и задержал бы чтение. Поэтому его опоздание идёт в lagS микрофона.
        """
        while True:
            started = time.monotonic()
            await asyncio.sleep(LOOP_TICK_S)
            late = time.monotonic() - started - LOOP_TICK_S
            mic.lag_max = max(mic.lag_max, late)

    asyncio.create_task(watch_loop())

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

    # Микрофон один. Когда рендерер переподключается, старый сокет может ещё
    # жить, и два обработчика кормили бы один Pipeline вперемешку.
    current_mic: dict = {"ws": None}

    async def handle(ws) -> None:
        q = parse_qs(urlparse(ws.request.path).query)
        if q.get("token", [""])[0] != args.token:
            await ws.close(code=4001, reason="unauthorized")
            return
        channel = q.get("ch", ["them"])[0]
        if channel == "me":
            old = current_mic["ws"]
            current_mic["ws"] = ws
            if old is not None:
                hub.drop("me", old)
                mic.restart()
                log_event("mic-replaced")
                # Не ждём закрытия здесь: старый клиент может не ответить на
                # close, а новому нужно начинать сразу. 4002 — рендерер знает,
                # что это он сам переподключился, и не переподключается снова.
                asyncio.create_task(old.close(code=4002, reason="replaced"))
        hub.add(channel, ws)
        try:
            async for raw in ws:
                if isinstance(raw, str):
                    try:
                        await on_control(ws, raw)
                    except Exception as e:
                        # Словарь не применился — это не повод рвать соединение.
                        log_error(f"{channel}: управляющее сообщение не обработано: {e}")
                    continue
                # Собеседника захватываем сами; от клиента ждём только микрофон.
                # Сокет, который уже заменён новым, дочитываем вхолостую до закрытия.
                if channel != "me" or current_mic["ws"] is not ws:
                    continue
                arrived = time.monotonic()
                try:
                    await mic.feed(np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0, arrived)
                except Exception as e:
                    # Раньше любое исключение здесь закрывало сокет микрофона,
                    # а рендерер не переподключался: голос пропадал до Стоп/Старт,
                    # хотя тот же сбой на канале собеседника просто логировался.
                    log_error(f"me: {e}")
                    mic.reset()
        except websockets.ConnectionClosed:
            pass
        finally:
            hub.drop(channel, ws)
            if channel == "me" and current_mic["ws"] is ws:
                current_mic["ws"] = None
                mic.restart()
            # Закрытие сокета раньше не оставляло следа нигде, кроме stderr,
            # который в сессии никто не видит.
            log_event("ws-closed", channel=channel, code=ws.close_code, reason=ws.close_reason)

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
            # итог стартовой проверки Vulkan: tier fast|ladder|mid|cpu, device,
            # flashAttn, tFullMs, tLadderMs, tCpuMs, cached, reason; None — пакета нет
            "vulkan": getattr(engine, "vulkan_info", None),
            "loopbackDevice": capture.device_name,
            "loopbackError": capture.error,
        }, ensure_ascii=False),
        flush=True,
    )

    # Keepalive выключен: соединение локальное, искать обрыв сети незачем, а
    # при затыке чтения понг застревал за кадрами звука, и websockets закрывал
    # сокет микрофона кодом 1011. Чтение теперь модель не ждёт.
    async with websockets.serve(handle, "127.0.0.1", args.port, max_size=2 ** 20, ping_interval=None):
        await asyncio.Future()


if __name__ == "__main__":
    # В канале до Electron по умолчанию cp1251: русские имена устройств и
    # сообщения об ошибках приезжали бы кракозябрами.
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    if args.probe:
        print(json.dumps({"probe": probe(args.model, args.vk_helper, args.ggml_model)}, ensure_ascii=False), flush=True)
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
