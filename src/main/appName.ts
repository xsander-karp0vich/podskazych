import { app } from 'electron'
import { join } from 'node:path'

/**
 * Приложение переименовано из «Call Copilot» в «Подсказыч». Electron кладёт данные
 * в папку с именем продукта, и после переименования приложение открылось бы «с
 * нуля»: без настроек (они в Local Storage окна), журнала созвонов и кэша базы
 * знаний. Поэтому папка данных остаётся под прежним именем.
 */
export const LEGACY_NAME = 'Call Copilot'

/** Скрытый старт при входе в Windows — одним аргументом и в трее, и при переносе записи. */
export const AUTOSTART_ARGS = ['--hidden']

/** Вызывать до готовности приложения и до первого обращения к userData. */
export function keepLegacyUserData(): void {
  // Для отладки — своя папка данных. По ней же Electron держит блокировку одной копии:
  // проверочный запуск с другой папкой не отдаёт управление установленному приложению
  // и не делит с ним настройки, журнал и хранилище окна.
  const override = process.env.COPILOT_USER_DATA
  if (override) {
    app.setPath('userData', override)
    return
  }
  // Папку, заданную явно (--user-data-dir), Electron уже взял — прежнее имя поверх неё молча вернуло бы
  // запуск в данные установленного приложения, а с ними и в его блокировку одной копии.
  if (app.commandLine.hasSwitch('user-data-dir')) return
  app.setPath('userData', join(app.getPath('appData'), LEGACY_NAME))
}

/**
 * Автозапуск прежней установки записан в реестр под именем «electron.app.Call Copilot»
 * и путём к «Call Copilot.exe». После переустановки галочка в трее погасла бы, а
 * Windows запускала бы файл, которого больше нет. Если старая запись была включена —
 * включаем автозапуск нового exe, а старую запись убираем.
 */
export function migrateAutostart(args: string[] = AUTOSTART_ARGS): void {
  if (!app.isPackaged || process.platform !== 'win32') return
  try {
    if (app.getLoginItemSettings({ args }).openAtLogin) return
    const oldExe = join(app.getPath('home'), 'AppData', 'Local', 'Programs', LEGACY_NAME, `${LEGACY_NAME}.exe`)
    if (app.getLoginItemSettings({ path: oldExe, args }).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, args })
      app.setLoginItemSettings({ openAtLogin: false, path: oldExe, args, name: `electron.app.${LEGACY_NAME}` })
      console.log('[autostart] перенесён на новый exe')
    }
  } catch (e) {
    console.warn('[autostart] не удалось перенести:', e)
  }
}
