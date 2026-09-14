import { Tray, Menu, nativeImage, app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ClickThrough } from './clickThrough'
import { AUTOSTART_ARGS } from './appName'

/**
 * Оверлей намеренно живёт без панели задач и без рамки окна (skipTaskbar,
 * frame:false), поэтому трей — единственное место, где приложением можно
 * управлять: показать, спрятать, выйти. Без него его нечем закрыть.
 */
export function createTray(
  win: BrowserWindow,
  opts: {
    onToggleAutostart?: () => void
    /** режим «клики сквозь панель»: пока он включён, по самой панели не кликнуть */
    clickThrough?: ClickThrough
    /** комбинация, которая переключает режим, — подсказкой в пункте меню */
    clickThroughCombo?: string | null
  } = {},
): Tray {
  // createFromPath подхватывает и соседние tray@1.25x…@3x.png — трей на high-DPI берёт
  // свой размер. Базовый tray.png (16 px) нарисован по отдельной сетке 8×8.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'build', 'tray.png')
    : join(app.getAppPath(), 'build', 'tray.png')

  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)

  let contentProtected = true
  const through = opts.clickThrough

  const rebuild = () => {
    // Трей уничтожают при выходе, а режим может смениться и после.
    if (tray.isDestroyed()) return
    // Наведя на значок, видно, почему панель не ловит клики.
    tray.setToolTip(through?.on ? 'Подсказыч — клики сквозь панель' : 'Подсказыч')

    const throughItem: Electron.MenuItemConstructorOptions[] = through
      ? [
          {
            // Выход мышью: пока режим включён, сама панель клики пропускает, и выключить его там нечем.
            label: 'Клики сквозь панель',
            type: 'checkbox',
            checked: through.on,
            // Только подпись: саму клавишу держит globalShortcut, второй раз её не регистрируем.
            ...(opts.clickThroughCombo ? { accelerator: opts.clickThroughCombo, registerAccelerator: false } : {}),
            click: (item) => {
              // Electron переворачивает галочку до вызова: item.checked — то, что просят.
              try {
                through.set(item.checked)
              } catch (e) {
                console.error('[tray] режим сквозь панель не переключился:', e)
                rebuild() // вернуть галочку к настоящему состоянию
              }
            },
          },
        ]
      : []

    const menu = Menu.buildFromTemplate([
      {
        label: win.isVisible() ? 'Спрятать панель' : 'Показать панель',
        click: () => {
          if (win.isVisible()) win.hide()
          else win.show()
          rebuild()
        },
      },
      ...throughItem,
      { type: 'separator' },
      {
        // Оверлей не попадает в скриншоты и запись экрана — это его смысл,
        // но из-за этого его нельзя показать при разборе проблемы.
        label: 'Показывать при захвате экрана (для скриншотов)',
        type: 'checkbox',
        checked: !contentProtected,
        click: (item) => {
          contentProtected = !item.checked
          win.setContentProtection(contentProtected)
          rebuild()
        },
      },
      { type: 'separator' },
      {
        label: 'Запускать при входе в Windows',
        type: 'checkbox',
        // С теми же аргументами, что при записи: иначе Windows не узнаёт свою запись и галочка гаснет.
        checked: app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin,
        click: (item) => {
          // openAsHidden — только macOS; на Windows скрытый старт задаётся аргументом
          app.setLoginItemSettings({ openAtLogin: item.checked, args: AUTOSTART_ARGS })
          opts.onToggleAutostart?.()
        },
      },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ])
    tray.setContextMenu(menu)
  }

  rebuild()
  // Режим меняют и хоткей, и меню панели — галочка и подсказка у значка догоняют по подписке.
  through?.subscribe(() => rebuild())
  tray.on('double-click', () => {
    if (win.isVisible()) win.hide()
    else win.show()
    rebuild()
  })

  return tray
}
