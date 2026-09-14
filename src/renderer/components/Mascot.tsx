import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { providerById, type ProviderId } from '@shared/providers'

/**
 * Пиксельные персонажи из макета Claude Design.
 *
 * Mascot — суфлёр в наушниках: голубые наушники — канал собеседника, лаймовое
 * тело — вы. Живёт в пустых состояниях сцены ответа и в «Инструкции».
 *
 * Critter — тот, кто отвечает: значок у выбора модели, в списке провайдеров и в
 * подписи под ответом. У каждого провайдера свой зверёк и цвет — по нему видно,
 * кто ответил, даже когда имя не влезло. Его вид повторяет состояние ответа:
 * думает, печатает, гаснет при ошибке.
 *
 * Каждый пиксель — отдельный span: у глаз, рта и ног свои анимации. При
 * «уменьшить движение» персонажи замирают. Обёрнуты в memo: окно
 * перерисовывается пятнадцать раз в секунду из-за волн уровня, а сотня
 * пикселей от этого не меняется.
 */

// Сетка «Итог v2» логотипа — та же, что у иконки приложения (scripts/make-icons.py):
// лицо симметрично, три ножки растут из тела. Меняется только вместе с иконкой.
const MASCOT_ROWS = [
  '....HHHHHHHH....',
  '...HH......HH...',
  '..HH..####..HH..',
  '.HH.########.HH.',
  'HHH##########HHH',
  'HHH##########HHH',
  '.H##EW####EW##H.',
  '..##EE####EE##..',
  '..############..',
  '..###M#MM#M###..',
  '..###M#MM#M###..',
  '...##########...',
  '....LL.LL.LL....',
  '....LL.LL.LL....',
]

/**
 * Рисунки зверьков по провайдерам — все пиксели здесь, в одном месте: заменить
 * рисунок (Cursor получит своего зверька) — значит поправить одну запись.
 *
 * Сетка 16 × 14. rows — спокойный вид; off — строки 6–7 (глаза закрыты, ответ
 * оборвался); think и type — строки 8–9 (рот, пока модель думает и печатает).
 * # тело, E глаз, W блик, C щека, M рот, L ноги, U уши или антенна. Цвета тела
 * и щёк — из каталога провайдеров, чтобы зверёк и имя не расходились.
 */
interface CritterArt {
  rows: readonly string[]
  off: readonly [string, string]
  think: readonly [string, string]
  type: readonly [string, string]
}

// Claude — рисунок, который был до провайдеров; «думает» у него — рот буквой «о».
const CLAUDE_ART: CritterArt = {
  rows: [
    '..UUU......UUU..',
    '.UUUUU....UUUUU.',
    '.UUUUU....UUUUU.',
    '..############..',
    '.##############.',
    '################',
    '###EW######EW###',
    '###EE######EE###',
    '#C####M##M####C#',
    '#######MM#######',
    '.##############.',
    '..############..',
    '...LL..LL..LL...',
    '...LL..LL..LL...',
  ],
  off: ['################', '###EE######EE###'],
  think: ['#C#####MM#####C#', '#######MM#######'],
  type: ['######M#M#M#####', '######M#M#M#####'],
}

// Круглый зверёк с антенной — ChatGPT; на нём же основаны Cursor и Gemini.
const GPT_ART: CritterArt = {
  rows: [
    '.......UU.......',
    '.......UU.......',
    '........#.......',
    '.....######.....',
    '...##########...',
    '..############..',
    '.###EW####EW###.',
    '.###EE####EE###.',
    '.#C###M##M###C#.',
    '.######MM######.',
    '..############..',
    '...##########...',
    '....LL....LL....',
    '....LL....LL....',
  ],
  off: ['.##############.', '.###EE####EE###.'],
  think: ['.#C###M##M###C#.', '.######MM######.'],
  type: ['.#####M#M#M####.', '.#####M#M#M####.'],
}

// Временный рисунок Cursor из макета — владелец закажет отдельного зверька.
const CURSOR_ART: CritterArt = {
  ...GPT_ART,
  rows: [
    '......U.........',
    '......UU........',
    '......UUU.......',
    '...##UUUU##.....',
    '..####UU####....',
    '.##############.',
    '.###EW####EW###.',
    '.###EE####EE###.',
    '.#C###M##M###C#.',
    '.######MM######.',
    '..############..',
    '...##########...',
    '....LL....LL....',
    '....LL....LL....',
  ],
}

const GEMINI_ART: CritterArt = {
  ...GPT_ART,
  rows: [
    '.......UU.......',
    '......UUUU......',
    '.......UU.......',
    '...##########...',
    '..############..',
    '.##############.',
    '.###EW####EW###.',
    '.###EE####EE###.',
    '.#C###M##M###C#.',
    '.######MM######.',
    '..############..',
    '...##########...',
    '....LL....LL....',
    '....LL....LL....',
  ],
}

// Локальная модель — широкий приземистый зверёк: «живёт» на этом компьютере.
const LOCAL_ART: CritterArt = {
  rows: [
    '.......UU.......',
    '....########....',
    '..############..',
    '################',
    '################',
    '################',
    '##EW########EW##',
    '##EE########EE##',
    '#C#####MM#####C#',
    '######MMMM######',
    '################',
    '.##############.',
    '..LL........LL..',
    '..LL........LL..',
  ],
  off: ['################', '##EE########EE##'],
  think: ['#C#####MM#####C#', '######MMMM######'],
  type: ['#####M#M#M#M####', '#####M#M#M#M####'],
}

const CRITTER_ART: Record<ProviderId, CritterArt> = {
  claude: CLAUDE_ART,
  codex: GPT_ART,
  cursor: CURSOR_ART,
  gemini: GEMINI_ART,
  ollama: LOCAL_ART,
}

const MASCOT_COLOR: Record<string, string> = {
  '#': 'var(--accent)',
  H: 'var(--them)',
  E: 'var(--accent-ink)',
  W: 'var(--text)',
  M: 'var(--accent-ink)',
  L: 'var(--accent)',
}

export type CritterMode = 'idle' | 'think' | 'type' | 'off'

function useStill(still: boolean | undefined): boolean {
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  return still ?? reduced
}

/**
 * Сколько пикселей экрана в CSS-пикселе. Меняется вместе с масштабом интерфейса
 * (Ctrl + / −) и масштабом Windows. Без пересчёта клетка 3 px при 110 % шла
 * на 3,3 пикселя экрана, края клеток округлялись каждый по-своему — клетки
 * выходили разной ширины, со щелями, и зверёк «плыл».
 */
function useDpr(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    let mq: MediaQueryList | null = null
    const update = () => {
      setDpr(window.devicePixelRatio || 1)
      // Запрос разрешения привязан к текущему значению — после смены подписываемся заново.
      mq?.removeEventListener('change', update)
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mq.addEventListener('change', update)
    }
    update()
    window.addEventListener('resize', update)
    return () => {
      mq?.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return dpr
}

/** Клетка в CSS-пикселях, кратная пикселю экрана: все клетки одной ширины и встык. */
function cellSize(size: number, dpr: number): number {
  return Math.max(1, Math.round((size * dpr) / 16)) / dpr
}

function cell(key: string, x: number, y: number, c: number, background: string, animation = 'none', extra?: CSSProperties) {
  return (
    <span
      key={key}
      data-keep=""
      style={{ left: x * c, top: y * c, width: c, height: c, background, animation, ...extra }}
    />
  )
}

/** Рамка из целого числа клеток: 16 × 14, а не номинальный размер, иначе край снова дробный. */
function Frame({ c, title, children }: { c: number; title?: string; children: ReactNode }) {
  return (
    <span className="pixel-art" aria-hidden title={title} style={{ width: c * 16, height: c * 14 }}>
      {children}
    </span>
  )
}

export const Mascot = memo(function Mascot({ size, live, still }: { size: number; live: boolean; still?: boolean }) {
  const frozen = useStill(still)
  const c = cellSize(size, useDpr())
  const rows = MASCOT_ROWS.slice()
  // Сессии нет — рот улыбкой; сессия идёт — суфлёр «проговаривает» ртом.
  if (!live) {
    rows[9] = '..###M####M###..'
    rows[10] = '..####MMMM####..'
  }
  const cells: ReactNode[] = []
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return
      let anim = 'none'
      let extra: CSSProperties | undefined
      if (ch === 'E' || ch === 'W') {
        // Под зрачком — тело: зрачок смещается, и на его месте не должно быть дыры.
        cells.push(cell(`b${x}-${y}`, x, y, c, 'var(--accent)'))
        if (!frozen) anim = 'cb-glance 7s steps(1) infinite, cb-blink-o 3.4s steps(1) infinite'
      }
      if (live && !frozen) {
        if (ch === 'H') anim = `cb-glow 2.4s ease-in-out ${x / 16}s infinite`
        // Ножки в столбцах 4–5, 7–8, 10–11: каждая пара переступает со своей задержкой.
        if (ch === 'L') anim = `cb-step 1.1s ease-in-out ${Math.floor((x - 4) / 3) * 0.18}s infinite`
      }
      if (live && ch === 'M') {
        if (y === 10) return
        anim = frozen ? 'none' : `cb-type .6s ease-in-out ${(x - 5) * 0.07}s infinite`
        extra = { height: c * 2 }
      }
      cells.push(cell(`${x}-${y}`, x, y, c, MASCOT_COLOR[ch] ?? 'var(--accent)', anim, extra))
    }),
  )
  return <Frame c={c}>{cells}</Frame>
})

export const Critter = memo(function Critter({
  mode,
  size,
  still,
  provider = 'claude',
}: {
  mode: CritterMode
  size: number
  still?: boolean
  /** чей зверёк; без него — Claude, как до провайдеров */
  provider?: ProviderId
}) {
  const frozen = useStill(still)
  const off = mode === 'off'
  const c = cellSize(size, useDpr())
  const info = providerById(provider)
  const art = CRITTER_ART[info.id]
  const body = off ? 'var(--claude-off)' : info.color
  const rows = art.rows.slice()
  if (off) {
    rows[6] = art.off[0]
    rows[7] = art.off[1]
  }
  if (mode === 'think') {
    rows[8] = art.think[0]
    rows[9] = art.think[1]
  }
  if (mode === 'type') {
    rows[8] = art.type[0]
    rows[9] = art.type[1]
  }
  const color: Record<string, string> = {
    '#': body,
    E: 'var(--claude-ink)',
    W: '#fff',
    C: off ? 'var(--claude-off-soft)' : info.soft,
    // Печатает — рот лаймовый: это цвет действия, как у кнопки «Спросить».
    M: mode === 'type' ? 'var(--accent)' : 'var(--claude-ink)',
    L: body,
    U: body,
  }
  const cells: ReactNode[] = []
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return
      let anim = 'none'
      let extra: CSSProperties | undefined
      if (!frozen) {
        if ((ch === 'E' || ch === 'W') && !off) {
          anim = mode === 'think' ? 'cb-look 1.2s ease-in-out infinite' : 'cb-blink-y 3.4s linear infinite'
        }
        if (ch === 'U' && mode === 'think') anim = `cb-glow 1.2s ease-in-out ${x > 8 ? 0.3 : 0}s infinite`
        if (ch === 'L' && mode === 'think') anim = `cb-step .9s ease-in-out ${Math.floor((x - 3) / 4) * 0.15}s infinite`
      }
      if (ch === 'M' && mode === 'type') {
        if (y === 9) return
        anim = frozen ? 'none' : `cb-type .5s ease-in-out ${((x - 6) / 2) * 0.1}s infinite`
        extra = { height: c * 2 }
      }
      cells.push(cell(`${x}-${y}`, x, y, c, color[ch] ?? body, anim, extra))
    }),
  )
  return (
    <Frame c={c} title={`Подсказки — ${info.name}`}>
      {cells}
    </Frame>
  )
})
