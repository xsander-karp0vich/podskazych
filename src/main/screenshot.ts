import { desktopCapturer, screen, type BrowserWindow, type NativeImage } from 'electron'
import { canExcludeFromCapture } from './window'

/**
 * Anthropic всё равно ужимает картинку до 1568 px по длинной стороне,
 * поэтому отдавать больше — значит платить за трафик и время загрузки впустую.
 * Стоимость в токенах считается как ширина*высота/750: снимок 2560x1440 это
 * ~4900 токенов, после сжатия до 1568 — ~1850.
 */
const MAX_EDGE = 1568

/** JPEG вместо PNG: на скриншоте интерфейса разница в качестве незаметна,
 *  а размер запроса меньше в разы. На цену в токенах формат не влияет вообще. */
const JPEG_QUALITY = 82

export interface Shot {
  /** base64 без префикса data: */
  data: string
  mediaType: 'image/jpeg'
  width: number
  height: number
  /** маленькая копия для показа в интерфейсе */
  preview: string
}

function fit(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= MAX_EDGE) return image
  const scale = MAX_EDGE / longest
  return image.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'good',
  })
}

/**
 * Снимок экрана.
 *
 * Наш оверлей в кадр не попадает: WDA_EXCLUDEFROMCAPTURE применяется DWM на
 * этапе композиции и действует на ВСЕ сессии захвата, включая наши собственные.
 * Прятать окно на кадр нельзя — это 16-33 мс, в течение которых панель реально
 * видна собеседнику в демонстрации экрана.
 *
 * Если пользователь отключил защиту в настройках, панель в снимок попадёт.
 * Поэтому на время захвата включаем флаг обратно: он ставится в ядре и
 * применяется без мигания, в отличие от hide/show.
 */
export async function captureScreen(
  overlay: BrowserWindow | null,
  displayId?: string,
): Promise<Shot> {
  const restoreProtection =
    overlay && canExcludeFromCapture() && !overlay.isContentProtected?.()
  if (restoreProtection) {
    overlay!.setContentProtection(true)
    await new Promise((r) => setTimeout(r, 60)) // дать DWM применить флаг
  }

  try {
    const display = displayId
      ? screen.getAllDisplays().find((d) => String(d.id) === displayId)
      : screen.getPrimaryDisplay()
    const target = display ?? screen.getPrimaryDisplay()

    // thumbnailSize здесь и есть разрешение снимка: просим нативное,
    // ужимаем уже сами и осознанно.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(target.size.width * target.scaleFactor),
        height: Math.round(target.size.height * target.scaleFactor),
      },
    })

    const source =
      sources.find((s) => s.display_id === String(target.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('Не удалось получить изображение экрана')
    }

    const shot = fit(source.thumbnail)
    const size = shot.getSize()

    return {
      data: shot.toJPEG(JPEG_QUALITY).toString('base64'),
      mediaType: 'image/jpeg',
      width: size.width,
      height: size.height,
      preview: shot.resize({ width: 320, quality: 'good' }).toDataURL(),
    }
  } finally {
    if (restoreProtection) overlay!.setContentProtection(false)
  }
}

/** Приблизительная стоимость снимка в визуальных токенах Anthropic. */
export function imageTokens(width: number, height: number): number {
  return Math.round((width * height) / 750)
}
