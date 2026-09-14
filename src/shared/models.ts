import { CLAUDE_MODELS, findModel, providerById, type ModelInfo, type ProviderId, type Effort } from './providers.ts'

/**
 * Модели для подсказок и второго агента.
 *
 * Каталог Claude живёт в providers.ts рядом с остальными провайдерами. Здесь —
 * помощники поверх него. Без провайдера они работают как раньше — про Claude:
 * старые подсказки в истории и старые настройки второго агента знают только Claude.
 */
export const MODELS = CLAUDE_MODELS

export type ModelId = (typeof MODELS)[number]['id']

export const DEFAULT_MODEL: ModelId = 'claude-opus-5'

/** Так модели хранились до расширения списка — псевдонимы CLI. Сохранённый выбор не должен сброситься. */
const LEGACY: Record<string, ModelId> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

const BY_ID = new Map<string, (typeof MODELS)[number]>(MODELS.map((m) => [m.id, m]))

export function isClaudeModel(value: unknown): value is ModelId {
  return typeof value === 'string' && BY_ID.has(value)
}

/** Модель Claude — точным id или старым псевдонимом. */
export function isClaudeChoice(value: unknown): boolean {
  return isClaudeModel(value) || (typeof value === 'string' && Object.hasOwn(LEGACY, value))
}

/** Сохранённое или пришедшее по IPC значение — в известную модель Claude; незнакомое — модель по умолчанию. */
export function normalizeModel(value: unknown, fallback: ModelId = DEFAULT_MODEL): ModelId {
  if (typeof value !== 'string') return fallback
  if (BY_ID.has(value)) return value as ModelId
  // hasOwn, а не просто LEGACY[value]: иначе «toString» из битых настроек вернул бы функцию.
  return Object.hasOwn(LEGACY, value) ? LEGACY[value]! : fallback
}

/**
 * Модель, которая уйдёт провайдеру. У Claude — только известная (каталог закрытый).
 * У остальных список живой и может знать модели, которых нет в запасном, поэтому
 * id не проверяем: пустое — модель провайдера по умолчанию, остальное как есть.
 */
export function modelFor(provider: ProviderId, value: unknown): string {
  if (provider === 'claude') return normalizeModel(value)
  return typeof value === 'string' && value.trim() ? value.trim() : providerById(provider).defaultModel
}

/** «Opus 5», «GPT-5.6 Sol» — для подписей под ответом и в заголовках окон. */
export function modelName(id: string, provider: ProviderId = 'claude', live?: readonly ModelInfo[]): string {
  if (provider === 'claude') return BY_ID.get(normalizeModel(id))!.name
  // Модель из живого списка, которой нет в запасном, подписываем её id: лучше честный id, чем чужое имя.
  return findModel(provider, id, live)?.name ?? (id || 'модель по умолчанию')
}

/**
 * «Opus», «Sol» — в узком окне, где полное имя не помещается. Короткого имени нет в живом
 * списке — берём из каталога (findModel добирает его), нет и там — первое слово имени.
 */
export function modelFamily(id: string, provider: ProviderId = 'claude', live?: readonly ModelInfo[]): string {
  const found = provider === 'claude' ? undefined : findModel(provider, id, live)
  if (found?.short) return found.short
  return modelName(id, provider, live).split(' ')[0]!
}

export function modelNote(id: string, provider: ProviderId = 'claude', live?: readonly ModelInfo[]): string {
  if (provider === 'claude') return BY_ID.get(normalizeModel(id))!.note
  const m = findModel(provider, id, live)
  return m?.note ?? m?.hint ?? ''
}

/** Уровни глубины модели; null — не настраивается или модель неизвестна. */
export function modelEfforts(id: string, provider: ProviderId = 'claude', live?: readonly ModelInfo[]): Effort[] | null {
  const m = findModel(provider, provider === 'claude' ? normalizeModel(id) : id, live)
  return m?.efforts ?? null
}

/** У Haiku нет глубины размышлений: флаг --effort не передаётся, «сразу» выключает мышление. */
export function isHaikuModel(id: string): boolean {
  return /haiku/i.test(id)
}
