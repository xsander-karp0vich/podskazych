/**
 * Пакет ускорения распознавания на видеокартах AMD и Intel — версия 1.
 *
 * На NVIDIA распознавание идёт через CUDA из установщика. Остальным раньше доставался только процессор:
 * фраза за 1–1,3 с против 0,1–0,3 с на видеокарте. Помощник на whisper.cpp с Vulkan работает на любой
 * современной видеокарте, но вместе с моделью ggml весит ~890 МБ — установщик ради части пользователей
 * так не растить. Поэтому пакет скачивается по кнопке в настройках, один раз, из релиза podskazych.
 *
 * Здесь — описание пакета (адреса, размеры, контрольные суммы), разбор итога стартовой проверки
 * видеокарты из готовности сайдкара и то, что показывает строка настроек. Модуль чистый: его читают
 * main, окно и тесты под голым Node.
 */

export const GPU_PACK_VERSION = 'v1'
export const GPU_PACK_TAG = 'gpu-vulkan-v1'
export const GPU_PACK_RELEASE_URL = `https://github.com/xsander-karp0vich/podskazych/releases/download/${GPU_PACK_TAG}/`

export const HELPER_ZIP_NAME = 'podskazych-vk-win-x64.zip'
export const HELPER_EXE = 'podskazych-vk.exe'
export const GGML_MODEL_NAME = 'ggml-large-v3-turbo-q8_0.bin'

export interface PackAsset {
  /** имя ассета в релизе */
  name: string
  /** sha256 в нижнем регистре */
  sha256: string
  /** точный размер в байтах; 0 — ещё не закреплён */
  bytes: number
  /** zip распаковывается в каталог пакета, остальное кладётся как есть */
  unzip: boolean
}

/** Метка незаполненной контрольной суммы. Со сборкой установщика не уживается: см. gpuPackProblems. */
export const PIN_PLACEHOLDER = 'TODO-FILL-FROM-ARTIFACT3'

/**
 * sha256 и размер podskazych-vk-win-x64.zip — сборка помощника с подробностями устройства в hello
 * (ветка gpu-vulkan-build, add359d; podskazych-vk.exe внутри — 9c9e6f61…d977). Архив пересобирается
 * вместе с помощником: новая сборка — новые значения, оба поля разом. В релиз gpu-vulkan-v1 кладётся
 * именно этот файл, иначе загрузка откажет на проверке размера или суммы. Тест формы
 * (tests/gpu-pack.test.ts) и проверка перед `npm run dist` не дадут выпустить установщик с меткой.
 */
export const HELPER_ZIP_PIN: { readonly sha256: string; readonly bytes: number } = {
  sha256: 'f29aa1bd8a2abe9a5a5dbe8d67eca12826ebe01598cfd199636ea9255173289e',
  bytes: 18_092_537,
}

/** Размер архива помощника для подписи кнопки — из закреплённой сборки. */
const HELPER_ZIP_APPROX_BYTES = 18_100_000

export const GPU_PACK_ASSETS: readonly PackAsset[] = [
  { name: HELPER_ZIP_NAME, sha256: HELPER_ZIP_PIN.sha256, bytes: HELPER_ZIP_PIN.bytes, unzip: true },
  {
    // q8_0 везде: на длинных репликах q5_0 заметно хуже, а по скорости не выигрывает (замеры этапа 2).
    name: GGML_MODEL_NAME,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    bytes: 874_188_075,
    unzip: false,
  },
]

const SHA256 = /^[0-9a-f]{64}$/

export const isPinned = (a: Pick<PackAsset, 'sha256' | 'bytes'>): boolean =>
  SHA256.test(a.sha256) && Number.isSafeInteger(a.bytes) && a.bytes > 0

/** Что мешает выпустить установщик с этим описанием пакета. Пусто — всё закреплено. */
export function gpuPackProblems(assets: readonly PackAsset[] = GPU_PACK_ASSETS): string[] {
  return assets.filter((a) => !isPinned(a)).map((a) => `${a.name}: не заполнены sha256 и размер (${a.sha256}, ${a.bytes} байт)`)
}

/**
 * Суммы из JSON {"<ассет>": {"sha256", "bytes"}} поверх описания — только для разработки (COPILOT_GPU_PACK_PINS):
 * проверить загрузку на своём локальном релизе без правки сборки. Любая ошибка — описание без изменений.
 */
export function withPinOverrides(assets: readonly PackAsset[], json: string): { assets: readonly PackAsset[]; problem: string | null } {
  let pins: unknown
  try {
    pins = JSON.parse(json)
  } catch (e) {
    return { assets, problem: `не JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) return { assets, problem: 'нужен объект {"<ассет>": {"sha256", "bytes"}}' }
  const map = pins as Record<string, { sha256?: unknown; bytes?: unknown } | undefined>
  const unknown = Object.keys(map).filter((name) => !assets.some((a) => a.name === name))
  if (unknown.length) return { assets, problem: `нет таких ассетов: ${unknown.join(', ')}` }
  const out: PackAsset[] = []
  for (const a of assets) {
    const p = map[a.name]
    if (!p) {
      out.push(a)
      continue
    }
    const pin = { sha256: typeof p.sha256 === 'string' ? p.sha256.trim().toLowerCase() : '', bytes: Number(p.bytes) }
    if (!isPinned(pin)) return { assets, problem: `${a.name}: sha256 из 64 hex и размер больше нуля` }
    out.push({ ...a, ...pin })
  }
  return { assets: out, problem: null }
}

/** Сколько скачивать: точные размеры, а у незакреплённого — примерный. */
export const packBytes = (assets: readonly PackAsset[] = GPU_PACK_ASSETS): number =>
  assets.reduce((n, a) => n + (a.bytes || (a.unzip ? HELPER_ZIP_APPROX_BYTES : 0)), 0)

/* ---------- видеокарты ---------- */

export const VENDOR_AMD = 0x1002
export const VENDOR_INTEL = 0x8086
export const VENDOR_NVIDIA = 0x10de

export interface GpuAdapter {
  vendorId: number
  deviceId: number
  active: boolean
}

function idOf(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  // На некоторых сборках Chromium идентификаторы приходят строкой «0x1002».
  if (typeof v === 'string' && /^(0x)?[0-9a-f]+$/i.test(v.trim())) return parseInt(v.trim().replace(/^0x/i, ''), 16)
  return -1
}

/** Видеокарты из app.getGPUInfo('basic'). Формат Chromium не обещает — всё незнакомое отбрасываем. */
export function gpuAdaptersOf(info: unknown): GpuAdapter[] {
  const list = (info as { gpuDevice?: unknown } | null)?.gpuDevice
  if (!Array.isArray(list)) return []
  return list.flatMap((d) => {
    if (!d || typeof d !== 'object') return []
    const r = d as Record<string, unknown>
    const vendorId = idOf(r.vendorId)
    if (vendorId <= 0) return []
    return [{ vendorId, deviceId: Math.max(0, idOf(r.deviceId)), active: r.active === true }]
  })
}

/** Есть видеокарта, которой пакет может помочь. */
export const hasPackCandidate = (adapters: readonly GpuAdapter[]): boolean =>
  adapters.some((a) => a.vendorId === VENDOR_AMD || a.vendorId === VENDOR_INTEL)

/**
 * Предлагать ли скачать пакет. Только при AMD или Intel и только если распознавание не на CUDA:
 * ноутбуку со встроенной Intel и NVIDIA пакет не нужен. Сессий ещё не было — судим по NVIDIA рядом:
 * CUDA на ней скорее всего заработает, а если нет, первая же сессия скажет «процессор», и предложение появится.
 */
export function shouldOfferPack(adapters: readonly GpuAdapter[], lastDevice: string | null): boolean {
  if (!hasPackCandidate(adapters)) return false
  if (lastDevice) return lastDevice !== 'cuda'
  return !adapters.some((a) => a.vendorId === VENDOR_NVIDIA)
}

/* ---------- итог стартовой проверки видеокарты (готовность сайдкара) ---------- */

export type GpuTier = 'fast' | 'ladder' | 'mid' | 'cpu'
const TIERS: readonly GpuTier[] = ['fast', 'ladder', 'mid', 'cpu']

export interface GpuGate {
  /** fast — полное окно; ladder и mid — окна-лесенка; cpu — видеокарта не прошла */
  tier: GpuTier
  /** имя устройства, как его назвал Vulkan */
  device: string
  flashAttn: boolean
  /** почему такой уровень — по-русски, от сайдкара */
  reason: string
  tFullMs?: number
  tLadderMs?: number
}

const msOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** Поле vulkan из готовности сайдкара. Сайдкар бывает старее или новее окна: без уровня — считаем, что проверки не было. */
export function parseGpuGate(raw: unknown): GpuGate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!TIERS.includes(r.tier as GpuTier)) return null
  const gate: GpuGate = {
    tier: r.tier as GpuTier,
    device: typeof r.device === 'string' ? r.device.trim() : '',
    flashAttn: r.flashAttn === true,
    reason: typeof r.reason === 'string' ? r.reason.trim() : '',
  }
  const full = msOf(r.tFullMs)
  const ladder = msOf(r.tLadderMs)
  if (full !== undefined) gate.tFullMs = full
  if (ladder !== undefined) gate.tLadderMs = ladder
  return gate
}

/**
 * Итог проверки из строки готовности сайдкара. Поле называется «vulkan» (asr.py, main → ready): окно
 * одно время читало «gpu», и итог молча терялся — строка настроек не видела ни уровня, ни времени, ни
 * своей причины процессора. Имя поля живёт только здесь, а тест кормит сюда настоящую строку ready.
 */
export function gateOfReady(ready: unknown): GpuGate | null {
  if (!ready || typeof ready !== 'object') return null
  return parseGpuGate((ready as { vulkan?: unknown }).vulkan)
}

/**
 * Видеокарта сбоила или замедлилась посреди сессии, и сайдкар перешёл на процессор (событие engine-fallback).
 * Сведения о сессии должны сказать то же, что скажет следующий старт: процессор и почему.
 */
export function gateAfterFallback(gate: GpuGate | null, reason: string): GpuGate {
  return {
    tier: 'cpu',
    device: gate?.device ?? '',
    flashAttn: gate?.flashAttn ?? false,
    reason: `посреди сессии ${noDot(reason)}`,
  }
}

/* ---------- состояние пакета и строка настроек ---------- */

export type GpuPackPhase = 'absent' | 'downloading' | 'verifying' | 'installing' | 'installed' | 'removing' | 'error'

/** Чем кончился старт распознавания после последней установки или удаления пакета. */
export interface SttOutcome {
  /** cuda | vulkan | cpu */
  device: string
  label: string
  fallbackReason: string | null
  gpu: GpuGate | null
}

export interface GpuPackState {
  /** есть AMD или Intel */
  candidate: boolean
  /** предлагать скачать (shouldOfferPack) */
  offer: boolean
  phase: GpuPackPhase
  /** сколько всего скачивать */
  totalBytes: number
  /** скачано, включая докачанное с прошлого раза */
  doneBytes: number
  /** байт в секунду за последние секунды; null — ещё не набралось */
  speedBps: number | null
  /** остаток прерванной загрузки — кнопка «Докачать» */
  partialBytes: number
  error: string | null
  last: SttOutcome | null
  /** установка или удаление пришлись на сессию — применится со следующей */
  pending: 'install' | 'remove' | null
  sessionActive: boolean
}

export type GpuAction = 'download' | 'cancel' | 'remove'

export interface GpuRowView {
  hidden: boolean
  badge: { tone: 'ok' | 'warn' | 'bad'; text: string } | null
  /** цифры загрузки рядом с кнопкой: «35 % · 11,4 МБ/с» */
  meter: string | null
  desc: string
  actions: Array<{ id: GpuAction; label: string; danger?: boolean }>
}

/** Мегабайты десятичные — как в подписи «890 МБ» и в свойствах файла у большинства людей. */
export const mb = (bytes: number): string => Math.round(bytes / 1e6).toLocaleString('ru-RU')

const speedText = (bps: number): string => `${(bps / 1e6).toFixed(1).replace('.', ',')} МБ/с`

const noDot = (s: string) => s.trim().replace(/[.。]+$/, '')

function downloadLabel(s: GpuPackState): string {
  // Круглые десятки на кнопке: «890 МБ» читается быстрее, чем «892 МБ», а точные цифры — в строке загрузки.
  if (s.partialBytes > 0) return `Докачать · ${mb(Math.max(0, s.totalBytes - s.partialBytes))} МБ`
  return `Скачать · ${(Math.round(s.totalBytes / 1e7) * 10).toLocaleString('ru-RU')} МБ`
}

function workingText(o: SttOutcome): string {
  const gate = o.gpu
  // Имя устройства — от проверки; нет его — из подписи «… · видеокарта AMD Radeon RX 5700 XT (Vulkan)».
  const name = gate?.device || /видеокарта\s+(.+?)\s*\(Vulkan\)/i.exec(o.label)?.[1] || 'видеокарте'
  const ms = gate ? (gate.tier === 'fast' ? gate.tFullMs : (gate.tLadderMs ?? gate.tFullMs)) : undefined
  let text = `Распознавание на ${name} через Vulkan`
  if (ms !== undefined) text += ` · фраза за ${Math.round(ms)} мс`
  text += '.'
  if (gate?.tier === 'mid') text += ' Черновики реплик реже, чтобы видеокарта успевала.'
  return text
}

/** Что показывает строка «Ускорение на видеокарте» в «Настройки → Основные». */
export function gpuRowView(s: GpuPackState): GpuRowView {
  const hide: GpuRowView = { hidden: true, badge: null, meter: null, desc: '', actions: [] }
  switch (s.phase) {
    case 'absent':
      if (!s.offer && s.partialBytes <= 0) return hide
      return {
        hidden: false,
        badge: null,
        meter: null,
        desc:
          (s.partialBytes > 0 ? `Загрузка прервалась на ${mb(s.partialBytes)} из ${mb(s.totalBytes)} МБ. ` : '') +
          'Модель для видеокарт AMD и Intel через Vulkan. Скачивается один раз с GitHub, дальше всё локально; ' +
          'при старте сессии видеокарта проходит проверку скорости, не успевает — остаётся процессор.',
        actions: [{ id: 'download', label: downloadLabel(s) }],
      }
    case 'downloading': {
      const pct = s.totalBytes > 0 ? Math.min(100, Math.floor((s.doneBytes / s.totalBytes) * 100)) : 0
      return {
        hidden: false,
        badge: null,
        meter: `${pct} %${s.speedBps ? ` · ${speedText(s.speedBps)}` : ''}`,
        desc: `Скачано ${mb(s.doneBytes)} из ${mb(s.totalBytes)} МБ. Настройки можно закрыть — загрузка продолжится.`,
        actions: [{ id: 'cancel', label: 'Отмена' }],
      }
    }
    case 'verifying':
      return {
        hidden: false,
        badge: { tone: 'warn', text: 'Проверка…' },
        meter: null,
        desc: 'Сверяю контрольные суммы — несколько секунд.',
        actions: [{ id: 'cancel', label: 'Отмена' }],
      }
    case 'installing':
      return {
        hidden: false,
        badge: { tone: 'warn', text: 'Установка…' },
        meter: null,
        desc: 'Распаковываю помощника и переношу модель.',
        actions: [],
      }
    case 'removing':
      return { hidden: false, badge: { tone: 'warn', text: 'Удаление…' }, meter: null, desc: 'Удаляю пакет с диска.', actions: [] }
    case 'error':
      return {
        hidden: false,
        badge: { tone: 'bad', text: 'Не установлено' },
        meter: null,
        // Причины из загрузчика — без точки, как у прочих ошибок приложения; в строке настроек все пояснения с точкой.
        desc: s.error ? `${noDot(s.error)}.` : 'Не удалось скачать пакет.',
        actions: [{ id: 'download', label: s.partialBytes > 0 ? downloadLabel(s) : 'Повторить' }],
      }
    case 'installed': {
      const remove = [{ id: 'remove' as const, label: 'Удалить', danger: true }]
      if (s.pending === 'remove') {
        return {
          hidden: false,
          badge: { tone: 'warn', text: 'Удалится после сессии' },
          meter: null,
          // Держать файлы может и не распознавание: Проводник, консоль или антивирус — поэтому без обвинения сессии.
          desc: 'Файлы пакета сейчас заняты — удалю их, когда сессия закончится.',
          actions: [],
        }
      }
      if (s.pending === 'install') {
        return {
          hidden: false,
          badge: { tone: 'ok', text: 'Установлено' },
          meter: null,
          desc: 'Включится со следующей сессии: идущую не прерываю.',
          actions: remove,
        }
      }
      const o = s.last
      if (!o) {
        return {
          hidden: false,
          badge: { tone: 'ok', text: 'Установлено' },
          meter: null,
          desc: 'Включится при старте сессии — сначала короткая проверка скорости видеокарты.',
          actions: remove,
        }
      }
      if (o.device === 'vulkan') {
        return { hidden: false, badge: { tone: 'ok', text: 'Работает' }, meter: null, desc: workingText(o), actions: remove }
      }
      if (o.device === 'cuda') {
        return {
          hidden: false,
          badge: { tone: 'ok', text: 'Не нужен' },
          meter: null,
          desc: 'Распознавание идёт на NVIDIA через CUDA — пакет можно удалить.',
          actions: remove,
        }
      }
      const reason = noDot(o.gpu?.reason || o.fallbackReason || 'видеокарта не прошла проверку скорости')
      // «Медленнее процессора» → «медленнее процессора»; «AMD Radeon…» и «CUDA…» остаются как есть.
      const lead = /^[А-ЯЁ][а-яё]/.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason
      return {
        hidden: false,
        badge: { tone: 'warn', text: 'Не используется' },
        meter: null,
        desc: `Выбран процессор: ${lead}.`,
        actions: remove,
      }
    }
  }
}

/**
 * Подсказка в строке панели после старта сессии: распознавание на процессоре, видеокарта AMD или Intel
 * есть, пакет не скачан и не скачивается. Одна за запуск приложения — это решает окно; скрыть навсегда — настройка.
 */
export const GPU_HINT_TEXT = 'Распознавание на процессоре. Для видеокарт AMD и Intel есть ускорение — «Настройки → Основные»'

export function gpuHintWanted(s: GpuPackState | null, sttDevice: string, hiddenForever: boolean): boolean {
  return !!s && !hiddenForever && sttDevice === 'cpu' && s.offer && s.phase === 'absent'
}
