import numpy as np, pyaudiowpatch as pyaudio

p = pyaudio.PyAudio()
wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
default_out = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
print(f"устройство вывода по умолчанию: {default_out['name']}")

# У каждого выхода есть парное loopback-устройство — ищем его по имени
loopback = None
for d in p.get_loopback_device_info_generator():
    print(f"  loopback-кандидат: {d['name']}  ch={d['maxInputChannels']} sr={int(d['defaultSampleRate'])}")
    if default_out["name"] in d["name"]:
        loopback = d
        break
if loopback is None:
    loopback = next(p.get_loopback_device_info_generator(), None)

if loopback is None:
    print("НЕТ loopback-устройств"); raise SystemExit(1)

print(f"\nберу: {loopback['name']}")
sr = int(loopback["defaultSampleRate"]); ch = loopback["maxInputChannels"]
stream = p.open(format=pyaudio.paInt16, channels=ch, rate=sr, input=True,
                input_device_index=loopback["index"], frames_per_buffer=1024)

peaks = []
for _ in range(int(sr / 1024 * 3)):          # 3 секунды
    data = np.frombuffer(stream.read(1024, exception_on_overflow=False), dtype=np.int16)
    if data.size:
        r = np.sqrt(np.mean((data.astype(np.float32) / 32768.0) ** 2))
        peaks.append(20 * np.log10(r) if r > 0 else -100)

stream.close(); p.terminate()
print(f"кадров: {len(peaks)}  средний RMS: {np.mean(peaks):.1f} dBFS  максимум: {np.max(peaks):.1f} dBFS")
print("ЗВУК ЕСТЬ" if np.max(peaks) > -60 else "ТИШИНА")
