"""
Захват системного звука через WASAPI loopback.

Почему не через Electron: getDisplayMedia с audio:'loopback' на Windows падает
с NotReadableError даже когда обработчик отдаёт корректный источник и звук
реально играет. Проверено на этой машине. WASAPI напрямую работает.

Здесь же решаются две задачи, которых в web-пути не было:
  - свод многоканального выхода в моно (гарнитуры отдают виртуальный 7.1);
  - ресемпл к 16 кГц ПОТОКОМ, с состоянием, переносимым между блоками.

Про ресемпл стоит сказать отдельно, потому что здесь была дорогая ошибка.
Раньше scipy.signal.resample_poly вызывался на каждом блоке отдельно. Он
считает сигнал нулевым за границами массива, поэтому на КАЖДОЙ склейке
рождался разрыв, а длина округлялась вверх: 1024 фрейма при 48 кГц дают
341.333 сэмпла, а функция возвращала 342.

Замерено на синусе 1 кГц (5 секунд, блоки по 1024):
  целиком, как эталон  — чистота тона 142.7 дБ
  поблочно, как было   — 21.9 дБ и уход длительности +0.195%
Уход — это 59 мс на окне Whisper в 30 секунд и 7 секунд за часовой созвон,
а 120 дБ грязи мы подмешивали в звук собеседника сами, поверх его плохого
микрофона.

Теперь ресемплом занимается soxr: у него потоковый режим с собственным
состоянием. Тот же замер даёт 132-134 дБ на HQ, длительность точна, цена —
5 мкс на блок (сам блок длится 23 мс) и постоянная задержка 15-19 мс.
Качество VHQ проверено тоже и даёт то же самое, но задержку 39-65 мс —
для суфлёра это плохой размен.
"""
from __future__ import annotations

import threading
from typing import Callable

import numpy as np
import pyaudiowpatch as pyaudio
import soxr

TARGET_RATE = 16000
CHUNK_FRAMES = 1024
# HQ, а не VHQ: чистота та же, а задержка втрое меньше (замер в шапке файла).
RESAMPLE_QUALITY = "HQ"
# Пауза перед повторным подключением, чтобы не крутить цикл на отсутствующем
# устройстве и дать системе доперенастроить вывод.
REOPEN_DELAY_S = 1.0
# Как часто сверяться, не сменилось ли устройство вывода по умолчанию.
DEVICE_CHECK_S = 2.0


def find_loopback_device(p: pyaudio.PyAudio) -> dict | None:
    """Loopback-двойник текущего устройства вывода по умолчанию."""
    try:
        wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_out = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
    except Exception:
        return next(p.get_loopback_device_info_generator(), None)

    for d in p.get_loopback_device_info_generator():
        if default_out["name"] in d["name"]:
            return d
    return next(p.get_loopback_device_info_generator(), None)


def to_mono(raw: bytes, channels: int) -> np.ndarray:
    """int16 interleaved -> float32 моно, в исходной частоте дискретизации."""
    data = np.frombuffer(raw, dtype=np.int16)
    if data.size == 0:
        return np.zeros(0, dtype=np.float32)

    if channels > 1:
        usable = (data.size // channels) * channels
        frames = data[:usable].reshape(-1, channels).astype(np.float32)
        # Фронтальные L/R: на виртуальном 7.1 остальные каналы обычно пусты,
        # и усреднение по всем восьми просто утопило бы уровень.
        mono = frames[:, :2].mean(axis=1) if channels >= 2 else frames[:, 0]
    else:
        mono = data.astype(np.float32)

    return (mono / 32768.0).astype(np.float32)


class StreamResampler:
    """Ресемпл к 16 кГц с состоянием, живущим между блоками.

    Отдельный объект на поток захвата: состояние фильтра нельзя делить
    между источниками, иначе конец одного попадёт в начало другого.
    """

    def __init__(self, rate: int) -> None:
        self.rate = int(rate)
        self._st = (
            None
            if self.rate == TARGET_RATE
            else soxr.ResampleStream(
                self.rate, TARGET_RATE, 1, dtype="float32", quality=RESAMPLE_QUALITY
            )
        )

    def __call__(self, mono: np.ndarray) -> np.ndarray:
        if self._st is None:
            return mono
        return self._st.resample_chunk(mono)


class LoopbackCapture:
    """Читает выход звуковой карты в отдельном потоке и отдаёт моно 16 кГц."""

    def __init__(self, on_audio: Callable[[np.ndarray], None]) -> None:
        self._on_audio = on_audio
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.device_name: str | None = None
        self.error: str | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        """Читает поток и ПЕРЕОТКРЫВАЕТ его при смене устройства вывода.

        Без переоткрытия канал собеседника умирал навсегда и молча: стоило
        переключиться на другие наушники или включить Bluetooth-гарнитуру,
        как поток отваливался, поток захвата тихо завершался, а приложение
        продолжало показывать, что всё в порядке. Заодно меняется частота
        дискретизации (48000 у встроенной карты против 44100 у колонки),
        поэтому ресемплер тоже создаётся заново.
        """
        p = pyaudio.PyAudio()
        try:
            while not self._stop.is_set():
                try:
                    self._session(p)
                except Exception as e:
                    # Ошибку показываем, но поток не хороним: устройство могло
                    # просто исчезнуть на секунду при переключении.
                    self.error = f"{type(e).__name__}: {e}"
                if self._stop.wait(REOPEN_DELAY_S):
                    break
        finally:
            p.terminate()

    def _session(self, p: pyaudio.PyAudio) -> None:
        """Одно подключение к устройству — до ошибки или до смены устройства."""
        dev = find_loopback_device(p)
        if dev is None:
            self.error = "loopback-устройство не найдено"
            return

        name = str(dev["name"])
        rate = int(dev["defaultSampleRate"])
        channels = int(dev["maxInputChannels"])
        self.device_name = name
        self.error = None

        resample = StreamResampler(rate)
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=int(dev["index"]),
            frames_per_buffer=CHUNK_FRAMES,
        )
        try:
            checked = 0.0
            while not self._stop.is_set():
                raw = stream.read(CHUNK_FRAMES, exception_on_overflow=False)
                mono = resample(to_mono(raw, channels))
                # На первых блоках ресемплер копит свою линию задержки и
                # возвращает пустой массив — это нормально, не ошибка.
                if mono.size:
                    self._on_audio(mono)

                # Раз в DEVICE_CHECK_S проверяем, не сменилось ли устройство
                # вывода по умолчанию. Сам поток об этом не сообщает: он
                # продолжает отдавать тишину со старого, уже неиспользуемого.
                checked += CHUNK_FRAMES / rate
                if checked >= DEVICE_CHECK_S:
                    checked = 0.0
                    cur = find_loopback_device(p)
                    if cur is not None and str(cur["name"]) != name:
                        return
        finally:
            try:
                stream.close()
            except Exception:
                pass

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
