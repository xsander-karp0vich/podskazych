import { readFile } from 'node:fs/promises'
import { expandTerms } from './aliases'

/**
 * Поиск по снимку базы знаний.
 *
 * BM25 в памяти, без нативных зависимостей. Тысяча документов — это ничто:
 * построение занимает десятки миллисекунд, поиск — доли миллисекунды. Ради
 * такого объёма тащить SQLite с пересборкой под Electron незачем.
 *
 * Смысл всей затеи в том, чтобы поиск не стоял в критическом пути ответа:
 * искать надо по мере поступления чужой речи, а не после нажатия хоткея.
 */

export interface KbHit {
  uid: string
  question: string
  topic: string
  level: string
  priority: string
  short: string
  spoken: string
  anchors: string
  code: string
  followups: string
  ifDontKnow: string
  /** 1 у лучшего хита, дальше по убыванию — нормировано внутри запроса */
  score: number
  /**
   * Доля значимых слов запроса, реально найденных в записи, 0..1.
   *
   * Без неё уверенность посчитать нельзя: score нормирован к лучшему хиту,
   * поэтому у мусорного совпадения он тоже равен единице. На вопрос «а погода
   * сегодня какая» верхний хит получал score 1.00 — и только покрытие
   * показывает, что не совпало вообще ничего.
   */
  coverage: number
}

/**
 * Веса полей. Вопрос и «как это звучит у человека» важнее тела ответа.
 * Мутабельно намеренно: подбирается замером на проверочном наборе.
 */
export const WEIGHTS: Record<string, number> = {
  question: 10,
  // Поисковые формулировки (симптомы, жаргон, ключевые слова) весят БОЛЬШЕ
  // самого вопроса. Так вышло по замеру: подъём с 9 до 14 поднял попадание
  // на симптомных запросах с 32% до 47% top-1. Дальше (16, 20) портит и их
  // тоже — вопрос начинает тонуть.
  search: 14,
  // Синонимы на стороне документа: помогают терминологическим запросам,
  // мешают симптомным. При весе 2 польза остаётся, шум уже нет.
  syn: 2,
  anchors: 3,
  short: 2,
  spoken: 1,
}

const K1 = 1.2
const B = 0.75

const STOP = new Set(
  ('что такое как для чего зачем почему это в на и с по из от до или же ли бы мы вы ты я он она они ' +
    'если когда где куда чем чему а но да нет не ни то так вот ну о об при над под без у к со во есть')
    .split(' '),
)

const SUFFIXES = [
  'ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ах', 'ях', 'ов', 'ев',
  'ий', 'ый', 'ая', 'ое', 'ые', 'ие', 'ам', 'ям', 'ом', 'ем', 'ку', 'ки', 'ка',
  'у', 'ы', 'и', 'а', 'е', 'о', 'я', 'ь',
]

function stem(w: string): string {
  for (const s of SUFFIXES) {
    if (w.length > 5 && w.endsWith(s)) return w.slice(0, -s.length)
  }
  return w
}

export function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
}

interface FieldIndex {
  /** term -> (docIndex -> частота) */
  postings: Map<string, Map<number, number>>
  lengths: number[]
  avgLen: number
}

interface Doc {
  uid: string
  raw: Record<string, string>
  fields: Record<string, string>
}

export class KbIndex {
  private docs: Doc[] = []
  private fields = new Map<string, FieldIndex>()

  get size(): number {
    return this.docs.length
  }

  build(docs: Doc[]): void {
    this.docs = docs
    this.fields.clear()

    for (const field of Object.keys(WEIGHTS)) {
      const postings = new Map<string, Map<number, number>>()
      const lengths: number[] = []
      docs.forEach((doc, i) => {
        const toks = tokenize(doc.fields[field] ?? '')
        lengths[i] = toks.length
        for (const t of toks) {
          let bucket = postings.get(t)
          if (!bucket) postings.set(t, (bucket = new Map()))
          bucket.set(i, (bucket.get(i) ?? 0) + 1)
        }
      })
      const total = lengths.reduce((a, b) => a + b, 0)
      this.fields.set(field, { postings, lengths, avgLen: total / Math.max(1, lengths.length) })
    }
  }

  search(query: string, top = 3): KbHit[] {
    if (!this.docs.length) return []

    const base = tokenize(query)
    if (!base.length) return []
    // Синонимы весят вполовину: они уточняют, но не должны перебивать
    // слова, которые человек произнёс на самом деле.
    const extra = tokenize(expandTerms(query)).filter((t) => !base.includes(t))
    const terms: Array<[string, number]> = [
      ...base.map((t) => [t, 1] as [string, number]),
      ...extra.map((t) => [t, 0.5] as [string, number]),
    ]

    const N = this.docs.length
    const scores = new Float64Array(N)
    // Какие слова запроса нашлись в документе — считаем только по исходным
    // словам, синонимы покрытием не считаются.
    const matched: Array<Set<string>> = Array.from({ length: N }, () => new Set())

    for (const [field, weight] of Object.entries(WEIGHTS)) {
      const idx = this.fields.get(field)
      if (!idx) continue
      for (const [term, termWeight] of terms) {
        const bucket = idx.postings.get(term)
        if (!bucket) continue
        const df = bucket.size
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        for (const [doc, tf] of bucket) {
          const len = idx.lengths[doc] ?? 0
          const norm = 1 - B + (B * len) / (idx.avgLen || 1)
          scores[doc] = (scores[doc] ?? 0) + weight * termWeight * idf * ((tf * (K1 + 1)) / (tf + K1 * norm))
          if (termWeight === 1) matched[doc]?.add(term)
        }
      }
    }

    const order: number[] = []
    for (let i = 0; i < N; i++) if ((scores[i] ?? 0) > 0) order.push(i)
    order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))

    const first = order[0]
    const max = first === undefined ? 0 : (scores[first] ?? 0)
    return order.slice(0, top).flatMap<KbHit>((i) => {
      const doc = this.docs[i]
      if (!doc) return []
      const r = doc.raw
      return [{
        uid: doc.uid,
        question: r['title'] ?? '',
        topic: r['Тема'] ?? '',
        level: r['Уровень'] ?? '',
        priority: r['Приоритет'] ?? '',
        short: r['Кратко'] ?? '',
        spoken: r['Ответ вслух'] ?? '',
        anchors: r['Опорные пункты'] ?? '',
        code: r['Код'] ?? '',
        followups: r['Копнут дальше'] ?? '',
        ifDontKnow: r['Если не знаешь'] ?? '',
        // Нормируем к лучшему хиту: абсолютный BM25 несопоставим между запросами.
        score: max > 0 ? (scores[i] ?? 0) / max : 0,
        coverage: base.length ? (matched[i]?.size ?? 0) / base.length : 0,
      }]
    })
  }
}

/** Прочитать снимок и построить индекс. */
export async function loadIndex(filePath: string): Promise<KbIndex> {
  const text = await readFile(filePath, 'utf8')
  const docs: Doc[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, string>
    try {
      row = JSON.parse(line) as Record<string, string>
    } catch {
      continue // одна битая строка не должна ронять весь индекс
    }
    const uid = row['UID'] ?? row['externalKey'] ?? ''
    if (!uid) continue
    docs.push({
      uid,
      raw: row,
      fields: {
        question: row['title'] ?? '',
        search: row['Поисковые формулировки'] ?? '',
        // Раскрываем синонимы и на стороне документа: запись про регистр
        // сведений должна находиться по «рс», даже если сокращения нет в тексте.
        // По вопросу и опорным пунктам, а не по всему телу: иначе синонимов
        // столько, что они перестают что-либо различать.
        syn: expandTerms(`${row['title'] ?? ''} ${row['Опорные пункты'] ?? ''}`),
        anchors: row['Опорные пункты'] ?? '',
        short: row['Кратко'] ?? '',
        spoken: row['Ответ вслух'] ?? '',
      },
    })
  }
  const idx = new KbIndex()
  idx.build(docs)
  return idx
}

/**
 * Достаточно ли уверенно совпадение, чтобы показать ответ из базы без модели.
 *
 * Разрыв между первым и вторым хитом надёжнее абсолютного score: он говорит,
 * что вопрос опознан однозначно, а не «что-то похожее нашлось».
 */
/**
 * Пороги уверенности. Подобраны замером на 120 запросах плюс проверка на
 * посторонних репликах («а погода сегодня какая в москве»).
 *
 * Покрытие ниже 0.6 пропускает мусор: на постороннем вопросе гейт срабатывал.
 * От 0.6 мусор отсекается полностью.
 * Разрыв 0.95 против 0.80 — срабатывает вдвое чаще (49% вопросов против 22%)
 * ценой четырёх пунктов точности (73% против 77%). Взято 0.95: подсказка
 * показывается в холостом состоянии, хоткей никуда не девается, и неверная
 * подсказка стоит дешевле, чем её отсутствие.
 */
export const CONFIDENCE = { coverage: 0.6, gap: 0.95 }

/**
 * Достаточно ли уверенно совпадение, чтобы показать ответ из базы без модели.
 *
 * Два условия. Покрытие отвечает на «вообще про это ли запись» — без него
 * мусорное совпадение неотличимо от точного, потому что score нормирован.
 * Разрыв со вторым хитом отвечает на «однозначно ли опознан вопрос»: если
 * рядом стоит почти такая же запись, показывать одну из них наугад нельзя.
 */
export function isConfident(hits: KbHit[]): boolean {
  const best = hits[0]
  if (!best || !best.short.trim()) return false // нечего показывать без модели
  if (best.coverage < CONFIDENCE.coverage) return false
  const second = hits[1]
  return !second || second.score < CONFIDENCE.gap
}

/** Найденное для промпта модели. Без `Ответ вслух` — он длинный и её только сковывает. */
export function hitsToPrompt(hits: KbHit[]): string {
  if (!hits.length) return ''
  const blocks = hits.map((h, i) => {
    const parts = [`[${i + 1}] ${h.question}`]
    if (h.short) parts.push(`Суть: ${h.short}`)
    if (h.anchors) parts.push(`Опорные пункты: ${h.anchors}`)
    if (h.code) parts.push(`Код: ${h.code}`)
    return parts.join('\n')
  })
  return `Из личной базы знаний (используй, если подходит по смыслу; если нет — отвечай сам, про базу не упоминай):\n\n${blocks.join('\n\n')}`
}
