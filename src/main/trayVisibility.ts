/**
 * Виден ли значок в трее. Настройка «Спрятать из трея» — просьба, а не приказ: у оверлея нет
 * ни панели задач, ни рамки окна, и трей — последний способ им управлять. Поэтому значок
 * возвращается сам, пока без него приложение осталось бы без управления.
 *
 * Модуль без Electron: решение проверяется обычным node, а main только подставляет состояние.
 */
export interface TrayState {
  /** настройка «Спрятать из трея» */
  hideTray: boolean
  /** включён режим «клики сквозь панель»: по самой панели не кликнуть */
  clickThroughOn: boolean
  /** комбинация, которая выключает режим; null — занять не удалось */
  clickThroughHotkey: string | null
  /** панель на экране (или вот-вот появится при запуске) */
  overlayVisible: boolean
  /** комбинация «Скрыть панель», она же возвращает спрятанную; null — занять не удалось */
  hideHotkey: string | null
  /**
   * Панель отвечает: рендерер загружен и не упал. Пустое прозрачное окно ни меню, ни выхода
   * не покажет. Не передано — считаем, что отвечает.
   */
  overlayUsable?: boolean
}

export function shouldShowTray(s: TrayState): boolean {
  if (!s.hideTray) return true
  // Клики уходят сквозь панель, а клавиши выхода нет: выключить режим можно только из трея.
  if (s.clickThroughOn && !s.clickThroughHotkey) return true
  // Панель спрятана, а клавиши, которая её вернёт, нет: показать её можно только из трея.
  if (!s.overlayVisible && !s.hideHotkey) return true
  if (s.overlayUsable === false) return true
  return false
}

/**
 * Настройка из файла main. Сами настройки живут в хранилище окна, а трей создаётся раньше, чем
 * окно загрузится, — без своей копии значок мелькал бы при каждом запуске. Битый файл — значок
 * показываем: спрятать его по ошибке хуже, чем показать.
 */
export function parseTrayPref(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const v: unknown = JSON.parse(raw)
    return !!v && typeof v === 'object' && (v as { hideTray?: unknown }).hideTray === true
  } catch {
    return false
  }
}

export function serializeTrayPref(hideTray: boolean): string {
  return `${JSON.stringify({ hideTray })}\n`
}
