/** Кто говорит. Определяется каналом захвата, а не diarization-моделью. */
export type Speaker = 'me' | 'them'

/** Сегмент транскрипта. draft перерисовывается, committed — уже нет. */
export interface TranscriptSegment {
  id: string
  speaker: Speaker
  text: string
  /** true — сегмент финализирован STT и больше не изменится */
  final: boolean
  /** мс от начала сессии */
  startMs: number
  endMs: number
}

export interface AudioChunk {
  speaker: Speaker
  /** PCM16 LE, 16 кГц, моно */
  pcm: ArrayBuffer
  /** QQPC-таймштамп начала чанка, мс от старта сессии */
  atMs: number
}

export type CaptureState = 'idle' | 'starting' | 'running' | 'error'

/** Действия на глобальных клавишах — тех, что main занимает у системы. */
export type HotkeyId = 'ask' | 'screenshot' | 'addShot' | 'session' | 'hide' | 'clickThrough'

export interface OverlayStatus {
  capture: CaptureState
  /** удалось ли исключить окно из захвата экрана */
  contentProtected: boolean
  /** комбинация «Спросить»; оставлена для совместимости — все клавиши в hotkeys */
  hotkey: string | null
  /** что удалось занять на самом деле; null — все запасные комбинации держат другие программы */
  hotkeys?: Partial<Record<HotkeyId, string | null>>
  /** включён ли режим «клики сквозь панель» */
  clickThrough?: boolean
  error?: string
}
