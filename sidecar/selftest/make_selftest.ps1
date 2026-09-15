# Встроенные фразы стартовой проверки распознавания на видеокарте (vulkan.py).
#
# Синтез голосом Windows (SAPI, «Microsoft Irina Desktop»), текст написан здесь же:
# ни записей людей, ни чужих наборов данных. Повторный запуск даёт те же файлы на
# той же версии Windows. Формат — 16 кГц, моно, PCM16: ровно то, что уходит в модель.
#
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File make_selftest.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$phrases = [ordered]@{
    'short' = 'Мы переделали отчёт на СКД, и теперь он строится за секунду.'
    'long'  = 'Сначала проверим обмен с бухгалтерией, потом посмотрим остатки по регистру накопления. Если документ проводится дольше минуты, откроем технологический журнал и найдём медленный запрос. После этого решим, кто поправит права доступа.'
}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$tsv = @()
foreach ($k in $phrases.Keys) {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice('Microsoft Irina Desktop')
    $s.SetOutputToWaveFile((Join-Path $dir "$k.wav"), $fmt)
    $s.Speak($phrases[$k])
    $s.Dispose()
    $tsv += "$k`t$($phrases[$k])"
}
# без BOM: читается и Python, и глазами
[System.IO.File]::WriteAllLines((Join-Path $dir 'phrases.tsv'), $tsv, (New-Object System.Text.UTF8Encoding($false)))
