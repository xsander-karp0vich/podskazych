import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'

/**
 * WDA_EXCLUDEFROMCAPTURE появился в Windows 10 2004 (build 19041).
 * Ниже него setContentProtection молча деградирует в WDA_MONITOR —
 * то есть чёрный прямоугольник в шаринге, что хуже видимого окна.
 */
const MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE = 19041

export function canExcludeFromCapture(): boolean {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return build >= MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE
}

export function createOverlayWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  // Горизонтальная панель сверху по центру: под веб-камерой, поэтому взгляд
  // уходит от объектива минимально — вниз, а не вбок.
  const width = Math.min(1140, workArea.width - 80)
  const height = Math.min(470, workArea.height - 80)

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 560,
    minHeight: 220,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + 16,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    // focusable:false ломает ввод в самом оверлее — включаем точечно, когда
    // нужен текстовый ввод (см. setInteractive).
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 'screen-saver' — уровень выше обычного topmost, держится над Zoom/Teams.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  applyContentProtection(win)
  // Аффинити слетает после hide()/show() на Windows (electron#29085).
  win.on('show', () => applyContentProtection(win))

  loadRenderer(win)

  return win
}

/**
 * Без этого окно создаётся пустым, а так как оно ещё и transparent+frameless —
 * на экране просто ничего нет, и выглядит это как «приложение не запустилось».
 *
 * В dev electron-vite поднимает Vite-сервер и кладёт его адрес в
 * ELECTRON_RENDERER_URL; в собранном приложении грузим файл с диска.
 */
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Молчаливый провал загрузки — вторая причина «пустого окна». Пусть кричит.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[overlay] не загрузился рендерер: ${code} ${desc} ${url}`)
    win.show()
  })

  // Окно исключено из захвата экрана, поэтому скриншот с ошибкой снять нельзя.
  // Пробрасываем консоль рендерера в stdout main-процесса — это единственный
  // способ увидеть, что там сломалось.
  win.webContents.on('console-message', (details) => {
    const level = details.level
    if (level !== 'warning' && level !== 'error') return
    console.error(`[renderer:${level}] ${details.message}  (${details.sourceId}:${details.lineNumber})`)
  })

  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`[overlay] рендерер умер: ${d.reason} exitCode=${d.exitCode}`)
  })
}

export function applyContentProtection(win: BrowserWindow): boolean {
  if (!canExcludeFromCapture()) return false
  try {
    win.setContentProtection(true)
    return true
  } catch {
    return false
  }
}

/**
 * Клики проходят насквозь в приложение под оверлеем, но окно продолжает
 * получать mousemove (forward:true) — можно подсвечивать элементы под курсором.
 */
export function setClickThrough(win: BrowserWindow, on: boolean): void {
  win.setIgnoreMouseEvents(on, { forward: true })
}
