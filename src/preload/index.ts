import { contextBridge, ipcRenderer } from 'electron'
import type { Effort, ModelInfo, ProviderId } from '@shared/providers'
import type { ClaudeSource } from '@shared/settings'
import type { OverlayStatus } from '@shared/types'
import type { LlmErrorKind } from '../main/llm/types'
import type { ProviderStatus } from '../main/llm/registry'
import type { TopicGlossary } from '@shared/glossary'
import type { ContextFile } from '@shared/contextFiles'

export interface KbHit {
  uid: string
  question: string
  topic: string
  level: string
  priority: string
  short: string
  spoken: string
  anchors: string
  code: string
  followups: string
  ifDontKnow: string
  /** 1 у лучшего хита, дальше по убыванию — нормировано внутри запроса */
  score: number
  /** доля слов запроса, найденных в записи, 0..1 — без неё мусорное совпадение не отличить */
  coverage: number
}

/** Встроенная база вопросов: файл в ресурсах приложения и его паспорт. */
export interface KbSnapshot {
  filePath: string
  /** -1 — паспорта нет, а индекс не построился */
  rows: number
  bytes: number
  /** дата последней правки базы, «2026-09-13»; null — паспорта нет */
  version: string | null
}
/** Строка списка записей: всё, что нужно списку, без чтения самого разговора. */
export interface JournalSummary {
  id: string
  startedAt: number
  endedAt: number | null
  lines: number
  asks: number
  title: string
  bytes: number
}

export interface SidecarInfo {
  port: number
  token: string
  model: string
  device: string
  engine: string
  label: string
  fallbackReason: string | null
  loopbackDevice: string | null
  loopbackError: string | null
}

type SttStartResult = { ok: true; info: SidecarInfo } | { ok: false; error: string }

/*
 * Типы провайдеров — из main, только типами: в сборку preload код main не попадает,
 * а копии не расходятся с оригиналом. LlmErrorKind — по нему окно предлагает действие
 * («Войти», «Как установить», другую модель); Availability — установлен ли и выполнен ли вход.
 */
export type { Availability, LlmErrorKind } from '../main/llm/types'
export type { ProviderStatus } from '../main/llm/registry'

type SuggestResult = { ok: true; text: string } | { ok: false; error: string; kind?: LlmErrorKind }

/** Кто отвечает и с какими настройками — общее у подсказки, снимка и прогрева. */
export interface LlmTarget {
  provider: ProviderId
  /** только у Claude: живая сессия Claude Code ('cli') или API по ключу */
  claudeSource?: ClaudeSource
  customPrompt?: string
  /** точный id модели провайдера */
  model?: string
  thinking?: boolean
  effort?: EffortChoice
  /** включённые файлы для контекста по порядку списка: main соберёт из их текста блок промпта */
  contextFiles?: Array<{ id: string; name: string }>
}

/** Итог добавления файлов для контекста: что легло в список и что не прочиталось. */
export interface ContextAddResult {
  added: ContextFile[]
  failed: Array<{ name: string; error: string }>
  /** диалог закрыли, ничего не выбрав */
  canceled?: true
}

export type EffortChoice = 'default' | Effort
export type VerifyStatus = 'checking' | 'ok' | 'issues' | 'unclear' | 'error' | 'skipped' | 'cancelled'
export type VerifyStage = 'queued' | 'working' | 'thinking' | 'searching' | 'writing'
export interface VerifyUpdate {
  requestId: number
  status: VerifyStatus
  notes: string[]
  tookMs?: number
  startedAt?: number
  stage?: VerifyStage
  text?: string
  refs?: string[]
  error?: string
}
/** Настройки второго агента. Он работает с любым провайдером — своей verify-сессией. */
export interface VerifyConfig {
  enabled: boolean
  /** кто проверяет; не обязан совпадать с тем, кто отвечает */
  provider: ProviderId
  /**
   * На второго агента не влияет: у Claude он всегда идёт через Claude Code — API по ключу
   * держит свой зашитый промпт и вердикт не напишет. Поле — ради симметрии с LlmTarget.
   */
  claudeSource?: ClaudeSource
  /** точный id модели провайдера provider */
  model: string
  effort: 'low' | 'medium' | 'high'
  /** искать в интернете; main исполняет, только если у провайдера ProviderInfo.webSearch */
  web: boolean
}

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: unknown, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const api = {
  getStatus: (): Promise<OverlayStatus> => ipcRenderer.invoke('status:get'),

  /** Встроенная база знаний: сколько записей и какой версии; undefined — ещё грузится. */
  getKbSnapshot: (): Promise<KbSnapshot | null | undefined> => ipcRenderer.invoke('kb:snapshot:get'),
  /** База догрузилась (или не загрузилась) — окно настроек, открытое раньше, узнаёт итог. */
  onKbSnapshot: (cb: (s: KbSnapshot | null) => void) => subscribe<KbSnapshot | null>('kb:snapshot', cb),

  /**
   * Поиск по базе знаний. Дёшев (доли миллисекунды), поэтому его можно звать
   * на каждой завершённой реплике собеседника, не дожидаясь хоткея.
   */
  searchKb: (query: string, top = 3): Promise<{ hits: KbHit[]; confident: boolean }> =>
    ipcRenderer.invoke('kb:search', { query, top }),

  /** Словарь распознавания по темам — строится из того же снимка базы. */
  getKbGlossary: (): Promise<TopicGlossary | null> => ipcRenderer.invoke('kb:glossary:get'),
  onKbGlossary: (cb: (g: TopicGlossary | null) => void) =>
    subscribe<TopicGlossary | null>('kb:glossary', cb),

  // окно
  setInteractive: (v: boolean): Promise<void> => ipcRenderer.invoke('window:setInteractive', v),
  /**
   * Клики сквозь панель. Режим держит main: панель просит смену и узнаёт итог из
   * onClickThroughChanged — так же, как о смене хоткеем или из трея.
   */
  setClickThrough: (on: boolean): Promise<void> => ipcRenderer.invoke('window:setClickThrough', on),
  getClickThrough: (): Promise<boolean> => ipcRenderer.invoke('window:getClickThrough'),
  setOpacity: (v: number): Promise<void> => ipcRenderer.invoke('window:setOpacity', v),
  setContentProtection: (v: boolean): Promise<void> => ipcRenderer.invoke('window:setContentProtection', v),
  /**
   * «Спрятать из трея». Настройка — в окне, main держит её копию к следующему запуску и сам
   * возвращает значок, пока без него приложением не управлять.
   */
  setHideTray: (v: boolean): Promise<void> => ipcRenderer.invoke('window:setHideTray', v),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),

  // изменение размера окна: рамки нет, тянем сами за уголок
  beginResize: (): Promise<void> => ipcRenderer.invoke('window:beginResize'),
  resizeBy: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke('window:resizeBy', dx, dy),
  endResize: (): Promise<void> => ipcRenderer.invoke('window:endResize'),
  setZoom: (factor: number): Promise<number> => ipcRenderer.invoke('window:setZoom', factor),

  // журнал созвонов
  journalLine: (speaker: 'me' | 'them', text: string): void =>
    ipcRenderer.send('journal:line', { speaker, text }),
  journalList: (): Promise<JournalSummary[]> => ipcRenderer.invoke('journal:list'),
  journalDelete: (id: string): Promise<JournalSummary[]> => ipcRenderer.invoke('journal:delete', id),
  journalSetEnabled: (on: boolean): Promise<void> => ipcRenderer.invoke('journal:setEnabled', on),
  journalOpenFolder: (): Promise<string> => ipcRenderer.invoke('journal:openFolder'),
  journalDir: (): Promise<string> => ipcRenderer.invoke('journal:dir'),
  journalExport: (
    id: string,
    format: 'md' | 'json',
  ): Promise<{ ok: true; path: string } | { ok: false; canceled?: true; error?: string }> =>
    ipcRenderer.invoke('journal:export', { id, format }),

  // файлы для контекста: список и флаги — в настройках окна, текст — в main
  /** Выбрать файлы системным диалогом; have — сколько уже в списке. */
  pickContextFiles: (have: number): Promise<ContextAddResult> => ipcRenderer.invoke('context:pick', have),
  /** Перетащенные файлы: имя и байты — путь к файлу окну недоступен. */
  addContextFiles: (files: Array<{ name: string; data: Uint8Array }>, have: number): Promise<ContextAddResult> =>
    ipcRenderer.invoke('context:addBuffers', { files, have }),
  removeContextFile: (id: string): Promise<void> => ipcRenderer.invoke('context:remove', id),
  /** id файлов, чей текст пропал с диска. */
  missingContextFiles: (ids: string[]): Promise<string[]> => ipcRenderer.invoke('context:missing', ids),
  /** Удалить тексты файлов, которых нет в списке. */
  pruneContextFiles: (keep: string[]): Promise<number> => ipcRenderer.invoke('context:prune', keep),

  // распознавание
  startStt: (opts: { language?: string; glossary?: string }): Promise<SttStartResult> =>
    ipcRenderer.invoke('stt:start', opts),
  stopStt: (): Promise<void> => ipcRenderer.invoke('stt:stop'),
  /** Сайдкар завершился сам посреди сессии: переподключаться клиенту больше не к чему. */
  onSttExit: (cb: (p: { error: string }) => void) => subscribe<{ error: string }>('stt:exit', cb),

  // скриншот
  listScreens: (): Promise<Array<{ id: string; label: string; primary: boolean }>> =>
    ipcRenderer.invoke('screen:list'),
  askScreen: (
    p: LlmTarget & {
      question: string
      transcript: string
      displayId?: string
      /** снимки серии по порядку; пусто — снять экран сейчас */
      seriesIds?: string[]
      requestId: number
      timeoutSec?: number
    },
  ): Promise<
    { ok: true; text: string; previews: string[] } | { ok: false; error: string; previews?: string[]; kind?: LlmErrorKind }
  > =>
    ipcRenderer.invoke('screen:ask', p),
  /** Снять экран в серию, не отправляя: задача не влезла в один экран. */
  addToSeries: (p: {
    displayId?: string
  }): Promise<{ ok: true; id: string; preview: string; screen: string; count: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('screen:series-add', p),
  removeFromSeries: (id: string): Promise<number> => ipcRenderer.invoke('screen:series-remove', id),
  clearSeries: (): Promise<void> => ipcRenderer.invoke('screen:series-clear'),

  // подсказка
  suggest: (
    p: LlmTarget & {
      transcript: string
      question: string
      useKnowledgeBase: boolean
      requestId: number
      kbTopK?: number
      timeoutSec?: number
    },
  ): Promise<SuggestResult> => ipcRenderer.invoke('llm:suggest', p),
  /** Поднять сессию провайдера заранее — старт CLI оплачивается до вопроса, а не во время. */
  warmupLlm: (
    p: LlmTarget & { /** основную сессию не греть, только второго агента */ skipMain?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string; kind?: LlmErrorKind }> =>
    ipcRenderer.invoke('llm:warmup', p),

  // провайдеры
  /**
   * Все провайдеры с тем, что о них известно сейчас, — без ожидания. Проверки
   * запускаются в фоне, свежие итоги приходят в onProvidersUpdated.
   */
  listProviders: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('llm:providers'),
  onProvidersUpdated: (cb: (all: ProviderStatus[]) => void) => subscribe<ProviderStatus[]>('llm:providers-updated', cb),
  /** Модели провайдера: живой список или запасной. */
  getModels: (provider: ProviderId): Promise<ModelInfo[]> => ipcRenderer.invoke('llm:models', provider),
  /** Открыть терминал с командой входа провайдера. Итог — через recheckProvider. */
  loginProvider: (provider: ProviderId): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('llm:login', provider),
  /** Проверить провайдера заново — после входа или установки. */
  recheckProvider: (provider: ProviderId): Promise<ProviderStatus> => ipcRenderer.invoke('llm:recheck', provider),
  /**
   * Открыть страницу установки провайдера в браузере. main открывает только адреса из
   * каталога (PROVIDERS[].install.url), остальное отклоняет.
   */
  openExternal: (url: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('app:openExternal', url),
  onDelta: (cb: (p: { requestId: number; chunk: string }) => void) =>
    subscribe<{ requestId: number; chunk: string }>('llm:delta', cb),
  onThinking: (cb: (p: { requestId: number }) => void) =>
    subscribe<{ requestId: number }>('llm:thinking', cb),
  /** Итог проверки подсказки вторым агентом: приходит позже самого ответа. */
  onVerify: (cb: (p: VerifyUpdate) => void) => subscribe<VerifyUpdate>('llm:verify', cb),
  /** Проверить подсказку сейчас — по кнопке из окна второго агента. */
  verifyNow: (p: {
    requestId: number
    question: string
    answer: string
    verify: VerifyConfig
    kbTopK?: number
  }): Promise<{ ok: true }> => ipcRenderer.invoke('llm:verify-now', p),
  /** Настройки второго агента — при каждой смене: main решает о проверке по актуальным. */
  setVerifyConfig: (cfg: VerifyConfig): Promise<{ ok: true }> => ipcRenderer.invoke('llm:verify-config', cfg),

  // события из main
  onAsk: (cb: () => void) => subscribe<void>('hotkey:ask', cb),
  onScreenshot: (cb: () => void) => subscribe<void>('hotkey:screenshot', cb),
  onAddShot: (cb: () => void) => subscribe<void>('hotkey:add-shot', cb),
  onToggleSession: (cb: () => void) => subscribe<void>('hotkey:session', cb),
  onStatus: (cb: (s: OverlayStatus) => void) => subscribe<OverlayStatus>('status', cb),
  onClickThroughChanged: (cb: (v: boolean) => void) => subscribe<boolean>('clickthrough:changed', cb),
}

contextBridge.exposeInMainWorld('copilot', api)
export type CopilotApi = typeof api
