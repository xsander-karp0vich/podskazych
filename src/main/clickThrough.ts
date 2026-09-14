/**
 * Режим «клики сквозь панель» — одно состояние на всё приложение. Раньше его
 * держали по отдельности хоткей и IPC, и трей с панелью узнавали о смене не
 * всегда: включили в одном месте — в другом виден старый режим. Теперь режим
 * меняют только здесь, а окно, трей и панель подписаны на итог.
 *
 * Модуль без Electron: само переключение окна приходит снаружи, поэтому
 * логику можно проверить обычным node.
 */
export interface ClickThrough {
  readonly on: boolean
  set(on: boolean): void
  toggle(): void
  /** возвращает отписку */
  subscribe(fn: (on: boolean) => void): () => void
}

export function createClickThrough(apply: (on: boolean) => void): ClickThrough {
  let state = false
  // Обёртки, а не сами функции: одну функцию можно подписать дважды, и отписка снимает ровно свою.
  const subs: Array<{ fn: (on: boolean) => void }> = []

  const change = (on: boolean): void => {
    if (on === state) return
    // Сначала окно. Не переключилось — исключение уходит вызвавшему, а состояние и
    // подписчики не трогаются: галочка в трее при панели, которая ловит клики, врала бы.
    apply(on)
    state = on
    for (const sub of subs.slice()) {
      // Подписчик сам сменил режим — остальные уже получили новое значение, старое им не шлём.
      if (state !== on) break
      if (!subs.includes(sub)) continue
      try {
        sub.fn(on)
      } catch (e) {
        // Упавший трей не должен оставить панель без события.
        console.error('[clickthrough] подписчик упал:', e)
      }
    }
  }

  return {
    get on() {
      return state
    },
    set: change,
    toggle: () => change(!state),
    subscribe(fn) {
      const sub = { fn }
      subs.push(sub)
      return () => {
        const i = subs.indexOf(sub)
        if (i >= 0) subs.splice(i, 1)
      }
    },
  }
}
