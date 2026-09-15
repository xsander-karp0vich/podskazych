"""
Распознавание речи: одна модель, whisper-large-v3-turbo, на любом компьютере.

Всё, что вокруг распознавания, — захват звука, Silero, нарезка реплик, эхо, протокол —
от устройства не зависит и живёт в asr.py. Здесь только сама модель: как её поднять,
как расшифровать кусок звука и как передать ей словарь.

Устройство выбирается по железу:
  видеокарта NVIDIA — CUDA, как было всегда;
  всё остальное — процессор. Та же модель и тот же словарь, поэтому термины 1С
      распознаются так же. Скорость даёт короткое окно кодировщика, см. CpuWindow.

Модели без словаря (GigaAM) пробовали: русский отличный, но СКД превращается в «SKD»,
RLS в «ARS», а EnterpriseData в «интерпреседата». Для созвонов про 1С это не годится.
"""
from __future__ import annotations

import glob
import os
import site
import time
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16000

# Словарь распознавания уходит в hotwords, а не в initial_prompt. На замере они
# неотличимы (по 10 терминов из 10), но hotwords сделан ровно под эту задачу и
# обрезается с НАЧАЛА: сохраняются первые токены. Поэтому самое важное — имена
# пользователя — ставится первым и не теряется. initial_prompt хранит хвост.
HOTWORDS_LEAD = "Разговор про 1С."
# faster-whisper режет hotwords до max_length // 2 - 1 = 223 токенов. Берём на
# один меньше, чтобы точка в конце не отрезалась.
HOTWORDS_BUDGET = 222

# --- короткое окно кодировщика на процессоре ---
# Кодировщик Whisper всегда считает окно в 30 с, даже если фраза длится 4 с:
# хвост просто забит тишиной. На видеокарте это незаметно, а на процессоре
# это почти всё время распознавания. Замер на фразах с терминами 1С, 4 потока:
#   окно 30 с — 4.4 с на фразу, окно 10 с — 0.9 с, окно 20 с — 1.9 с;
#   термины те же (6–7 из 7), текст совпадает.
# На 30 записях (фразы про 1С, технические термины, те же термины словами,
# фразы-ловушки для словаря) против текущего пути на CUDA: терминов 22 из 33
# против 21, ложных подстановок 0 и 0, сходство с эталоном 0.906 против 0.909,
# 0.88 с на фразу против 3.4 с с полным окном на том же процессоре.
# Окно впритык к длине фразы нельзя: модель, обученная на 30 с, дописывает
# хвост заново — фраза 14.6 с в окне 15 с закончилась повтором «До встречи
# в четверг. До встречи в четверг.». Запаса в 2 с хватило во всех замерах,
# берём 3 с.
CPU_WINDOWS_S = (10, 15, 20)
CPU_WINDOW_MARGIN_S = 3.0
# Реплику на процессоре закрываем раньше, чтобы она влезала в самое длинное
# короткое окно. Окно 30 с на процессоре — это 4 с ожидания финала.
# Минус полсекунды: реплика закрывается на чанке, который ПЕРЕСЁК предел, и
# захват собеседника почти никогда не попадает в него ровно — буфер выходит
# на 17.00–17.03 с и без запаса проскакивал мимо окна 20 с.
CPU_MAX_UTTERANCE_MS = int((CPU_WINDOWS_S[-1] - CPU_WINDOW_MARGIN_S) * 1000) - 500
# Выше — текст слишком повторяется: зацикливание. Порог тот же, что у faster-whisper.
COMPRESSION_RATIO_MAX = 2.4
# Сколько токенов текста разрешено на секунду окна. Русская речь — около трёх
# слов в секунду, у Whisper это до 3 токенов на слово; с запасом 15. Без потолка
# зацикливание на словаре крутится до 448 токенов — 2 с процессора впустую.
CPU_TOKENS_PER_WINDOW_S = 15


class EngineError(Exception):
    """Распознавание не поднялось. code — для приложения, message — человеку, по-русски."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Caps:
    """Что выдерживает устройство. Отсюда asr.py берёт частоту промежуточных гипотез."""

    # как часто переспрашивать растущую реплику
    partial_every_ms: int
    # реплика длиннее закрывается принудительно
    max_utterance_ms: int
    # > 0 — устройство медленное (процессор): черновик считается, только когда
    # модель простаивает, и показывается сразу, без второй гипотезы — см.
    # Transcriber в asr.py. 0 — черновики по расписанию, как на CUDA.
    backoff: float = 0.0
    # с какой длины реплики её переспрашивать: обрывок в полслова модель
    # превращает в мусор, а на процессоре каждый переспрос стоит секунду
    min_partial_ms: int = 300


def _enable_cuda_dlls() -> list[str]:
    """
    CUDA-библиотеки ставятся колёсами nvidia-* и лежат в site-packages/nvidia/*/bin,
    куда Windows сама не заглядывает. CTranslate2 грузит их обычным LoadLibrary,
    который смотрит в PATH и НЕ смотрит в каталоги из os.add_dll_directory —
    поэтому помогает только правка PATH, и сделать её надо ДО первого распознавания.
    Иначе первый же encode() падает с
    'Library cublas64_12.dll is not found or cannot be loaded'.

    Нужен и nvidia-cuda-runtime-cu12 (cudart64_12.dll): в зависимости
    faster-whisper он не входит, а cuBLAS без него не загружается.
    """
    dirs = [
        d
        for sp in site.getsitepackages()
        for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin"))
        if os.path.isdir(d)
    ]
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
    return dirs


# Правка PATH должна случиться до первого обращения к CTranslate2 — в том числе
# до подсчёта видеокарт. На машине без колёс nvidia-* это пустой glob.
_CUDA_DLL_DIRS = _enable_cuda_dlls()


def cuda_devices() -> int:
    """Сколько видеокарт видит CTranslate2. 0 — нет NVIDIA, драйвера или CUDA-сборки."""
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def cpu_threads() -> int:
    """Половина логических ядер, но не больше 8.

    Вторая половина нужна самому созвону: Zoom, Teams и браузер тоже считают
    звук и видео. Больше 8 потоков почти не ускоряет: 8 потоков — 0.72 с на
    фразу, 4 потока — 0.92 с.
    """
    return max(2, min(8, (os.cpu_count() or 4) // 2))


def compression_ratio(text: str) -> float:
    import zlib

    raw = text.encode("utf-8")
    return len(raw) / max(1, len(zlib.compress(raw)))


class Engine:
    name = "faster-whisper"

    def __init__(self, model: str, device: str, compute_type: str, language: str, glossary: str = "") -> None:
        from faster_whisper import WhisperModel

        self.device = device
        self.model = WhisperModel(
            model,
            device=device,
            compute_type=compute_type,
            **({"cpu_threads": cpu_threads()} if device == "cpu" else {}),
        )
        self.language = language
        # CTranslate2 может заменить тип: на Blackwell int8 выключен, и int8_float16
        # молча становится float16. Показываем то, что работает на самом деле.
        self.compute_type = str(getattr(self.model.model, "compute_type", compute_type))
        self.hotwords = glossary.strip()
        name = os.path.basename(os.path.normpath(model))
        self.label = f"{name} · {device}" if device == "cuda" else f"{name} · процессор"
        if device == "cuda":
            self.caps = Caps(partial_every_ms=700, max_utterance_ms=30_000)
        else:
            # Реплика в 10 с на 4 потоках — около секунды: черновик не чаще
            # раза в 1.5 с после конца прошлого и только в простое модели,
            # иначе финалы обоих каналов ждут переспросов.
            self.caps = Caps(
                partial_every_ms=1500,
                max_utterance_ms=CPU_MAX_UTTERANCE_MS,
                backoff=3.0,
                min_partial_ms=1500,
            )
            self._prepare_cpu()

    def _prepare_cpu(self) -> None:
        from faster_whisper.tokenizer import Tokenizer
        from faster_whisper.transcribe import get_suppressed_tokens

        # как в transcribe(): у английской модели нет токенов языка и задачи
        multilingual = self.model.model.is_multilingual
        self.tokenizer = Tokenizer(
            self.model.hf_tokenizer,
            multilingual,
            task="transcribe",
            language=self.language if multilingual else "en",
        )
        # как в transcribe() по умолчанию: suppress_tokens=[-1] — глушим значки
        # музыки и прочие не-речевые символы
        self.suppress = get_suppressed_tokens(self.tokenizer, [-1])

    def set_terms(self, terms: list) -> dict:
        """Собрать hotwords из терминов по приоритету и уложить в бюджет.

        Считаем тем же токенизатором, которым faster-whisper закодирует
        подсказку: на глаз оценка у кириллицы врёт в разы. Порядок — это
        приоритет, поэтому на первом же термине, который не влез, останавливаемся
        и не пробуем следующие: иначе важное вылетало бы ради мелкого, которое
        просто оказалось короче.

        Присваивание строки атомарно, поэтому менять словарь можно прямо во
        время распознавания: текущая фраза дойдёт со старым, следующая — с новым.
        """
        tok = self.model.hf_tokenizer

        def count(text: str) -> int:
            return len(tok.encode(" " + text, add_special_tokens=False).ids)

        clean = [str(t).strip() for t in terms if str(t).strip()]
        kept: list = []
        for term in clean:
            if count(f"{HOTWORDS_LEAD} {', '.join(kept + [term])}.") > HOTWORDS_BUDGET:
                break
            kept.append(term)
        text = f"{HOTWORDS_LEAD} {', '.join(kept)}." if kept else ""
        self.hotwords = text
        return {"kept": len(kept), "total": len(clean), "tokens": count(text) if text else 0}

    # сколько занял прогрев; 0 — ещё не грелись
    warm_up_s = 0.0

    def warm_up(self) -> None:
        """Прогон вхолостую: ошибки вроде ненайденной cuBLAS всплывают только на первом вызове.

        Заодно замеряем его: это первая оценка стоимости прогона для очереди в
        asr.py. Второй холостой прогон ради замера стоил бы секунду старта.
        """
        started = time.monotonic()
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))
        self.warm_up_s = time.monotonic() - started

    def transcribe(self, audio: np.ndarray) -> tuple[str, float]:
        """Текст реплики и длительность речи в секундах."""
        if self.device == "cpu":
            dur = audio.size / SAMPLE_RATE
            window = self._cpu_window(dur)
            if window is not None:
                # Зацикливание в коротком окне считаем шумом. Пересчёт с полным
                # окном не помогает: та же подсказка, та же нулевая температура —
                # на замере он 3–5 с крутил тот же словарь по кругу.
                text = self._transcribe_window(audio, window)
                return ("" if text is None else text), dur
        return self._transcribe_full(audio)

    def _transcribe_full(self, audio: np.ndarray) -> tuple[str, float]:
        segments, _ = self.model.transcribe(
            audio,
            language=self.language,
            beam_size=1,
            # Выключен намеренно. Решение «есть ли речь» уже принято Silero
            # снаружи, на окне; внутренний фильтр резал бы паузы второй раз
            # (замеры дают за это +7.9 п.п. WER), а не найдя речи, молча
            # возвращал бы пустой массив — реплика пропадала без следа.
            vad_filter=False,
            condition_on_previous_text=False,
            hotwords=self.hotwords or None,
            temperature=0.0,
        )
        # no_speech_prob оставлен как страховка на случай других весов, но
        # на наших он всегда 0.0 и не отсекает ничего — см. looks_like_noise.
        kept, span = [], 0.0
        for seg in segments:
            if getattr(seg, "no_speech_prob", 0.0) >= 0.6:
                continue
            kept.append(seg.text.strip())
            span += max(0.0, float(seg.end) - float(seg.start))
        return " ".join(kept).strip(), span

    @staticmethod
    def _cpu_window(dur_s: float) -> int | None:
        for w in CPU_WINDOWS_S:
            if dur_s + CPU_WINDOW_MARGIN_S <= w:
                return w
        return None

    def _transcribe_window(self, audio: np.ndarray, window_s: int) -> str | None:
        """Распознать фразу в окне короче 30 с. None — модель зациклилась.

        Штатного способа нет: transcribe(chunk_length=…) всё равно дополняет
        признаки до 3000 кадров (pad_or_trim в generate_segments). Поэтому
        подаём кодировщику признаки нужной длины сами, а подсказку собираем
        тем же get_prompt, что и transcribe(): словарь и служебные токены
        совпадают байт в байт. Работает на CTranslate2 4.8.2 — версия закреплена
        в requirements.txt.
        """
        import ctranslate2

        frames = window_s * 100
        feats = self.model.feature_extractor(audio)[:, :frames]
        if feats.shape[1] < frames:
            feats = np.pad(feats, ((0, 0), (0, frames - feats.shape[1])))
        enc = self.model.model.encode(
            ctranslate2.StorageView.from_array(np.ascontiguousarray(feats[None], dtype=np.float32))
        )
        prompt = self.model.get_prompt(
            self.tokenizer, [], without_timestamps=True, hotwords=self.hotwords or None
        )
        result = self.model.model.generate(
            enc,
            [prompt],
            beam_size=1,
            max_length=min(self.model.max_length, len(prompt) + window_s * CPU_TOKENS_PER_WINDOW_S),
            suppress_blank=True,
            suppress_tokens=self.suppress,
        )[0]
        text = self.tokenizer.decode(result.sequences_ids[0]).strip()
        if compression_ratio(text) > COMPRESSION_RATIO_MAX:
            return None
        return text


def probe(whisper_model: str) -> dict:
    """Что есть на машине — без загрузки модели."""
    info: dict = {"cudaDevices": cuda_devices(), "cpuCount": os.cpu_count() or 0, "cpuThreads": cpu_threads()}
    try:
        import ctranslate2

        info["cudaComputeTypes"] = sorted(ctranslate2.get_supported_compute_types("cuda")) if info["cudaDevices"] else []
    except Exception:
        info["cudaComputeTypes"] = []
    info["whisperLocal"] = os.path.isfile(os.path.join(whisper_model, "model.bin"))
    return info


def select_engine(
    device: str,
    whisper_model: str,
    language: str,
    compute_type: str,
    glossary: str,
    log,
) -> tuple[Engine, str | None]:
    """Поднять распознавание. Возвращает движок и причину, по которой он не на CUDA.

    auto: сначала CUDA — с прогоном вхолостую, потому что отсутствие cuBLAS или
    несовместимый драйвер обнаруживаются только на первом распознавании.
    Не вышло — та же модель на процессоре.
    """

    def cpu() -> Engine:
        e = Engine(whisper_model, "cpu", "int8", language, glossary)
        e.warm_up()
        return e

    if device == "cpu":
        return cpu(), "процессор выбран вручную"

    reason: str | None = None
    if not cuda_devices():
        reason = "нет видеокарты NVIDIA с CUDA"
        if device == "cuda":
            raise EngineError("no-cuda", "Видеокарта NVIDIA с CUDA не найдена.")
    else:
        try:
            e = Engine(whisper_model, "cuda", compute_type, language, glossary)
            e.warm_up()
            return e, None
        except Exception as ex:  # драйвер старый, памяти мало, нет cuBLAS
            if device == "cuda":
                raise
            reason = f"CUDA не заработала: {ex}"
            log(f"CUDA не заработала, переходим на процессор: {ex}")
    return cpu(), reason
