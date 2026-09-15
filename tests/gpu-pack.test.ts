import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GGML_MODEL_NAME,
  GPU_PACK_ASSETS,
  GPU_PACK_RELEASE_URL,
  GPU_PACK_VERSION,
  GPU_HINT_TEXT,
  HELPER_EXE,
  HELPER_ZIP_NAME,
  HELPER_ZIP_PIN,
  PIN_PLACEHOLDER,
  VENDOR_AMD,
  VENDOR_INTEL,
  VENDOR_NVIDIA,
  gateAfterFallback,
  gateOfReady,
  gpuAdaptersOf,
  gpuHintWanted,
  gpuPackProblems,
  gpuRowView,
  isPinned,
  packBytes,
  parseGpuGate,
  shouldOfferPack,
  withPinOverrides,
  type GpuPackState,
  type PackAsset,
} from '../src/shared/gpuPack.ts'
import {
  GATE_CACHE_FILE,
  PackCancelled,
  PackError,
  discardPartial,
  forgetGateVerdicts,
  installPack,
  partialBytes,
  readInstalled,
  removePack,
  type InstallOptions,
} from '../src/main/gpu/download.ts'
import { ZipError, inflateZipEntry, zipEntries } from '../src/main/zip.ts'

/* ---------- закрепление пакета ---------- */

test('пакет: форма описания — sha256 из 64 hex и точный размер, либо явная метка «не заполнено» у обоих полей', () => {
  assert.equal(GPU_PACK_RELEASE_URL, 'https://github.com/xsander-karp0vich/podskazych/releases/download/gpu-vulkan-v1/')
  assert.deepEqual(
    GPU_PACK_ASSETS.map((a) => a.name),
    [HELPER_ZIP_NAME, GGML_MODEL_NAME],
  )
  for (const a of GPU_PACK_ASSETS) {
    if (a.sha256 === PIN_PLACEHOLDER) {
      // Метка стоит — размер тоже не выдуман: иначе проверка размера пропустила бы чужой файл.
      assert.equal(a.bytes, 0, `${a.name}: размер без sha256`)
    } else {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, `${a.name}: sha256`)
      assert.ok(Number.isSafeInteger(a.bytes) && a.bytes > 0, `${a.name}: размер`)
    }
  }
  // Заполняется только архив помощника, и одной константой.
  assert.ok(HELPER_ZIP_PIN.sha256 === PIN_PLACEHOLDER || /^[0-9a-f]{64}$/.test(HELPER_ZIP_PIN.sha256))
  assert.equal(GPU_PACK_ASSETS[0]!.sha256, HELPER_ZIP_PIN.sha256)
  assert.equal(GPU_PACK_ASSETS[0]!.bytes, HELPER_ZIP_PIN.bytes)
  const model = GPU_PACK_ASSETS[1]!
  assert.ok(isPinned(model))
  assert.equal(model.bytes, 874_188_075)
  // Подпись кнопки — «890 МБ», как в решении владельца: и с меткой, и после заполнения.
  assert.equal(Math.round(packBytes() / 1e7) * 10, 890)
})

test(
  'пакет: перед сборкой установщика sha256 архива помощника заполнен',
  { skip: process.env.COPILOT_RELEASE === '1' ? false : 'только при сборке установщика (COPILOT_RELEASE=1)' },
  () => {
    assert.deepEqual(gpuPackProblems(), [])
  },
)

test('пакет: суммы для своего локального релиза (COPILOT_GPU_PACK_PINS) — только целиком верные', () => {
  const sha = 'b'.repeat(64)
  const ok = withPinOverrides(GPU_PACK_ASSETS, JSON.stringify({ [HELPER_ZIP_NAME]: { sha256: sha.toUpperCase(), bytes: 123 } }))
  assert.equal(ok.problem, null)
  assert.deepEqual(ok.assets[0], { ...GPU_PACK_ASSETS[0]!, sha256: sha, bytes: 123 })
  assert.deepEqual(ok.assets[1], GPU_PACK_ASSETS[1], 'не названный ассет — без изменений')
  for (const bad of ['не json', '[]', JSON.stringify({ 'чужой.bin': { sha256: sha, bytes: 1 } }), JSON.stringify({ [GGML_MODEL_NAME]: { sha256: 'abc', bytes: 1 } })]) {
    const r = withPinOverrides(GPU_PACK_ASSETS, bad)
    assert.ok(r.problem, bad)
    assert.equal(r.assets, GPU_PACK_ASSETS, `${bad}: при ошибке описание не меняется`)
  }
})

test('пакет: незаполненная метка видна проверке сборки', () => {
  const assets: PackAsset[] = [
    { name: 'a.zip', sha256: PIN_PLACEHOLDER, bytes: 0, unzip: true },
    { name: 'b.bin', sha256: 'a'.repeat(64), bytes: 10, unzip: false },
  ]
  assert.equal(gpuPackProblems(assets).length, 1)
  assert.match(gpuPackProblems(assets)[0]!, /a\.zip/)
})

/* ---------- видеокарты и предложение ---------- */

const info = (...devices: Array<Record<string, unknown>>) => ({ gpuDevice: devices, auxAttributes: {} })

test('видеокарты: разбор getGPUInfo — числа, строки 0x…, мусор отброшен', () => {
  assert.deepEqual(gpuAdaptersOf(info({ vendorId: 4098, deviceId: 29471, active: true }, { vendorId: '0x8086', deviceId: '0x46a6' })), [
    { vendorId: VENDOR_AMD, deviceId: 29471, active: true },
    { vendorId: VENDOR_INTEL, deviceId: 0x46a6, active: false },
  ])
  assert.deepEqual(gpuAdaptersOf(null), [])
  assert.deepEqual(gpuAdaptersOf({ gpuDevice: 'нет' }), [])
  assert.deepEqual(gpuAdaptersOf(info({ vendorId: 'зелёный' }, null as never, { deviceId: 5 })), [])
})

test('предложение: только AMD или Intel и только если распознавание не на CUDA', () => {
  const amd = gpuAdaptersOf(info({ vendorId: VENDOR_AMD, deviceId: 0x731f }))
  const intel = gpuAdaptersOf(info({ vendorId: VENDOR_INTEL, deviceId: 0x9a49 }))
  const nvidia = gpuAdaptersOf(info({ vendorId: VENDOR_NVIDIA, deviceId: 0x2d04 }))
  const laptop = gpuAdaptersOf(info({ vendorId: VENDOR_INTEL, deviceId: 0x9a49 }, { vendorId: VENDOR_NVIDIA, deviceId: 0x25a2 }))
  const basic = gpuAdaptersOf(info({ vendorId: 0x1414, deviceId: 0x8c }))

  assert.equal(shouldOfferPack(amd, null), true)
  assert.equal(shouldOfferPack(intel, null), true)
  assert.equal(shouldOfferPack(amd, 'cpu'), true)
  assert.equal(shouldOfferPack(nvidia, null), false)
  assert.equal(shouldOfferPack(nvidia, 'cpu'), false)
  assert.equal(shouldOfferPack(basic, 'cpu'), false, 'Microsoft Basic Render Driver — не видеокарта')
  assert.equal(shouldOfferPack([], 'cpu'), false)
  // Ноутбук Intel + NVIDIA: пока сессий не было, надеемся на CUDA; сессия сказала «процессор» — предлагаем.
  assert.equal(shouldOfferPack(laptop, null), false)
  assert.equal(shouldOfferPack(laptop, 'cuda'), false)
  assert.equal(shouldOfferPack(laptop, 'cpu'), true)
  assert.equal(shouldOfferPack(amd, 'cuda'), false)
})

test('готовность сайдкара: поле vulkan разбирается осторожно', () => {
  assert.deepEqual(
    parseGpuGate({ tier: 'mid', device: ' AMD Radeon RX 5700 XT ', flashAttn: false, reason: 'лесенка 310 мс', tFullMs: 520, tLadderMs: 310, extra: 1 }),
    { tier: 'mid', device: 'AMD Radeon RX 5700 XT', flashAttn: false, reason: 'лесенка 310 мс', tFullMs: 520, tLadderMs: 310 },
  )
  assert.deepEqual(parseGpuGate({ tier: 'fast' }), { tier: 'fast', device: '', flashAttn: false, reason: '' })
  assert.deepEqual(parseGpuGate({ tier: 'cpu', tFullMs: 'быстро', tLadderMs: -1, flashAttn: 'yes' }), {
    tier: 'cpu',
    device: '',
    flashAttn: false,
    reason: '',
  })
  assert.equal(parseGpuGate({ tier: 'turbo' }), null)
  assert.equal(parseGpuGate(undefined), null)
  assert.equal(parseGpuGate([]), null)
})

/* ---------- строка настроек ---------- */

const base: GpuPackState = {
  candidate: true,
  offer: true,
  phase: 'absent',
  totalBytes: 892_270_448,
  doneBytes: 0,
  speedBps: null,
  partialBytes: 0,
  error: null,
  last: null,
  pending: null,
  sessionActive: false,
}

test('строка настроек: скрыта без AMD и Intel, предложение, докачка, загрузка, ошибка', () => {
  assert.equal(gpuRowView({ ...base, candidate: false, offer: false }).hidden, true)
  assert.equal(gpuRowView({ ...base, offer: false }).hidden, true, 'на CUDA предлагать нечего')

  const offer = gpuRowView(base)
  assert.equal(offer.hidden, false)
  assert.deepEqual(offer.actions, [{ id: 'download', label: 'Скачать · 890 МБ' }])

  const resume = gpuRowView({ ...base, partialBytes: 312_000_000 })
  assert.equal(resume.actions[0]!.label, 'Докачать · 580 МБ')
  assert.match(resume.desc, /прервалась на 312 из 892 МБ/)

  const going = gpuRowView({ ...base, phase: 'downloading', doneBytes: 312_000_000, speedBps: 11_400_000 })
  assert.equal(going.meter, '34 % · 11,4 МБ/с')
  assert.deepEqual(going.actions, [{ id: 'cancel', label: 'Отмена' }])

  const failed = gpuRowView({ ...base, phase: 'error', error: 'Сеть перестала отвечать' })
  assert.equal(failed.badge?.tone, 'bad')
  assert.equal(failed.desc, 'Сеть перестала отвечать.')
  assert.equal(failed.actions[0]!.id, 'download')
})

test('строка настроек: установлено — устройство и время проверки, причина процессора, отложенное удаление', () => {
  const installed: GpuPackState = { ...base, phase: 'installed' }
  assert.match(gpuRowView(installed).desc, /при старте сессии/)

  const works = gpuRowView({
    ...installed,
    last: {
      device: 'vulkan',
      label: 'whisper-large-v3-turbo · видеокарта AMD Radeon RX 5700 XT (Vulkan)',
      fallbackReason: 'нет видеокарты NVIDIA с CUDA',
      gpu: { tier: 'mid', device: 'AMD Radeon RX 5700 XT', flashAttn: false, reason: '', tFullMs: 610, tLadderMs: 305.4 },
    },
  })
  assert.deepEqual(works.badge, { tone: 'ok', text: 'Работает' })
  assert.match(works.desc, /^Распознавание на AMD Radeon RX 5700 XT через Vulkan · фраза за 305 мс\. Черновики/)

  // Имени от проверки нет — берём из подписи движка.
  const fromLabel = gpuRowView({
    ...installed,
    last: { device: 'vulkan', label: 'whisper · видеокарта Intel Arc A770 (Vulkan)', fallbackReason: null, gpu: null },
  })
  assert.equal(fromLabel.desc, 'Распознавание на Intel Arc A770 через Vulkan.')

  const cpu = gpuRowView({
    ...installed,
    last: {
      device: 'cpu',
      label: 'whisper · процессор',
      fallbackReason: null,
      gpu: { tier: 'cpu', device: 'AMD Radeon 780M', flashAttn: true, reason: 'Видеокарта медленнее процессора: 1400 мс против 1250 мс.' },
    },
  })
  assert.deepEqual(cpu.badge, { tone: 'warn', text: 'Не используется' })
  assert.equal(cpu.desc, 'Выбран процессор: видеокарта медленнее процессора: 1400 мс против 1250 мс.')
  assert.deepEqual(cpu.actions, [{ id: 'remove', label: 'Удалить', danger: true }])

  const pendingRemove = gpuRowView({ ...installed, pending: 'remove', sessionActive: true })
  assert.deepEqual(pendingRemove.actions, [])
  assert.match(pendingRemove.badge!.text, /после сессии/)
  assert.match(gpuRowView({ ...installed, pending: 'install', sessionActive: true }).desc, /со следующей сессии/)
})

/**
 * Настоящие строки ready из stt.log сквозной проверки (asr.py с пакетом, CUDA_VISIBLE_DEVICES=-1). Окно читало
 * поле «gpu», сайдкар слал «vulkan» — итог терялся молча. Здесь договор проверяется на том, что сайдкар
 * действительно печатает; менять строки — только вместе с asr.py (test_main_ready_reports_vulkan).
 */
const READY_FAST =
  '{"ready": true, "engine": "whisper.cpp", "label": "whisper-large-v3-turbo · видеокарта NVIDIA GeForce RTX 5060 Ti (Vulkan)", "model": "C:\\\\app\\\\sidecar\\\\models\\\\whisper-large-v3-turbo", "device": "vulkan", "computeType": "q8_0", "fallbackReason": "нет видеокарты NVIDIA с CUDA", "vulkan": {"tier": "fast", "device": "NVIDIA GeForce RTX 5060 Ti", "flashAttn": true, "tFullMs": 120, "tLadderMs": null, "tCpuMs": null, "cached": false, "reason": null}, "loopbackDevice": "Динамики (PRO X 2 LIGHTSPEED) [Loopback]", "loopbackError": null}'
const READY_MID =
  '{"ready": true, "engine": "whisper.cpp", "label": "whisper-large-v3-turbo · видеокарта NVIDIA GeForce RTX 5060 Ti (Vulkan)", "model": "m", "device": "vulkan", "computeType": "q8_0", "fallbackReason": "нет видеокарты NVIDIA с CUDA", "vulkan": {"tier": "mid", "device": "NVIDIA GeForce RTX 5060 Ti", "flashAttn": false, "tFullMs": 273, "tLadderMs": 213, "tCpuMs": 858, "cached": false, "reason": null}, "loopbackDevice": null, "loopbackError": null}'
const READY_CPU_CACHED =
  '{"ready": true, "engine": "faster-whisper", "label": "whisper-large-v3-turbo · процессор", "model": "m", "device": "cpu", "computeType": "int8_float32", "fallbackReason": "нет видеокарты NVIDIA с CUDA; Vulkan: видеокарта сбоила в прошлый раз: помощник Vulkan завершился (код 1)", "vulkan": {"tier": "cpu", "device": "NVIDIA GeForce RTX 5060 Ti", "flashAttn": null, "tFullMs": null, "tLadderMs": null, "tCpuMs": null, "cached": true, "reason": "видеокарта сбоила в прошлый раз: помощник Vulkan завершился (код 1)"}, "loopbackDevice": null, "loopbackError": null}'
const READY_NO_PACK =
  '{"ready": true, "engine": "faster-whisper", "label": "whisper-large-v3-turbo · процессор", "model": "m", "device": "cpu", "computeType": "int8_float32", "fallbackReason": "процессор выбран вручную", "vulkan": null, "loopbackDevice": null, "loopbackError": null}'

test('готовность сайдкара: итог проверки видеокарты — из поля «vulkan» настоящей строки ready', () => {
  const fast = gateOfReady(JSON.parse(READY_FAST))
  assert.deepEqual(fast, { tier: 'fast', device: 'NVIDIA GeForce RTX 5060 Ti', flashAttn: true, reason: '', tFullMs: 120 })
  const mid = gateOfReady(JSON.parse(READY_MID))
  assert.deepEqual(mid, { tier: 'mid', device: 'NVIDIA GeForce RTX 5060 Ti', flashAttn: false, reason: '', tFullMs: 273, tLadderMs: 213 })
  const cpu = gateOfReady(JSON.parse(READY_CPU_CACHED))
  assert.equal(cpu?.tier, 'cpu')
  assert.match(cpu!.reason, /^видеокарта сбоила в прошлый раз/)
  assert.equal(gateOfReady(JSON.parse(READY_NO_PACK)), null)
  // Старое имя поля — не договор: такой строки сайдкар не печатает.
  assert.equal(gateOfReady({ ready: true, gpu: { tier: 'fast' } }), null)
  assert.equal(gateOfReady(null), null)

  // Строка настроек по этим итогам: время фразы, заметка MID, своя причина процессора.
  const installed: GpuPackState = { ...base, phase: 'installed' }
  const outcome = (line: string) => {
    const r = JSON.parse(line) as { device: string; label: string; fallbackReason: string | null }
    return { device: r.device, label: r.label, fallbackReason: r.fallbackReason, gpu: gateOfReady(r) }
  }
  assert.equal(gpuRowView({ ...installed, last: outcome(READY_FAST) }).desc, 'Распознавание на NVIDIA GeForce RTX 5060 Ti через Vulkan · фраза за 120 мс.')
  assert.match(gpuRowView({ ...installed, last: outcome(READY_MID) }).desc, /фраза за 213 мс\. Черновики реплик реже/)
  assert.equal(
    gpuRowView({ ...installed, last: outcome(READY_CPU_CACHED) }).desc,
    'Выбран процессор: видеокарта сбоила в прошлый раз: помощник Vulkan завершился (код 1).',
  )
})

test('переход на процессор посреди сессии: итог сессии — процессор и причина', () => {
  const was = gateOfReady(JSON.parse(READY_FAST))
  const after = gateAfterFallback(was, 'помощник Vulkan завершился (код 1)')
  assert.deepEqual(after, { tier: 'cpu', device: 'NVIDIA GeForce RTX 5060 Ti', flashAttn: true, reason: 'посреди сессии помощник Vulkan завершился (код 1)' })
  const row = gpuRowView({
    ...base,
    phase: 'installed',
    last: { device: 'cpu', label: 'whisper-large-v3-turbo · процессор', fallbackReason: 'нет видеокарты NVIDIA с CUDA; Vulkan: …', gpu: after },
  })
  assert.deepEqual(row.badge, { tone: 'warn', text: 'Не используется' })
  assert.equal(row.desc, 'Выбран процессор: посреди сессии помощник Vulkan завершился (код 1).')
  assert.equal(gateAfterFallback(null, 'видеокарта замедлилась.').reason, 'посреди сессии видеокарта замедлилась')
})

test('подсказка в панели: процессор, есть AMD или Intel, пакет не скачан и не скрыт навсегда', () => {
  assert.equal(gpuHintWanted(base, 'cpu', false), true)
  assert.equal(gpuHintWanted(base, 'cpu', true), false)
  assert.equal(gpuHintWanted(base, 'cuda', false), false)
  assert.equal(gpuHintWanted(base, 'vulkan', false), false)
  assert.equal(gpuHintWanted({ ...base, phase: 'downloading' }, 'cpu', false), false)
  assert.equal(gpuHintWanted({ ...base, phase: 'installed' }, 'cpu', false), false)
  assert.equal(gpuHintWanted({ ...base, offer: false }, 'cpu', false), false)
  assert.equal(gpuHintWanted(null, 'cpu', false), false)
  assert.match(GPU_HINT_TEXT, /Настройки → Основные/)
})

/* ---------- ZIP с настоящим CRC ---------- */

function zipOf(entries: Array<{ name: string; data: Buffer; store?: boolean; crc?: number }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const body = e.store ? e.data : deflateRawSync(e.data)
    const crc = e.crc ?? crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.store ? 0 : 8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(e.store ? 0 : 8, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    parts.push(local, name, body)
    central.push(cen, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, eocd])
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

test('zip: распаковка сверяет CRC и размер — битый байт в программе не пройдёт', async () => {
  const data = randomBytes(5000)
  const good = zipOf([{ name: 'a.bin', data }])
  const [entry] = [...zipEntries(good, 10)]
  assert.deepEqual(await inflateZipEntry(good, entry!, 1e6), data)

  const bad = zipOf([{ name: 'a.bin', data, crc: (crc32(data) + 1) >>> 0 }])
  const [badEntry] = [...zipEntries(bad, 10)]
  await assert.rejects(inflateZipEntry(bad, badEntry!, 1e6), (e: unknown) => e instanceof ZipError && e.problem === 'broken')
  await assert.rejects(inflateZipEntry(good, entry!, 100), (e: unknown) => e instanceof ZipError && e.problem === 'bomb')
})

/* ---------- загрузка на локальном HTTP-сервере ---------- */

interface Route {
  data: Buffer
  etag?: string
  /** отдавать 200 целиком, не глядя на Range */
  ignoreRange?: boolean
  /** оборвать соединение, отдав столько байт (один раз) */
  cutAt?: number
  /** замолчать после первого куска, не закрывая соединение (один раз) */
  stall?: boolean
  /** пауза между кусками, мс */
  delayMs?: number
  /** заявить другой полный размер */
  lieTotal?: number
  onChunk?: (sent: number) => void
  /** перенаправить сюда (как GitHub на objects.githubusercontent.com) */
  redirect?: string
}

interface Hit {
  path: string
  range?: string
  ifRange?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function serve(routes: Record<string, Route>): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/rel\//, '/'))
    hits.push({ path, range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined })
    const r = routes[path]
    if (!r) {
      res.writeHead(404).end()
      return
    }
    if (r.redirect) {
      res.writeHead(302, { location: r.redirect }).end()
      return
    }
    const total = r.data.length
    let start = 0
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const ifRange = req.headers['if-range']
    if (m && !r.ignoreRange && (!ifRange || ifRange === r.etag)) {
      start = Number(m[1])
      if (start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` }).end()
        return
      }
      res.writeHead(206, {
        'content-length': total - start,
        'content-range': `bytes ${start}-${total - 1}/${r.lieTotal ?? total}`,
        ...(r.etag ? { etag: r.etag } : {}),
      })
    } else {
      res.writeHead(200, { 'content-length': r.lieTotal ?? total, ...(r.etag ? { etag: r.etag } : {}) })
    }
    const chunk = 32 * 1024
    for (let off = start; off < total; off += chunk) {
      if (r.cutAt !== undefined && off >= r.cutAt) {
        r.cutAt = undefined
        await sleep(60)
        res.destroy()
        return
      }
      res.write(r.data.subarray(off, Math.min(total, off + chunk)))
      r.onChunk?.(off + chunk)
      if (r.stall) {
        r.stall = false
        await new Promise((resolve) => res.once('close', resolve))
        return
      }
      if (r.delayMs) await sleep(r.delayMs)
      if (res.destroyed) return
    }
    res.end()
  }
  const srv = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/rel/`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections()
        srv.close(() => resolve())
      }),
  }
}

const MODEL = 'model.bin'

function fixture() {
  const exe = randomBytes(300_000)
  const readme = Buffer.from('# помощник\n')
  const sums = Buffer.from(`${sha(exe)}  ${HELPER_EXE}\n${sha(readme)}  README.md\n`)
  const zip = zipOf([
    { name: HELPER_EXE, data: exe },
    { name: 'README.md', data: readme, store: true },
    { name: 'SHA256SUMS.txt', data: sums },
  ])
  const model = randomBytes(1_500_000)
  const assets: PackAsset[] = [
    { name: HELPER_ZIP_NAME, sha256: sha(zip), bytes: zip.length, unzip: true },
    { name: MODEL, sha256: sha(model), bytes: model.length, unzip: false },
  ]
  return { exe, zip, model, assets }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gpu-pack-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const opts = (root: string, url: string, assets: readonly PackAsset[], extra: Partial<InstallOptions> = {}): InstallOptions => ({
  root,
  version: GPU_PACK_VERSION,
  assets,
  baseUrl: url,
  required: [HELPER_EXE, MODEL],
  freeBytes: async () => null,
  ...extra,
})

test('загрузка: обрыв посреди модели — докачка с того же байта по Range, установка целиком, прогресс растёт', async () => {
  const f = fixture()
  const srv = await serve({
    [`/${HELPER_ZIP_NAME}`]: { data: f.zip, etag: '"zip1"' },
    [`/${MODEL}`]: { data: f.model, etag: '"m1"', cutAt: 640_000 },
  })
  try {
    await withRoot(async (root) => {
      const err = await installPack(opts(root, srv.url, f.assets)).then(
        () => null,
        (e: unknown) => e,
      )
      assert.ok(err instanceof PackError && err.resumable, `ожидалась докачиваемая ошибка, пришло ${String(err)}`)
      const have = await partialBytes(root, f.assets)
      assert.ok(have > f.zip.length && have < f.zip.length + f.model.length, `частично: ${have}`)
      assert.equal(await readInstalled(root, GPU_PACK_VERSION, [HELPER_EXE, MODEL]), null, 'полупакет не установлен')

      const progress: number[] = []
      const pack = await installPack(opts(root, srv.url, f.assets, { onProgress: (p) => p.phase === 'downloading' && progress.push(p.doneBytes) }))
      const modelHits = srv.hits.filter((h) => h.path === `/${MODEL}`)
      assert.equal(modelHits.length, 2)
      assert.equal(modelHits[1]!.range, `bytes=${have - f.zip.length}-`)
      assert.equal(modelHits[1]!.ifRange, '"m1"')
      // Архив уже целый — второй раз его не качаем.
      assert.equal(srv.hits.filter((h) => h.path === `/${HELPER_ZIP_NAME}`).length, 1)
      assert.ok(progress.includes(have), 'скачанное раньше засчитано сразу, а не с нуля')
      assert.ok(
        progress.every((n, i) => i === 0 || n >= progress[i - 1]!),
        'прогресс не откатывается',
      )
      assert.equal(progress.at(-1), f.zip.length + f.model.length)

      assert.equal(pack.dir, join(root, GPU_PACK_VERSION))
      assert.deepEqual(await readFile(join(pack.dir, HELPER_EXE)), f.exe)
      assert.deepEqual(await readFile(join(pack.dir, MODEL)), f.model)
      assert.ok(await readInstalled(root, GPU_PACK_VERSION, [HELPER_EXE, MODEL]))
      // Скачанное убрано, временных каталогов не осталось.
      assert.deepEqual((await readdir(root)).sort(), [GPU_PACK_VERSION])
    })
  } finally {
    await srv.close()
  }
})

test('загрузка: переадресация как у GitHub и сервер без Range — всё равно целый файл', async () => {
  const f = fixture()
  const srv = await serve({
    [`/${HELPER_ZIP_NAME}`]: { redirect: '/cdn/zip', data: Buffer.alloc(0) },
    '/cdn/zip': { data: f.zip },
    [`/${MODEL}`]: { data: f.model, ignoreRange: true, cutAt: 500_000 },
  })
  try {
    await withRoot(async (root) => {
      await assert.rejects(installPack(opts(root, srv.url, f.assets)), PackError)
      // Сервер отдаёт 200 на Range — .part пишется заново, а не склеивается со старым началом.
      const pack = await installPack(opts(root, srv.url, f.assets))
      assert.deepEqual(await readFile(join(pack.dir, MODEL)), f.model)
      assert.ok(srv.hits.some((h) => h.path === '/cdn/zip'))
    })
  } finally {
    await srv.close()
  }
})

test('загрузка: sha256 не совпал — ничего не установлено, испорченное выброшено', async () => {
  const f = fixture()
  const tampered = Buffer.from(f.model)
  tampered[1000] = tampered[1000]! ^ 0xff
  const srv = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: f.zip }, [`/${MODEL}`]: { data: tampered } })
  try {
    await withRoot(async (root) => {
      await assert.rejects(installPack(opts(root, srv.url, f.assets)), (e: unknown) => e instanceof PackError && !e.resumable && /Контрольная сумма/.test(e.message))
      assert.equal(await readInstalled(root, GPU_PACK_VERSION, [HELPER_EXE, MODEL]), null)
      assert.equal(await partialBytes(root, f.assets), f.zip.length, 'целый архив остался, битая модель — нет')
    })
  } finally {
    await srv.close()
  }
})

test('загрузка: отмена — PackCancelled, после discardPartial докачивать нечего', async () => {
  const f = fixture()
  const ctrl = new AbortController()
  const srv = await serve({
    [`/${HELPER_ZIP_NAME}`]: { data: f.zip },
    [`/${MODEL}`]: { data: f.model, delayMs: 15, onChunk: (sent) => sent > 200_000 && ctrl.abort() },
  })
  try {
    await withRoot(async (root) => {
      await assert.rejects(installPack(opts(root, srv.url, f.assets, { signal: ctrl.signal })), PackCancelled)
      assert.ok((await partialBytes(root, f.assets)) > 0, 'до «Отмены» скачанное лежит')
      await discardPartial(root)
      assert.equal(await partialBytes(root, f.assets), 0)
      assert.equal(await readInstalled(root, GPU_PACK_VERSION, [HELPER_EXE, MODEL]), null)
    })
  } finally {
    await srv.close()
  }
})

test('загрузка: сервер замолчал — ошибка «сеть перестала отвечать», скачанное сохранено', async () => {
  const f = fixture()
  const srv = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: f.zip }, [`/${MODEL}`]: { data: f.model, stall: true } })
  try {
    await withRoot(async (root) => {
      await assert.rejects(
        installPack(opts(root, srv.url, f.assets, { stallMs: 300 })),
        (e: unknown) => e instanceof PackError && e.resumable && /перестала отвечать/.test(e.message),
      )
      assert.ok((await partialBytes(root, f.assets)) > f.zip.length)
    })
  } finally {
    await srv.close()
  }
})

test('загрузка: 404, чужой размер, нет места, незакреплённый пакет — внятные отказы', async () => {
  const f = fixture()
  const srv = await serve({ [`/${MODEL}`]: { data: f.model, lieTotal: f.model.length + 10 } })
  try {
    await withRoot(async (root) => {
      await assert.rejects(installPack(opts(root, srv.url, f.assets)), (e: unknown) => e instanceof PackError && /404/.test(e.message))
      const onlyModel = f.assets.slice(1)
      await assert.rejects(
        installPack({ ...opts(root, srv.url, onlyModel), required: [MODEL] }),
        (e: unknown) => e instanceof PackError && !e.resumable && /Размер/.test(e.message),
      )
      await assert.rejects(
        installPack(opts(root, srv.url, f.assets, { freeBytes: async () => 1000 })),
        (e: unknown) => e instanceof PackError && /места на диске/.test(e.message),
      )
      const before = srv.hits.length
      await assert.rejects(
        installPack(opts(root, srv.url, [{ ...f.assets[0]!, sha256: PIN_PLACEHOLDER, bytes: 0 }, f.assets[1]!])),
        (e: unknown) => e instanceof PackError && /не закреплён/.test(e.message),
      )
      assert.equal(srv.hits.length, before, 'без контрольной суммы в сеть не ходим')
    })
  } finally {
    await srv.close()
  }
})

test('распаковка: путь из архива мимо каталога и расхождение с SHA256SUMS — отказ, наружу ничего не пишется', async () => {
  const model = randomBytes(1000)
  const exe = randomBytes(2000)
  const evil = zipOf([
    { name: HELPER_EXE, data: exe },
    { name: '../evil.txt', data: Buffer.from('x') },
  ])
  const lying = zipOf([
    { name: HELPER_EXE, data: exe },
    { name: 'SHA256SUMS.txt', data: Buffer.from(`${'0'.repeat(64)}  ${HELPER_EXE}\n`) },
  ])
  for (const [zip, label] of [
    [evil, 'evil'],
    [lying, 'lying'],
  ] as const) {
    const assets: PackAsset[] = [
      { name: HELPER_ZIP_NAME, sha256: sha(zip), bytes: zip.length, unzip: true },
      { name: MODEL, sha256: sha(model), bytes: model.length, unzip: false },
    ]
    const srv = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: zip }, [`/${MODEL}`]: { data: model } })
    try {
      await withRoot(async (root) => {
        await assert.rejects(installPack(opts(root, srv.url, assets)), (e: unknown) => e instanceof PackError && /повреждён/.test(e.message), label)
        assert.equal(await stat(join(root, 'evil.txt')).catch(() => null), null)
        assert.equal(await readInstalled(root, GPU_PACK_VERSION, [HELPER_EXE, MODEL]), null)
        // Модель, перенесённая было в установку, не потеряна: докачивать 874 МБ заново не придётся.
        assert.equal((await readdir(root)).filter((n) => n.includes('staging')).length, 0)
        assert.ok((await partialBytes(root, assets)) >= model.length, label)
      })
    } finally {
      await srv.close()
    }
  }
})

test('установка поверх следа сбоя и удаление: каталог версии без манифеста заменяется, удаление убирает всё', async () => {
  const f = fixture()
  const srv = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: f.zip }, [`/${MODEL}`]: { data: f.model } })
  try {
    await withRoot(async (root) => {
      await mkdir(join(root, GPU_PACK_VERSION), { recursive: true })
      await writeFile(join(root, GPU_PACK_VERSION, 'огрызок.bin'), 'x')
      await mkdir(join(root, `${GPU_PACK_VERSION}.staging-dead`), { recursive: true })

      // Сбой уже после переноса модели в установку: модель возвращается в загрузки, качать её заново не нужно.
      await assert.rejects(
        installPack({ ...opts(root, srv.url, f.assets), required: [HELPER_EXE, MODEL, 'нет-такого.dll'] }),
        (e: unknown) => e instanceof PackError && /нет-такого\.dll/.test(e.message),
      )
      assert.equal(await partialBytes(root, f.assets), f.zip.length + f.model.length)
      const hitsBefore = srv.hits.length

      const pack = await installPack(opts(root, srv.url, f.assets))
      assert.equal(srv.hits.length, hitsBefore, 'всё уже скачано — установка без сети')
      assert.equal(await stat(join(pack.dir, 'огрызок.bin')).catch(() => null), null)
      assert.deepEqual(await readdir(root), [GPU_PACK_VERSION])

      // Обрезанная модель — пакет больше не считается установленным.
      await writeFile(join(pack.dir, MODEL), f.model.subarray(0, 10))
      assert.equal(await readInstalled(root, GPU_PACK_VERSION, [HELPER_EXE, MODEL]), null)

      await removePack(root, GPU_PACK_VERSION)
      assert.deepEqual(await readdir(root), [])
      // Повторное удаление — не ошибка.
      await removePack(root, GPU_PACK_VERSION)
    })
  } finally {
    await srv.close()
  }
})

test('докачка: скорость — только о байтах из сети, скачанное в прошлый раз её не раздувает', async () => {
  const f = fixture()
  const model = randomBytes(3_000_000)
  const assets: PackAsset[] = [f.assets[0]!, { name: MODEL, sha256: sha(model), bytes: model.length, unzip: false }]
  // Обрыв на 2,4 МБ, докачка остатка медленно: кусок 32 КБ раз в 50 мс — не больше ~0,64 МБ/с.
  const srv = await serve({
    [`/${HELPER_ZIP_NAME}`]: { data: f.zip, etag: '"z"' },
    [`/${MODEL}`]: { data: model, etag: '"m"', cutAt: 2_400_000 },
  })
  try {
    await withRoot(async (root) => {
      const err = await installPack(opts(root, srv.url, assets)).then(() => null, (e: unknown) => e)
      // Соединение было и оборвалось посреди файла — это «оборвалась, докачайте», а не «не удалось связаться».
      assert.ok(err instanceof PackError && err.resumable, String(err))
      assert.match((err as Error).message, /^Загрузка оборвалась — нажмите «Докачать»/)
      const slow = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: f.zip, etag: '"z"' }, [`/${MODEL}`]: { data: model, etag: '"m"', delayMs: 50 } })
      try {
        const speeds: number[] = []
        await installPack(opts(root, slow.url, assets, { onProgress: (p) => p.speedBps !== null && speeds.push(p.speedBps) }))
        assert.ok(speeds.length > 0, 'скорость ни разу не показана')
        // Было: 2,4 МБ с диска засчитывались за первые секунды — «3+ МБ/с» при настоящих 0,6.
        assert.ok(Math.max(...speeds) < 1_300_000, `скорость после «Докачать»: ${speeds.map((s) => Math.round(s / 1000)).join(', ')} КБ/с`)
      } finally {
        await slow.close()
      }
    })
  } finally {
    await srv.close()
  }
})

test('загрузка: ответ не 200 назван по адресу ответа, файл загрузки занят — не «проверьте сеть»', async () => {
  const f = fixture()
  const srv = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: f.zip } })
  try {
    await withRoot(async (root) => {
      // Локальный сервер или прокси ответил 503 — это не GitHub.
      const busy: typeof fetch = async () => new Response('нет', { status: 503 })
      await assert.rejects(
        installPack(opts(root, srv.url, f.assets, { fetch: busy })),
        (e: unknown) => e instanceof PackError && /^127\.0\.0\.1 ответил 503/.test(e.message),
      )
      await assert.rejects(
        installPack(opts(root, 'https://github.com/x/y/releases/download/t/', f.assets, { fetch: busy })),
        (e: unknown) => e instanceof PackError && /^GitHub ответил 503/.test(e.message),
      )

      // .part только для чтения (как занятый антивирусом): открыть на дозапись нельзя.
      await installPack(opts(root, srv.url, f.assets)).catch(() => {})
      const part = join(root, 'downloads', `${MODEL}.part`)
      await writeFile(part, f.model.subarray(0, 1000))
      await writeFile(`${part}.json`, JSON.stringify({ sha256: f.assets[1]!.sha256, validator: null }))
      await chmod(part, 0o444)
      const withModel = await serve({ [`/${HELPER_ZIP_NAME}`]: { data: f.zip }, [`/${MODEL}`]: { data: f.model } })
      try {
        await assert.rejects(
          installPack(opts(root, withModel.url, f.assets)),
          (e: unknown) => e instanceof PackError && e.resumable && /занят другой программой/.test(e.message),
        )
      } finally {
        await chmod(part, 0o666)
        await withModel.close()
      }
    })
  } finally {
    await srv.close()
  }
})

test('итоги проверки видеокарты забываются при установке и удалении, замер процессора остаётся', async () => {
  await withRoot(async (dir) => {
    assert.equal(await forgetGateVerdicts(join(dir, 'нет-такого')), 0)
    const file = join(dir, GATE_CACHE_FILE)
    const cache = {
      gates: { k1: { tier: 'cpu', failed: true, failReason: 'помощник Vulkan завершился (код 1)', at: 1 }, k2: { tier: 'fast', at: 2 } },
      cpu: { '1|AMD64': 858.2 },
      files: { 'C:/x|1|2': 'ab' },
    }
    await writeFile(file, JSON.stringify(cache, null, 1), 'utf8')
    assert.equal(await forgetGateVerdicts(dir), 2)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { cpu: cache.cpu, files: cache.files })
    assert.equal(await forgetGateVerdicts(dir), 0, 'второй раз забывать нечего')
    // Битый файл сайдкар и сам считает пустым — убираем, не падаем.
    await writeFile(file, '{обрыв', 'utf8')
    assert.equal(await forgetGateVerdicts(dir), 0)
    assert.equal(await stat(file).catch(() => null), null)
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [])
  })
})
