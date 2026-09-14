<#
Офлайн-рантайм распознавания речи для установщика.

  build/stt/python  Python той же версии, что в sidecar/.venv, только нужные
                    пакеты и msvcp140/vcruntime140 рядом с python.exe
  build/stt/model   веса whisper-large-v3-turbo (int8_float16)

Скрипт ничего не скачивает. Базовая установка Python берётся по пути home из
sidecar/.venv/pyvenv.cfg, пакеты из самого venv, библиотеки C++ из Visual Studio.
В CI venv создаётся по lock-файлу с хэшами (.github/workflows/release.yml),
а дальше работает этот же скрипт, поэтому локальная сборка и релиз совпадают.

Последним шагом, когда все проверки прошли, пишется build/stt/python/.runtime-ok:
версии, итог проверки и хэши входов сборки. В начале запуска отметка удаляется,
поэтому упавшая или прерванная сборка её не оставит, а npm run dist (-SkipIfReady)
пересоберёт такой рантайм, а не упакует его.

Запуск из корня репозитория:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-stt-runtime.ps1 -ModelSource <папка с моделью>
#>
[CmdletBinding()]
param(
  # venv, из которого берутся пакеты и путь к базовому Python
  [string]$Venv = 'sidecar/.venv',
  # куда собирать; внутри появятся python/ и model/
  [string]$Out = 'build/stt',
  # папка с весами: model.bin, config.json, tokenizer.json, preprocessor_config.json
  # и vocabulary.json (или vocabulary.txt у старых конвертаций)
  [string]$ModelSource = 'build/stt/model',
  # базовая установка Python; пусто — home из pyvenv.cfg
  [string]$BasePython = '',
  # папка Microsoft.VC14x.CRT; пусто — ищем в установленной Visual Studio
  [string]$VcRedist = '',
  # без библиотек NVIDIA: рантайм меньше на ~750 МБ, распознавание только на процессоре
  [switch]$NoCuda,
  # без загрузки модели в проверке: остаются импорты и asr.py --probe
  [switch]$QuickSmoke,
  # для npm run dist: выйти без сборки, если есть отметка полной проверки, входы
  # сборки не менялись и модель на месте; иначе собрать заново
  [switch]$SkipIfReady
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

# Пакеты, которые сайдкар реально импортирует. Список получен прогоном asr.py,
# engines.py и audio_loopback.py в dev-venv с загрузкой модели на процессоре и
# CUDA, Silero, захватом звука и websockets. Остальное из venv не нужно:
#   scipy, pillow, pip           не импортируются;
#   httpx, hf-xet, click и т.п.  нужны huggingface_hub только для скачивания,
#                                а модель лежит локально и сеть выключена;
#   flatbuffers, protobuf        onnxruntime тянет их для инструментов, не для сессии.
# typing-extensions, filelock, fsspec, packaging, pyyaml оставлены, хотя в замере
# не всплыли: это обязательные зависимости huggingface_hub и ctranslate2, весят
# мегабайты, а ленивый импорт на редкой ветке уронил бы распознавание посреди созвона.
$Packages = @(
  'faster-whisper', 'ctranslate2', 'onnxruntime', 'av', 'numpy', 'tokenizers',
  'huggingface-hub', 'tqdm', 'colorama', 'filelock', 'fsspec', 'packaging', 'pyyaml', 'typing-extensions',
  'soxr', 'pyaudiowpatch', 'websockets'
)
# Из NVIDIA только cuBLAS и cudart: проверено, что CTranslate2 распознаёт на CUDA
# без cuDNN (1.1 ГБ) и nvrtc (179 МБ). Сама проверка ниже прогоняет CUDA, если
# на машине сборки есть видеокарта.
$CudaPackages = @('nvidia-cublas-cu12', 'nvidia-cuda-runtime-cu12')
$VcDlls = @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')
$ModelFiles = @('model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json')
# CTranslate2 не загрузит Whisper без словаря: ищет vocabulary.json, затем
# vocabulary.txt. Без этой проверки -QuickSmoke и dist пропустили бы неполную
# копию модели, и в установленном приложении падал бы каждый «Старт».
$VocabFiles = @('vocabulary.json', 'vocabulary.txt')
$ReadyMarkerName = '.runtime-ok'
$ReadyFormat = 1

function Resolve-RepoPath([string]$p) {
  if ([IO.Path]::IsPathRooted($p)) { return [IO.Path]::GetFullPath($p) }
  return [IO.Path]::GetFullPath((Join-Path $RepoRoot $p))
}

function Step([string]$text) { Write-Host "== $text" -ForegroundColor Cyan }

function Get-DirBytes([string]$dir) {
  $sum = (Get-ChildItem -LiteralPath $dir -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
  if ($sum) { return [int64]$sum } else { return [int64]0 }
}

function Format-MB([int64]$bytes) { return ('{0:N0} МБ' -f ($bytes / 1MB)) }

function Get-FileVer([string]$path) {
  $vi = (Get-Item -LiteralPath $path).VersionInfo
  return New-Object Version($vi.FileMajorPart, $vi.FileMinorPart, $vi.FileBuildPart, $vi.FilePrivatePart)
}

# robocopy, а не Copy-Item: тысячи файлов стандартной библиотеки копируются в разы
# быстрее, а исключения папок задаются одним списком. Коды 0–7 означают успех.
function Invoke-Robocopy([string]$from, [string]$to, [string[]]$extra) {
  & robocopy $from $to @extra /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to завершился с кодом $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}

# Каталог сборки пересоздаётся целиком. Чтобы опечатка в -Out не снесла чужую
# папку, удаляем только то, что похоже на наш результат.
function Reset-Dir([string]$dir, [string]$marker) {
  if (Test-Path -LiteralPath $dir) {
    $items = @(Get-ChildItem -LiteralPath $dir -Force)
    if ($items.Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $dir $marker))) {
      throw "Папка $dir не пустая и не похожа на результат сборки (нет $marker) — удалять не буду"
    }
    [IO.Directory]::Delete($dir, $true)
  }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

function Get-MissingModelFiles([string]$dir) {
  $missing = @()
  foreach ($f in $ModelFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { $missing += $f }
  }
  $vocab = @($VocabFiles | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) })
  if ($vocab.Count -eq 0) { $missing += ($VocabFiles -join ' или ') }
  return $missing
}

# Размеры файлов модели в отметке: подмену весов в build/stt/model без
# пересборки -SkipIfReady заметит, а хэшировать 780 МБ на каждый dist долго.
function Get-ModelSizes([string]$dir) {
  $sizes = [ordered]@{}
  foreach ($f in ($ModelFiles + $VocabFiles)) {
    $p = Join-Path $dir $f
    if (Test-Path -LiteralPath $p) { $sizes[$f] = [int64](Get-Item -LiteralPath $p).Length }
  }
  return $sizes
}

# Входы, от которых зависит рантайм: сам скрипт (набор пакетов, проверки),
# закреплённые версии и модули сайдкара, с которыми прошла проверка. Поменялся
# любой — прежний рантайм мог стать неполным (новый пакет, новый импорт), а
# проверен он был со старыми входами, поэтому dist его пересобирает.
function Get-InputHashes {
  $h = [ordered]@{}
  $files = @($PSCommandPath, $Pins) + @('asr.py', 'engines.py', 'audio_loopback.py' | ForEach-Object { Join-Path $SidecarDir $_ })
  foreach ($p in $files) {
    $full = [IO.Path]::GetFullPath($p)
    # в отметку идут пути от корня репозитория: она уезжает в установщик
    $key = $full.Substring($RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
    if (Test-Path -LiteralPath $full) {
      $h[$key] = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
      $h[$key] = 'missing'
    }
  }
  return $h
}

# Почему готовый рантайм нельзя взять как есть; $null — можно.
function Get-NotReadyReason {
  $markerPath = Join-Path $PyOut $ReadyMarkerName
  if (-not (Test-Path -LiteralPath $markerPath)) { return 'нет отметки о завершённой сборке' }
  if (-not (Test-Path -LiteralPath (Join-Path $PyOut 'python.exe'))) { return 'нет python.exe' }
  try {
    $mk = [IO.File]::ReadAllText($markerPath) | ConvertFrom-Json
    $props = $mk.PSObject.Properties
    if (-not $props['format'] -or $mk.format -ne $ReadyFormat) { return 'отметка старого формата' }
    if ($mk.smoke -ne 'full') { return 'рантайм проверен без загрузки модели (-QuickSmoke)' }
    # Рантайм, собранный без библиотек NVIDIA ради меньшего размера, не должен
    # молча уехать в установщик: там распознавание шло бы только на процессоре.
    if (-not $props['cuda'] -or [bool]$mk.cuda -ne [bool](-not $NoCuda)) {
      if ($NoCuda) { return 'рантайм собран с CUDA, а нужен без (-NoCuda)' }
      return 'рантайм собран без CUDA (-NoCuda)'
    }
    # После сборки в рантайм мог дописаться байткод: например, приложение при
    # разработке запускали через COPILOT_PYTHON на этот python.exe, и в .pyc
    # попал путь с именем пользователя. Проверка личных путей была до этого,
    # поэтому любое изменение дерева — повод пересобрать.
    $markerBytes = (Get-Item -LiteralPath $markerPath).Length
    if (-not $mk.bytes -or ([int64](Get-DirBytes $PyOut) - $markerBytes) -ne [int64]$mk.bytes.python) {
      return 'рантайм изменился после сборки'
    }
    foreach ($e in (Get-InputHashes).GetEnumerator()) {
      $saved = $mk.inputs.PSObject.Properties[$e.Key]
      if (-not $saved -or $saved.Value -ne $e.Value) { return "изменился $($e.Key)" }
    }
    $missing = @(Get-MissingModelFiles $ModelOut)
    if ($missing.Count -gt 0) { return "в модели нет $($missing -join ', ')" }
    $now = Get-ModelSizes $ModelOut
    foreach ($e in $now.GetEnumerator()) {
      $saved = $mk.model.PSObject.Properties[$e.Key]
      if (-not $saved -or [int64]$saved.Value -ne $e.Value) { return "модель в $ModelOut поменялась ($($e.Key))" }
    }
    if (@($mk.model.PSObject.Properties).Count -ne $now.Count) { return "модель в $ModelOut поменялась" }
  } catch {
    return "отметка повреждена: $($_.Exception.Message)"
  }
  return $null
}

function Find-VcRedist {
  $dirs = New-Object System.Collections.Generic.List[string]
  if ($env:VCToolsRedistDir) {
    Get-ChildItem -LiteralPath (Join-Path $env:VCToolsRedistDir 'x64') -Directory -Filter 'Microsoft.VC14*.CRT' -ErrorAction SilentlyContinue |
      ForEach-Object { $dirs.Add($_.FullName) }
  }
  $roots = New-Object System.Collections.Generic.List[string]
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) {
    $vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
      & $vswhere -all -products * -property installationPath | ForEach-Object { if ($_) { $roots.Add($_) } }
      $global:LASTEXITCODE = 0
    }
  }
  foreach ($pf in @($pf86, $env:ProgramFiles)) {
    if (-not $pf) { continue }
    $vs = Join-Path $pf 'Microsoft Visual Studio'
    if (-not (Test-Path -LiteralPath $vs)) { continue }
    # Microsoft Visual Studio\<год>\<редакция>
    Get-ChildItem -LiteralPath $vs -Directory | ForEach-Object {
      Get-ChildItem -LiteralPath $_.FullName -Directory | ForEach-Object { $roots.Add($_.FullName) }
    }
  }
  foreach ($root in ($roots | Select-Object -Unique)) {
    $msvc = Join-Path $root 'VC\Redist\MSVC'
    if (-not (Test-Path -LiteralPath $msvc)) { continue }
    foreach ($ver in Get-ChildItem -LiteralPath $msvc -Directory) {
      $x64 = Join-Path $ver.FullName 'x64'
      if (-not (Test-Path -LiteralPath $x64)) { continue }
      Get-ChildItem -LiteralPath $x64 -Directory -Filter 'Microsoft.VC14*.CRT' | ForEach-Object { $dirs.Add($_.FullName) }
    }
  }
  # Самая свежая по версии msvcp140.dll: библиотеки собраны новым компилятором,
  # а со старым msvcp140 такие модули падают на std::mutex.
  $best = $null
  $bestVer = $null
  foreach ($d in ($dirs | Select-Object -Unique)) {
    $ok = $true
    foreach ($n in $VcDlls) { if (-not (Test-Path -LiteralPath (Join-Path $d $n))) { $ok = $false } }
    if (-not $ok) { continue }
    $v = Get-FileVer (Join-Path $d 'msvcp140.dll')
    if ($null -eq $bestVer -or $v -gt $bestVer) { $best = $d; $bestVer = $v }
  }
  return $best
}

# Вспомогательный код на Python пишем во временные файлы: передавать многострочный
# -c через Windows PowerShell 5.1 ненадёжно, он портит кавычки в аргументах.
$CopyDistsPy = @'
import importlib.metadata as md
import json
import os
import re
import shutil
import sys

dst, pins_file, report_file = sys.argv[1], sys.argv[2], sys.argv[3]
names = sys.argv[4:]


def norm(n):
    return re.sub(r"[-_.]+", "-", n).lower()


pins = {}
if os.path.isfile(pins_file):
    with open(pins_file, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if "==" in line:
                n, v = line.split("==", 1)
                pins[norm(n.split("[", 1)[0])] = v.split(";", 1)[0].strip()

report = {"dists": {}, "missing": [], "mismatch": [], "files": 0, "bytes": 0}
for name in names:
    try:
        dist = md.distribution(name)
    except md.PackageNotFoundError:
        report["missing"].append(name)
        continue
    report["dists"][name] = dist.version
    want = pins.get(norm(name))
    if want and want != dist.version:
        report["mismatch"].append("%s %s (requirements-stt.txt: %s)" % (name, dist.version, want))
    files = dist.files
    if not files:
        report["missing"].append(name + " (no RECORD)")
        continue
    for f in files:
        parts = f.parts
        # ../../Scripts/*.exe - console launchers; __pycache__ - stale timestamp bytecode
        if parts[0] == ".." or "__pycache__" in parts or f.suffix in (".pyc", ".pyo"):
            continue
        src = str(dist.locate_file(f))
        if not os.path.isfile(src):
            continue
        out = os.path.join(dst, *parts)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(src, out)
        report["files"] += 1
        report["bytes"] += os.path.getsize(out)

with open(report_file, "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=1)
'@

$SmokePy = @'
import asyncio
import ctypes
import json
import os
import sys
import time

sidecar, model, mode, report_file = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
runtime = os.path.normcase(os.path.dirname(os.path.abspath(sys.executable))) + os.sep
res = {"python": sys.version.split()[0], "prefix": sys.prefix}


def inside(p):
    return (os.path.normcase(os.path.abspath(p)) + os.sep).startswith(runtime)


# Nothing from the build machine may leak in: registry PythonPath, PYTHONPATH, user site.
here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
leaks = [p for p in sys.path if p and not inside(p) and os.path.normcase(os.path.abspath(p)) != here]
if leaks:
    raise SystemExit("sys.path outside the runtime: %r" % leaks)
if not sys.flags.no_user_site:
    raise SystemExit("user site-packages is enabled")
if not inside(sys.prefix):
    raise SystemExit("sys.prefix outside the runtime: %s" % sys.prefix)

sys.path.insert(0, sidecar)
import numpy as np
import ctranslate2, onnxruntime, av, tokenizers, soxr, pyaudiowpatch, websockets
import faster_whisper, faster_whisper.vad, faster_whisper.transcribe, faster_whisper.tokenizer
import huggingface_hub
import asr, engines, audio_loopback

res["versions"] = {
    "ctranslate2": ctranslate2.__version__,
    "faster_whisper": faster_whisper.__version__,
    "onnxruntime": onnxruntime.__version__,
    "numpy": np.__version__,
}
res["probe"] = engines.probe(model)
if not res["probe"]["whisperLocal"]:
    raise SystemExit("model.bin not found in %s" % model)


def loaded(name):
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GetModuleHandleW.restype = ctypes.c_void_p
    k.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    k.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32]
    h = k.GetModuleHandleW(name)
    if not h:
        return None
    buf = ctypes.create_unicode_buffer(32768)
    k.GetModuleFileNameW(h, buf, 32768)
    return buf.value


if mode == "full":
    t = time.time()
    cpu = engines.Engine(model, "cpu", "int8", "ru", "")
    cpu.warm_up()
    text, _ = cpu.transcribe(np.zeros(engines.SAMPLE_RATE * 4, dtype=np.float32))
    res["cpu"] = {
        "computeType": cpu.compute_type,
        "hotwords": cpu.set_terms(["1C", "EnterpriseData"]),
        "seconds": round(time.time() - t, 1),
    }
    del cpu
    if asr.make_speech_gate() is None:
        raise SystemExit("Silero VAD did not start")
    if engines.cuda_devices():
        t = time.time()
        gpu = engines.Engine(model, "cuda", "int8_float16", "ru", "")
        gpu.warm_up()
        res["cuda"] = {"computeType": gpu.compute_type, "seconds": round(time.time() - t, 1)}
        del gpu
    else:
        res["cuda"] = None
    soxr.ResampleStream(48000, 16000, 1, dtype="float32")
    try:
        pa = pyaudiowpatch.PyAudio()
        dev = audio_loopback.find_loopback_device(pa)
        pa.terminate()
        res["loopback"] = dev["name"] if dev else None
    except Exception as e:  # the build machine may have no audio at all (CI)
        res["loopback"] = "error: %s" % e

    async def ws_roundtrip():
        async def handler(ws):
            await ws.close()

        async with websockets.serve(handler, "127.0.0.1", 0):
            pass

    asyncio.run(ws_roundtrip())

# VC++ runtime must come from next to python.exe, otherwise a PC without the
# redistributable would fail on import ctranslate2.
res["dlls"] = {n: loaded(n) for n in ("msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll")}
outside = {n: p for n, p in res["dlls"].items() if p and not inside(p)}
if outside:
    raise SystemExit("VC++ runtime loaded from outside the runtime: %r" % outside)

res["modules"] = sorted({
    os.path.abspath(m.__file__)
    for m in list(sys.modules.values())
    if isinstance(getattr(m, "__file__", None), str) and m.__file__.endswith(".py") and inside(m.__file__)
})
with open(report_file, "w", encoding="utf-8") as fh:
    json.dump(res, fh, ensure_ascii=False, indent=1)
'@

# dfile — путь, который попадает в co_filename внутри .pyc. Без него туда пишется
# абсолютный путь сборки вместе с именем пользователя Windows, а electron-builder
# копирует extraResources без своих исключений для .pyc, и путь уехал бы в
# установщик. Путь от корня рантайма ничего не ломает: при импорте importlib
# всё равно подставляет настоящее расположение файла.
$CompilePy = @'
import json
import os
import py_compile
import sys

root = os.path.dirname(os.path.abspath(sys.executable))
with open(sys.argv[1], encoding="utf-8") as fh:
    mods = json.load(fh)["modules"]
for m in mods:
    py_compile.compile(
        m,
        dfile=os.path.relpath(m, root),
        doraise=True,
        invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
    )
print(len(mods))
'@

# Сторож от личных путей в установщике: всё, что уходит в build/stt, не должно
# содержать ни путь профиля сборщика (и \Users\<имя> на любом диске), ни путь
# репозитория. Написания \, / и \\ (JSON, repr), как есть и в нижнем регистре (normcase),
# в UTF-8 (.pyc, текст) и UTF-16LE (строки в DLL). Простой поиск подстроки, а не
# регулярное выражение без учёта регистра: на гигабайте это 3 с вместо минуты.
$ScanPy = @'
import json
import mmap
import os
import sys

repo, report_file = sys.argv[1], sys.argv[2]
roots = sys.argv[3:]

profile = os.environ.get("USERPROFILE", "")
users = {u for u in (os.environ.get("USERNAME", ""), os.path.basename(profile.rstrip("\\/"))) if u}
# On GitHub Actions the profile is C:\Users\runneradmin: nothing personal, and
# several PyPI wheels were themselves built on such runners and carry that path
# (Rust panic paths in tokenizers, numpy build info). Only the repo path is a leak there.
ci = os.environ.get("GITHUB_ACTIONS") == "true"
if ci:
    profile, users = "", set()


def nodrive(p):
    return os.path.splitdrive(p.rstrip("\\/"))[1]


# The profile goes without the drive letter (a moved profile still matches); the
# repo keeps it, otherwise a short checkout like D:\src would match everywhere.
bases = {s for s in (nodrive(profile), repo.rstrip("\\/")) if len(s) > 3}
bases |= {"\\Users\\" + u for u in users}
# a base containing a shorter one is already covered by the shorter one
spelled = {}
for b in bases:
    spelled.setdefault(b.lower(), set()).add(b)
bases = set()
for k, originals in spelled.items():
    if not any(o != k and o in k for o in spelled):
        bases |= originals
if not bases:
    raise SystemExit("neither USERPROFILE nor USERNAME is set, nothing to look for")

needles = set()
for b in bases:
    for v in (b, b.replace("\\", "/"), b.replace("\\", "\\\\")):
        for c in (v, v.lower()):
            for enc in ("utf-8", "utf-16-le"):
                needles.add((c.encode(enc), enc))
NAMECH = set(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")


def leak(mm):
    size = len(mm)
    for nd, enc in needles:
        pos = mm.find(nd)
        while pos != -1:
            end = pos + len(nd)
            # "\Users\ann" is not a leak inside "\Users\anna"
            if end >= size or mm[end] not in NAMECH or (enc != "utf-8" and (end + 1 >= size or mm[end + 1] != 0)):
                return True
            pos = mm.find(nd, pos + 1)
    return False


report = {"files": 0, "bytes": 0, "hits": []}
for root in roots:
    for dirpath, _, names in os.walk(root):
        for n in names:
            p = os.path.join(dirpath, n)
            size = os.path.getsize(p)
            report["files"] += 1
            report["bytes"] += size
            if size == 0:
                continue
            with open(p, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                if leak(mm):
                    report["hits"].append(os.path.relpath(p, os.path.dirname(root)))
with open(report_file, "w", encoding="utf-8") as fh:
    json.dump(report, fh, ensure_ascii=False, indent=1)
sys.exit(1 if report["hits"] else 0)
'@

# ---------------------------------------------------------------------------

$VenvDir = Resolve-RepoPath $Venv
$OutDir = Resolve-RepoPath $Out
$PyOut = Join-Path $OutDir 'python'
$ModelOut = Join-Path $OutDir 'model'
$ModelSrc = Resolve-RepoPath $ModelSource
$SidecarDir = Join-Path $RepoRoot 'sidecar'
$Pins = Join-Path $SidecarDir 'requirements-stt.txt'
$Tmp = Join-Path $OutDir '.tmp'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'

# Python печатает UTF-8, а Windows PowerShell 5.1 читает вывод в OEM-кодировке.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$ReadyMarker = Join-Path $PyOut $ReadyMarkerName
if ($SkipIfReady) {
  $reason = Get-NotReadyReason
  if (-not $reason) {
    $mk = [IO.File]::ReadAllText($ReadyMarker) | ConvertFrom-Json
    Write-Host "Рантайм распознавания уже собран и проверен ($($mk.builtAt), CUDA: $($mk.cuda)) — сборку пропускаю" -ForegroundColor Green
    exit 0
  }
  Write-Host "Рантайм распознавания нужно собрать: $reason" -ForegroundColor Yellow
}

# Отметку снимаем до любых изменений. python.exe появляется в build/stt/python
# одним из первых шагов, а падение на VC++, проверке или Ctrl+C оставляет
# рантайм без библиотек и без проверки — по наличию python.exe их не отличить.
if (Test-Path -LiteralPath $ReadyMarker) { Remove-Item -LiteralPath $ReadyMarker -Force }

Step 'Базовый Python'
if (-not (Test-Path -LiteralPath $VenvPython)) { throw "Нет $VenvPython — создайте venv сайдкара (см. README)" }
$cfgPath = Join-Path $VenvDir 'pyvenv.cfg'
$cfg = @{}
foreach ($line in [IO.File]::ReadAllLines($cfgPath)) {
  $i = $line.IndexOf('=')
  if ($i -gt 0) { $cfg[$line.Substring(0, $i).Trim().ToLowerInvariant()] = $line.Substring($i + 1).Trim() }
}
if (-not $BasePython) {
  if (-not $cfg.ContainsKey('home')) { throw "В $cfgPath нет home" }
  $BasePython = $cfg['home']
}
$BasePython = [IO.Path]::GetFullPath($BasePython)
if (-not (Test-Path -LiteralPath (Join-Path $BasePython 'python.exe'))) { throw "Нет python.exe в $BasePython" }
if (-not (Test-Path -LiteralPath (Join-Path $BasePython 'Lib\os.py'))) { throw "В $BasePython нет стандартной библиотеки (Lib\os.py)" }
$venvVersion = ''
if ($cfg.ContainsKey('version')) { $venvVersion = $cfg['version'] }
elseif ($cfg.ContainsKey('version_info')) { $venvVersion = $cfg['version_info'] }
Write-Host "  $BasePython (venv: Python $venvVersion)"

# Модель проверяем до пересоздания рантайма: неполная папка весов не должна
# сначала стереть рабочую сборку.
$modelMissing = @(Get-MissingModelFiles $ModelSrc)
if ($modelMissing.Count -gt 0) {
  throw "В папке модели $ModelSrc нет: $($modelMissing -join ', '). Укажите папку с весами: -ModelSource <путь>"
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Reset-Dir $Tmp 'copy_dists.py'
[IO.File]::WriteAllText((Join-Path $Tmp 'copy_dists.py'), $CopyDistsPy)
[IO.File]::WriteAllText((Join-Path $Tmp 'smoke.py'), $SmokePy)
[IO.File]::WriteAllText((Join-Path $Tmp 'compile_pyc.py'), $CompilePy)
[IO.File]::WriteAllText((Join-Path $Tmp 'scan_paths.py'), $ScanPy)

Step 'Копия стандартной библиотеки'
Reset-Dir $PyOut 'python.exe'
# Не нужны для работы: документация, IDLE, tkinter с Tcl/Tk, тесты стандартной
# библиотеки (34 МБ), заголовки и .lib для сборки, pip. site-packages базовой
# установки тоже не берём: там может лежать что угодно, поставленное владельцем машины.
$xd = @()
foreach ($d in @('Doc', 'Tools', 'tcl', 'Scripts', 'include', 'libs', 'share')) { $xd += (Join-Path $BasePython $d) }
foreach ($d in @('test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'site-packages')) { $xd += (Join-Path $BasePython "Lib\$d") }
$xd += '__pycache__'
$xf = @('pythonw.exe', 'NEWS.txt', '_tkinter.pyd', 'tcl*.dll', 'tk*.dll', '*.pdb', '*.pyc')
Invoke-Robocopy $BasePython $PyOut (@('/E', '/XD') + $xd + @('/XF') + $xf)
New-Item -ItemType Directory -Path (Join-Path $PyOut 'Lib\site-packages') -Force | Out-Null

Step 'Пакеты из venv'
$dists = $Packages
if (-not $NoCuda) { $dists = $Packages + $CudaPackages }
$copyReport = Join-Path $Tmp 'copy.json'
# -E -s: venv не должен подхватить PYTHONPATH или пользовательские пакеты сборщика.
& $VenvPython -E -s (Join-Path $Tmp 'copy_dists.py') (Join-Path $PyOut 'Lib\site-packages') $Pins $copyReport @dists
if ($LASTEXITCODE -ne 0) { throw "Копирование пакетов завершилось с кодом $LASTEXITCODE" }
$copy = [IO.File]::ReadAllText($copyReport) | ConvertFrom-Json
if ($copy.missing.Count -gt 0) { throw "В venv нет пакетов: $($copy.missing -join ', ')" }
foreach ($m in $copy.mismatch) { Write-Warning "версия не совпадает с закреплённой: $m" }
foreach ($p in $copy.dists.PSObject.Properties) { Write-Host ("  {0} {1}" -f $p.Name, $p.Value) }
Write-Host ("  файлов: {0}, {1}" -f $copy.files, (Format-MB ([int64]$copy.bytes)))

Step 'Библиотеки Visual C++'
if (-not $VcRedist) { $VcRedist = Find-VcRedist }
if (-not $VcRedist -or -not (Test-Path -LiteralPath (Join-Path $VcRedist 'msvcp140.dll'))) {
  throw 'Не нашла Microsoft.VC14x.CRT. Поставьте Visual Studio Build Tools (компонент MSVC) или укажите -VcRedist <папка>'
}
# ctranslate2.dll, onnxruntime.dll и soxr импортируют msvcp140*.dll, которых нет
# ни в Python, ни в чистой Windows. Рядом с python.exe их находит загрузчик DLL:
# каталог приложения он просматривает первым.
$redistVer = Get-FileVer (Join-Path $VcRedist 'vcruntime140.dll')
$ownVc = Join-Path $PyOut 'vcruntime140.dll'
if (Test-Path -LiteralPath $ownVc) {
  $ownVer = Get-FileVer $ownVc
  if ($redistVer -lt $ownVer) {
    throw "vcruntime140.dll из $VcRedist ($redistVer) старше, чем у Python ($ownVer). Обновите Build Tools или укажите -VcRedist"
  }
}
foreach ($n in $VcDlls) { Copy-Item -LiteralPath (Join-Path $VcRedist $n) -Destination (Join-Path $PyOut $n) -Force }
Write-Host "  $VcRedist ($redistVer)"

Step 'Модель'
if ([IO.Path]::GetFullPath($ModelSrc).TrimEnd('\') -ieq [IO.Path]::GetFullPath($ModelOut).TrimEnd('\')) {
  Write-Host "  уже на месте: $ModelOut"
} else {
  Reset-Dir $ModelOut 'model.bin'
  Invoke-Robocopy $ModelSrc $ModelOut @('/E')
}
$modelMissing = @(Get-MissingModelFiles $ModelOut)
if ($modelMissing.Count -gt 0) { throw "В модели нет $($modelMissing -join ', ') ($ModelOut)" }

Step 'Проверка рантайма'
$RuntimePython = Join-Path $PyOut 'python.exe'
# Окружение как у чистой машины: без PYTHONHOME/PYTHONPATH, без пользовательских
# пакетов, без сети для huggingface_hub и с PATH только из Windows — чтобы DLL
# не нашлись случайно в папках разработчика (CUDA Toolkit, чужой Python).
$envNames = @('PYTHONHOME', 'PYTHONPATH', 'PYTHONNOUSERSITE', 'PYTHONSTARTUP', 'HF_HUB_OFFLINE', 'PATH')
$savedEnv = @{}
foreach ($k in $envNames) { $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
$smokeReport = Join-Path $Tmp 'smoke.json'
try {
  [Environment]::SetEnvironmentVariable('PYTHONHOME', $null, 'Process')
  [Environment]::SetEnvironmentVariable('PYTHONPATH', $null, 'Process')
  [Environment]::SetEnvironmentVariable('PYTHONSTARTUP', $null, 'Process')
  [Environment]::SetEnvironmentVariable('PYTHONNOUSERSITE', '1', 'Process')
  [Environment]::SetEnvironmentVariable('HF_HUB_OFFLINE', '1', 'Process')
  $sysRoot = $env:SystemRoot
  [Environment]::SetEnvironmentVariable('PATH', "$sysRoot\System32;$sysRoot;$sysRoot\System32\Wbem", 'Process')

  # Те же флаги, что у приложения (src/main/stt/sidecar.ts); -B — не оставлять
  # байткод с метками времени, его соберём ниже сами.
  $flags = @('-E', '-s', '-B', '-X', 'utf8')
  $probeOut = & $RuntimePython @flags (Join-Path $SidecarDir 'asr.py') --probe --model $ModelOut
  if ($LASTEXITCODE -ne 0) { throw "asr.py --probe завершился с кодом $LASTEXITCODE" }
  $probe = ($probeOut | Where-Object { $_ -like '{*' } | Select-Object -Last 1) | ConvertFrom-Json
  if (-not $probe.probe.whisperLocal) { throw "asr.py --probe не видит модель: $probeOut" }
  Write-Host "  asr.py --probe: $probeOut"

  $mode = 'full'
  if ($QuickSmoke) { $mode = 'quick' }
  Push-Location -LiteralPath $SidecarDir
  try {
    & $RuntimePython @flags (Join-Path $Tmp 'smoke.py') $SidecarDir $ModelOut $mode $smokeReport
    if ($LASTEXITCODE -ne 0) { throw "Проверка рантайма завершилась с кодом $LASTEXITCODE" }
  } finally { Pop-Location }
  $smoke = [IO.File]::ReadAllText($smokeReport) | ConvertFrom-Json
  Write-Host "  Python $($smoke.python); ctranslate2 $($smoke.versions.ctranslate2), faster-whisper $($smoke.versions.faster_whisper), onnxruntime $($smoke.versions.onnxruntime)"
  foreach ($p in $smoke.dlls.PSObject.Properties) { Write-Host ("  {0}: {1}" -f $p.Name, $p.Value) }
  if ($mode -eq 'full') {
    Write-Host "  процессор: $($smoke.cpu.computeType), $($smoke.cpu.seconds) с"
    if ($smoke.cuda) { Write-Host "  CUDA: $($smoke.cuda.computeType), $($smoke.cuda.seconds) с" } else { Write-Host '  CUDA: видеокарты NVIDIA нет, не проверялась' }
    Write-Host "  захват звука: $($smoke.loopback)"

    # Настоящий старт, как у приложения: asr.py с портом и токеном, --device auto.
    # Ждём строку готовности и гасим процесс. Так проверяется и то, что не
    # покрыли импорты: сервер websockets, поток захвата, выбор устройства.
    $listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $token = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $asrArgs = @($flags) + @("`"$(Join-Path $SidecarDir 'asr.py')`"", '--port', $port, '--token', $token,
      '--model', "`"$ModelOut`"", '--device', 'auto', '--language', 'ru', '--glossary', '""')
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $RuntimePython
    $psi.Arguments = $asrArgs -join ' '
    $psi.WorkingDirectory = $SidecarDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $proc = [Diagnostics.Process]::Start($psi)
    $errTask = $proc.StandardError.ReadToEndAsync()
    $deadline = (Get-Date).AddSeconds(180)
    $ready = $null
    $fatal = $null
    try {
      while (-not $ready) {
        $left = [int]($deadline - (Get-Date)).TotalMilliseconds
        if ($left -le 0) { break }
        $lineTask = $proc.StandardOutput.ReadLineAsync()
        if (-not $lineTask.Wait($left)) { break }
        $line = $lineTask.Result
        if ($null -eq $line) { break }
        if ($line -like '*"ready"*') { $ready = $line | ConvertFrom-Json }
        elseif ($line -like '*"fatal"*') { $fatal = $line }
      }
    } finally {
      try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
      $proc.WaitForExit(15000) | Out-Null
    }
    if (-not $ready) {
      $tail = $errTask.Result
      if ($tail.Length -gt 3000) { $tail = $tail.Substring($tail.Length - 3000) }
      throw "asr.py не сообщил о готовности за 3 минуты. $fatal`n$tail"
    }
    Write-Host "  старт asr.py: $($ready.label), $($ready.computeType); захват: $($ready.loopbackDevice)$($ready.loopbackError)"
  }

  # Байткод для модулей, которые сайдкар грузит на старте. UNCHECKED_HASH: файлы
  # рантайма не меняются, а метки времени после распаковки установщиком могут
  # не совпасть — тогда Python компилировал бы всё заново на каждом запуске,
  # если папка установки недоступна для записи.
  $compiled = & $RuntimePython @flags (Join-Path $Tmp 'compile_pyc.py') $smokeReport
  if ($LASTEXITCODE -ne 0) { throw "Компиляция байткода завершилась с кодом $LASTEXITCODE" }
  Write-Host "  байткод: $compiled модулей"

  Step 'Личные пути'
  # Весь build/stt, а не только .pyc: путь сборщика мог прийти и из пакета
  # (direct_url.json у пакета, поставленного из локальной папки), и из модели
  # (config.json конвертера). Процесс видит USERPROFILE и USERNAME: из
  # окружения выше убраны только переменные Python и PATH.
  $scanReport = Join-Path $Tmp 'scan.json'
  & $RuntimePython @flags (Join-Path $Tmp 'scan_paths.py') $RepoRoot $scanReport $PyOut $ModelOut
  $scanExit = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $scanReport)) { throw "Проверка личных путей завершилась с кодом $scanExit" }
  $scan = [IO.File]::ReadAllText($scanReport) | ConvertFrom-Json
  if (@($scan.hits).Count -eq 0 -and $scanExit -ne 0) { throw "Проверка личных путей завершилась с кодом $scanExit" }
  if (@($scan.hits).Count -gt 0) {
    $shown = @($scan.hits | Select-Object -First 20) -join "`n  "
    throw "В $($scan.hits.Count) файлах рантайма или модели есть путь профиля или репозитория, в установщик это попасть не должно:`n  $shown"
  }
  Write-Host ("  чисто: {0} файлов, {1}" -f $scan.files, (Format-MB ([int64]$scan.bytes)))
} finally {
  foreach ($k in $envNames) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
}

[IO.Directory]::Delete($Tmp, $true)

Step 'Размер'
$pyBytes = Get-DirBytes $PyOut
$spBytes = Get-DirBytes (Join-Path $PyOut 'Lib\site-packages')
$nvDir = Join-Path $PyOut 'Lib\site-packages\nvidia'
$nvBytes = [int64]0
if (Test-Path -LiteralPath $nvDir) { $nvBytes = Get-DirBytes $nvDir }
$modelBytes = Get-DirBytes $ModelOut
Write-Host ("  python: {0} (пакеты {1}, из них NVIDIA {2})" -f (Format-MB $pyBytes), (Format-MB $spBytes), (Format-MB $nvBytes))
Write-Host ("  model:  {0}" -f (Format-MB $modelBytes))
Write-Host ("  всего:  {0}" -f (Format-MB ($pyBytes + $modelBytes)))

# Отметка — строго последний шаг: сюда доходит только сборка, прошедшая все
# проверки. Файл уезжает в установщик вместе с рантаймом, поэтому в нём нет
# путей и имени устройства захвата (у Bluetooth-наушников в имени бывает имя
# владельца) — только версии, итог проверки и хэши.
$cpuCheck = $null
$cudaCheck = $null
if ($mode -eq 'full') {
  $cpuCheck = [ordered]@{ computeType = $smoke.cpu.computeType; seconds = $smoke.cpu.seconds }
  if ($smoke.cuda) { $cudaCheck = [ordered]@{ computeType = $smoke.cuda.computeType; seconds = $smoke.cuda.seconds } }
}
$packages = [ordered]@{}
foreach ($p in $copy.dists.PSObject.Properties) { $packages[$p.Name] = $p.Value }
$marker = [ordered]@{
  format   = $ReadyFormat
  builtAt  = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  smoke    = $mode
  cuda     = [bool](-not $NoCuda)
  python   = $smoke.python
  versions = $smoke.versions
  packages = $packages
  checks   = [ordered]@{ cpu = $cpuCheck; cudaGpu = $cudaCheck; pyc = [int]"$compiled"; personalPathScanFiles = $scan.files }
  bytes    = [ordered]@{ python = $pyBytes; model = $modelBytes }
  inputs   = Get-InputHashes
  model    = Get-ModelSizes $ModelOut
}
[IO.File]::WriteAllText($ReadyMarker, ($marker | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Готово: $OutDir" -ForegroundColor Green
