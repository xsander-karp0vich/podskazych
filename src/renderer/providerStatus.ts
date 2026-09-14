import { providerById } from '../shared/providers.ts'
import { modelFor } from '../shared/models.ts'
import type { Effort, ModelInfo, ProviderId } from '@shared/providers'
import type { AppSettings } from '@shared/settings'
import type { Availability, ProviderStatus } from '../preload'

/**
 * Что окно говорит о провайдере: чип состояния, подпись, чего не хватает.
 *
 * Чистый модуль без React и electron — его проверяют тесты под голым Node
 * (tests/provider-status.test.ts), поэтому импорты значений относительные и с .ts.
 */

type Source = AppSettings['claudeSource']

export type ChipTone = 'ok' | 'warn' | 'danger' | 'muted'

/** «Не проверяли» у registry — unknown без пояснения; unknown с пояснением — уже итог проверки. */
export function isUnchecked(a: Availability): boolean {
  return a.state === 'unknown' && !a.message
}

/**
 * Готов ли тот, кто будет отвечать. У Claude по ключу важен ключ, а не Claude Code:
 * человек мог не ставить CLI вовсе.
 */
export function availabilityOf(st: ProviderStatus, claudeSource: Source): Availability {
  return st.id === 'claude' && claudeSource === 'api' ? (st.claudeApi ?? st.available) : st.available
}

export function isReady(st: ProviderStatus, claudeSource: Source): boolean {
  return availabilityOf(st, claudeSource).state === 'ok'
}

/**
 * Проверка закончилась, и ясно, что без человека провайдер работать не будет: не установлен,
 * без входа или сломан. «Не узнали» сюда не входит — main такого всё равно пробует запустить.
 */
export function needsSetup(st: ProviderStatus, checking: boolean, claudeSource: Source): boolean {
  if (checking) return false
  const state = availabilityOf(st, claudeSource).state
  return state === 'not-installed' || state === 'not-logged-in' || state === 'error'
}

/** Чип состояния: «подключён», «нужен вход», «не установлен», «проверяю…». */
export function chipOf(st: ProviderStatus, checking: boolean, claudeSource: Source): { text: string; tone: ChipTone; title?: string } {
  if (checking) return { text: 'проверяю…', tone: 'muted' }
  const api = st.id === 'claude' && claudeSource === 'api'
  const a = availabilityOf(st, claudeSource)
  switch (a.state) {
    case 'ok':
      return { text: 'подключён', tone: 'ok', title: [a.version, a.account].filter(Boolean).join(' · ') || undefined }
    case 'not-logged-in':
      return api ? { text: 'нет ключа', tone: 'warn' } : { text: 'нужен вход', tone: 'warn' }
    case 'not-installed':
      return { text: 'не установлен', tone: 'warn' }
    case 'error':
      return { text: 'ошибка', tone: 'danger', title: a.message }
    default:
      // Проверка закончилась, а ясности нет: CLI ответил, но выполнен ли вход, по нему не понять.
      return { text: 'не проверен', tone: 'muted', title: a.message }
  }
}

/** «через Claude Code» — или «API по ключу», если к Claude обращаются напрямую. */
export function viaOf(id: ProviderId, claudeSource: Source): string {
  return id === 'claude' && claudeSource === 'api' ? 'API по ключу' : providerById(id).via
}

/**
 * Пояснение под моделями. У Claude по ключу оно другое: лимиты подписки не про API, а свой
 * промпт API не читает — у него зашитый.
 */
export function noteOf(id: ProviderId, claudeSource: Source): string {
  return id === 'claude' && claudeSource === 'api'
    ? 'Прямой вызов по ключу ANTHROPIC_API_KEY, оплата за токены. Свой промпт и команды из него здесь не действуют.'
    : providerById(id).note
}

/**
 * Показывать ли кнопки команд из своего промпта. Claude по ключу держит зашитый промпт:
 * команда ушла бы модели, которая о ней не знает, и за ответ не по делу пришлось бы заплатить.
 */
export function promptReachesModel(s: Pick<AppSettings, 'llmProvider' | 'claudeSource'>): boolean {
  return !(s.llmProvider === 'claude' && s.claudeSource === 'api')
}

/**
 * Чего не хватает, одной фразой — для строки ошибки после выбора неготового провайдера.
 * null — готов или неизвестно: гадать вслух не стоит.
 */
export function notReadyText(st: ProviderStatus, claudeSource: Source): string | null {
  const p = providerById(st.id)
  const a = availabilityOf(st, claudeSource)
  if (st.id === 'claude' && claudeSource === 'api' && a.state !== 'ok') {
    return 'Нет ключа ANTHROPIC_API_KEY — задайте его или переключитесь на Claude Code в «Основных»'
  }
  switch (a.state) {
    case 'not-installed':
      return `${p.agent} не установлен — ${p.name} не ответит. Как поставить — в выборе модели`
    case 'not-logged-in':
      return `Нужен вход в ${p.agent} — нажмите «Войти» в выборе модели`
    case 'error':
      return `${p.agent}: ${a.message}`
    default:
      return null
  }
}

/**
 * Модель, с которой вернуться к провайдеру: прошлый выбор у него, иначе его модель
 * по умолчанию, иначе первая из живого списка (у Ollama своей по умолчанию нет).
 */
export function resumeModel(
  s: Pick<AppSettings, 'llmProvider' | 'llmModel' | 'llmModelByProvider'>,
  id: ProviderId,
  live: readonly ModelInfo[],
): string {
  const remembered = s.llmModelByProvider[id] ?? (s.llmProvider === id ? s.llmModel : undefined)
  return modelFor(id, remembered) || (live[0]?.id ?? '')
}

/**
 * То же для второго агента. Проверяющим этого провайдера ещё не выбирали — берём модель,
 * которой он отвечает: у Ollama своей модели по умолчанию нет, а скачанная и уже знакомая
 * лучше первой попавшейся. У Claude каталог закрытый — там сразу его модель по умолчанию.
 * Порядок тот же, что у migrateSettings, чтобы после перезапуска выбор не сменился.
 */
export function resumeVerifyModel(
  s: Pick<AppSettings, 'verifyProvider' | 'verifyModel' | 'verifyModelByProvider' | 'llmModelByProvider'>,
  id: ProviderId,
  live: readonly ModelInfo[],
): string {
  const remembered =
    s.verifyModelByProvider[id] ??
    (s.verifyProvider === id ? s.verifyModel : undefined) ??
    (id === 'claude' ? undefined : s.llmModelByProvider[id])
  return modelFor(id, remembered) || (live[0]?.id ?? '')
}

const VERIFY_EFFORTS: readonly AppSettings['verifyEffort'][] = ['low', 'medium', 'high']

/**
 * Какие глубины проверки предложить: у второго агента их три, но модель может уметь не все.
 * Пусто — глубина у модели не настраивается (Haiku, Cursor, Gemini, где глубина — сама модель).
 */
export function verifyEffortsOf(efforts: readonly Effort[] | null): AppSettings['verifyEffort'][] {
  return efforts ? VERIFY_EFFORTS.filter((e) => efforts.includes(e)) : []
}

/**
 * Почему у проверяющего глубину не выбрать — вместо молча неактивного переключателя.
 * У Gemini глубина зашита в саму модель (flash-high/medium/low), её и выбирают.
 */
export function verifyDepthNote(id: ProviderId, modelName: string): string {
  if (id === 'cursor') return 'Глубину размышлений Cursor выбирает сам.'
  if (id === 'gemini') return 'У Gemini глубина — сама модель: выберите модель поглубже или побыстрее.'
  return `Для ${modelName} глубина не настраивается.`
}
