import { globalShortcut } from 'electron'

/**
 * Комбинацию перехватывает сама ОС до того, как её увидит активное окно —
 * поэтому хоткей работает поверх Zoom и Teams. Но register() возвращает false
 * МОЛЧА, если комбинацию уже держит другой процесс (Punto Switcher, Discord,
 * PowerToys, NVIDIA Overlay), поэтому перебираем кандидатов и честно сообщаем,
 * что в итоге досталось.
 *
 * Намеренно не берём:
 *   Zoom  — Alt+A, Alt+V, Alt+S, Alt+R, Alt+Q, Alt+H
 *   Teams — Ctrl+Shift+M, Ctrl+Shift+O, Ctrl+Shift+E, Ctrl+Shift+D
 *   Alt+Space — системное меню окна, забирать его у пользователя грубо.
 */
const CANDIDATES = {
  ask: ['Ctrl+Shift+Space', 'Ctrl+Alt+Space', 'F8'],
  screenshot: ['Ctrl+Shift+Return', 'Ctrl+Alt+Return', 'F10'],
  // «+» в серию снимков. Plus — клавиша «=/+» основного ряда, numadd — «+» цифрового блока.
  addShot: ['Ctrl+Shift+Plus', 'Ctrl+Shift+numadd', 'Ctrl+Alt+Plus'],
  session: ['Ctrl+Shift+S', 'Ctrl+Alt+S', 'F7'],
  hide: ['Ctrl+Shift+H', 'Ctrl+Alt+H', 'F6'],
  clickThrough: ['Ctrl+Shift+X', 'Ctrl+Alt+X', 'F9'],
}

function bindFirstAvailable(candidates: string[], handler: () => void): string | null {
  for (const combo of candidates) {
    if (globalShortcut.isRegistered(combo)) continue
    if (globalShortcut.register(combo, handler)) return combo
  }
  return null
}

export interface HotkeyBindings {
  ask: string | null
  screenshot: string | null
  addShot: string | null
  session: string | null
  toggleClickThrough: string | null
  hide: string | null
}

export function registerHotkeys(handlers: {
  onAsk: () => void
  onScreenshot: () => void
  onAddShot: () => void
  onSession: () => void
  onToggleClickThrough: () => void
  onHide: () => void
}): HotkeyBindings {
  const bindings: HotkeyBindings = {
    ask: bindFirstAvailable(CANDIDATES.ask, handlers.onAsk),
    screenshot: bindFirstAvailable(CANDIDATES.screenshot, handlers.onScreenshot),
    addShot: bindFirstAvailable(CANDIDATES.addShot, handlers.onAddShot),
    session: bindFirstAvailable(CANDIDATES.session, handlers.onSession),
    toggleClickThrough: bindFirstAvailable(CANDIDATES.clickThrough, handlers.onToggleClickThrough),
    // Скрытие занимаем, как и раньше, последним, но итог храним: панель и настройки показывают, что досталось.
    hide: bindFirstAvailable(CANDIDATES.hide, handlers.onHide),
  }

  const failed = Object.entries(bindings).filter(([, v]) => v === null).map(([k]) => k)
  if (failed.length) console.warn(`[hotkeys] не удалось занять: ${failed.join(', ')}`)

  return bindings
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}
