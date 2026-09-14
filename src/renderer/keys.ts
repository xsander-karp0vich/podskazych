import { HOTKEYS } from '@shared/settings'
import type { HotkeyId, OverlayStatus } from '@shared/types'

/** Клавиши — значками, а не словами. Return — так Electron называет Enter. */
export const KEY_GLYPH: Record<string, string> = {
  Shift: '⇧',
  Enter: '↵',
  Return: '↵',
  Left: '←',
  Right: '→',
  Down: '↓',
  Up: '↑',
  Plus: '+',
  numadd: 'Num +',
}

/** «Ctrl+Shift+X» -> Ctrl ⇧ X. Нет комбинации — нет и клавиш. */
export function comboKeys(combo: string | null | undefined): string[] {
  if (!combo) return []
  return combo.split('+').map((k) => KEY_GLYPH[k] ?? k)
}

/**
 * Строки таблицы HOTKEYS, которые main занимает у системы, и их id в статусе.
 * Режим сквозь панель в таблице записан строчными — так его id сложился раньше статуса.
 * Стрелок здесь нет: их ловит само окно, и комбинация у них всегда своя.
 */
const STATUS_ID: Partial<Record<string, HotkeyId>> = {
  ask: 'ask',
  screenshot: 'screenshot',
  addshot: 'addShot',
  session: 'session',
  hide: 'hide',
  clickthrough: 'clickThrough',
}

/** id строки таблицы в статусе; undefined — клавиша локальная. */
export function statusHotkeyId(defId: string): HotkeyId | undefined {
  return STATUS_ID[defId]
}

/**
 * Какая комбинация у действия на самом деле. Main берёт первую свободную из
 * запасных, поэтому клавиши берём из статуса: undefined — статус ещё не пришёл,
 * показываем обычную комбинацию; null — занять не удалось ни одну.
 */
export function hotkeyCombo(hotkeys: OverlayStatus['hotkeys'], id: HotkeyId): string | null {
  const got = hotkeys?.[id]
  if (got !== undefined) return got
  return HOTKEYS.find((h) => STATUS_ID[h.id] === id)?.combo ?? null
}
