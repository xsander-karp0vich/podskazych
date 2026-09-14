/**
 * Подсветка кода в ответе — как в IDE, но в цветах панели: ключевые слова
 * голубые и жирные, параметры, числа и строки янтарные, комментарии и
 * знаки приглушённые, остальное — основной текст. Цвета взяты из макета
 * «Снимок — задача live coding» и одинаковы для всех языков: панель читают
 * вскользь, и привычная раскраска важнее точной грамматики.
 *
 * Разбор построчный и без зависимостей: подсветить нужно пару десятков строк,
 * а тянуть библиотеку ради этого — лишний мегабайт в окне поверх созвона.
 */

export type TokKind = 'kw' | 'str' | 'num' | 'param' | 'com' | 'punct' | 'text'
export interface Tok {
  t: string
  k: TokKind
}

export type Lang = '1c' | 'sql' | 'js' | 'py' | 'plain'

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

/** Язык запросов и встроенный язык 1С вместе: в ответах они идут вперемешку, регистр не важен. */
const KW_1C = words(`
  ВЫБРАТЬ РАЗЛИЧНЫЕ РАЗРЕШЕННЫЕ ПЕРВЫЕ КАК ИЗ ЛЕВОЕ ПРАВОЕ ПОЛНОЕ ВНУТРЕННЕЕ ВНЕШНЕЕ СОЕДИНЕНИЕ ПО ГДЕ И ИЛИ НЕ
  СГРУППИРОВАТЬ УПОРЯДОЧИТЬ ИТОГИ ИМЕЮЩИЕ ЕСТЬNULL ЕСТЬ ВЫБОР КОГДА ТОГДА ИНАЧЕ КОНЕЦ СУММА КОЛИЧЕСТВО МАКСИМУМ МИНИМУМ
  СРЕДНЕЕ ПОМЕСТИТЬ ОБЪЕДИНИТЬ ВСЕ УБЫВ ВОЗР NULL ИСТИНА ЛОЖЬ ЗНАЧЕНИЕ ТИП ССЫЛКА В ИЕРАРХИИ МЕЖДУ ПОДОБНО ВЫРАЗИТЬ
  ЧИСЛО СТРОКА ДАТА ДАТАВРЕМЯ КОНЕЦПЕРИОДА НАЧАЛОПЕРИОДА ДОБАВИТЬКДАТЕ РАЗНОСТЬДАТ СЕКУНДА МИНУТА ЧАС ДЕНЬ НЕДЕЛЯ МЕСЯЦ
  КВАРТАЛ ГОД ОБЩИЕ АВТОУПОРЯДОЧИВАНИЕ ИНДЕКСИРОВАТЬ УНИЧТОЖИТЬ ДЛЯ ИЗМЕНЕНИЯ ПРЕДСТАВЛЕНИЕ ПОДСТРОКА
  ЕСЛИ ИНАЧЕЕСЛИ КОНЕЦЕСЛИ КАЖДОГО ЦИКЛ КОНЕЦЦИКЛА ПОКА ПРОЦЕДУРА КОНЕЦПРОЦЕДУРЫ ФУНКЦИЯ КОНЕЦФУНКЦИИ
  ВОЗВРАТ ПЕРЕМ ЭКСПОРТ ЗНАЧ НОВЫЙ ПОПЫТКА ИСКЛЮЧЕНИЕ КОНЕЦПОПЫТКИ ВЫЗВАТЬИСКЛЮЧЕНИЕ ПРОДОЛЖИТЬ ПРЕРВАТЬ
  НЕОПРЕДЕЛЕНО ПЕРЕЙТИ ДОБАВИТЬОБРАБОТЧИК УДАЛИТЬОБРАБОТЧИК АСИНХ ЖДАТЬ
  SELECT DISTINCT ALLOWED TOP AS FROM LEFT RIGHT FULL INNER OUTER JOIN ON WHERE AND OR NOT GROUP BY ORDER TOTALS
  HAVING ISNULL CASE WHEN THEN ELSE END SUM COUNT MAX MIN AVG INTO UNION ALL DESC ASC TRUE FALSE IN BETWEEN LIKE
  IF ELSIF ENDIF FOR EACH DO ENDDO WHILE PROCEDURE ENDPROCEDURE FUNCTION ENDFUNCTION RETURN VAR EXPORT VAL NEW TRY
  EXCEPT ENDTRY RAISE CONTINUE BREAK UNDEFINED
`)

const KW_SQL = words(`
  SELECT DISTINCT TOP AS FROM LEFT RIGHT FULL INNER OUTER CROSS JOIN ON WHERE AND OR NOT GROUP BY ORDER HAVING CASE
  WHEN THEN ELSE END SUM COUNT MAX MIN AVG INTO UNION ALL DESC ASC NULL IS IN EXISTS BETWEEN LIKE LIMIT OFFSET
  INSERT VALUES UPDATE SET DELETE CREATE ALTER DROP TABLE INDEX VIEW PRIMARY KEY FOREIGN REFERENCES WITH OVER
  PARTITION ROW_NUMBER RANK COALESCE CAST TRUE FALSE BEGIN COMMIT ROLLBACK
`)

const KW_JS = words(`
  const let var function return if else for while do switch case break continue new class extends import export from
  default async await try catch finally throw typeof instanceof in of null undefined true false this super interface
  type enum implements public private protected readonly static void yield delete
`)

const KW_PY = words(`
  def return if elif else for while in not and or is None True False class import from as with try except finally
  raise lambda yield pass break continue global nonlocal async await print self
`)

const QUERY_HINT = /(^|\s)(ВЫБРАТЬ|ПОМЕСТИТЬ|УПОРЯДОЧИТЬ|СГРУППИРОВАТЬ)(\s|$)/iu

const is1c = (sample: string) =>
  /[а-яё]/iu.test(sample) &&
  (QUERY_HINT.test(sample) || /(КонецЕсли|КонецПроцедуры|КонецФункции|КонецЦикла|&НаСервере|&НаКлиенте)/iu.test(sample))

/** Язык по подписи блока, а без неё — по содержимому. */
export function detectLang(label: string, sample: string): Lang {
  const l = label.trim().toLowerCase()
  if (/^(1[cс]|bsl|sdbl|onec|1c-?query|запрос)/u.test(l)) return '1c'
  // Запрос 1С модель нередко подписывает как sql: кириллица с ключевыми словами 1С важнее подписи.
  if ((!l || l === 'sql' || l === 'text' || l === 'plain') && is1c(sample)) return '1c'
  if (/^(sql|tsql|t-sql|mssql|postgres|postgresql|pgsql|mysql|sqlite|plsql)$/.test(l)) return 'sql'
  if (/^(js|jsx|ts|tsx|javascript|typescript|node)$/.test(l)) return 'js'
  if (/^(py|python|python3)$/.test(l)) return 'py'
  if (l) return 'plain'
  if (/\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(FROM|INTO|SET)\b/i.test(sample)) return 'sql'
  if (/^\s*(def |from \w+ import |import \w+$)/m.test(sample)) return 'py'
  if (/\b(const|let|function|=>|console\.)/.test(sample)) return 'js'
  return 'plain'
}

/** Подпись блока: язык по-человечески. */
export function langLabel(label: string, lines: string[]): string {
  const sample = lines.join('\n')
  const lang = detectLang(label, sample)
  if (lang === '1c') return QUERY_HINT.test(sample) ? '1С · запрос' : '1С'
  if (lang === 'sql') return 'SQL'
  if (lang === 'py') return 'Python'
  if (lang === 'js') return /^(ts|tsx|typescript)$/i.test(label.trim()) ? 'TypeScript' : 'JavaScript'
  return label.trim()
}

const PROFILES: Record<Lang, { line: RegExp | null; block: boolean; kw: Set<string>; upper: boolean; param: boolean; quotes: string }> = {
  '1c': { line: /\/\/.*$/y, block: false, kw: KW_1C, upper: true, param: true, quotes: '"' },
  sql: { line: /--.*$/y, block: true, kw: KW_SQL, upper: true, param: true, quotes: `'"` },
  js: { line: /\/\/.*$/y, block: true, kw: KW_JS, upper: false, param: false, quotes: `'"\`` },
  py: { line: /#.*$/y, block: false, kw: KW_PY, upper: false, param: false, quotes: `'"` },
  plain: { line: null, block: false, kw: new Set(), upper: false, param: false, quotes: `'"` },
}

/** Состояние между строками: многострочный комментарий /* … *\/. */
export interface TokState {
  inBlock: boolean
}

export function tokenize(line: string, lang: Lang, state: TokState = { inBlock: false }): Tok[] {
  const p = PROFILES[lang]
  const out: Tok[] = []
  const push = (t: string, k: TokKind) => {
    const last = out[out.length - 1]
    // Соседние куски одного вида — одним span: меньше узлов на строку.
    if (last && last.k === k && k !== 'kw') last.t += t
    else out.push({ t, k })
  }
  let i = 0
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf('*/', i)
      if (end < 0) {
        push(line.slice(i), 'com')
        return out
      }
      push(line.slice(i, end + 2), 'com')
      i = end + 2
      state.inBlock = false
      continue
    }
    const rest = line.slice(i)
    if (p.line) {
      p.line.lastIndex = i
      const m = p.line.exec(line)
      if (m) {
        push(m[0], 'com')
        break
      }
    }
    if (p.block && rest.startsWith('/*')) {
      state.inBlock = true
      push('/*', 'com')
      i += 2
      continue
    }
    const ch = line[i]!
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest)!
      push(m[0], 'text')
      i += m[0].length
      continue
    }
    if (p.quotes.includes(ch)) {
      // В 1С кавычка внутри строки удваивается: "", — строка на этом не кончается.
      let j = i + 1
      while (j < line.length) {
        if (line[j] === ch) {
          if (lang === '1c' && line[j + 1] === ch) {
            j += 2
            continue
          }
          j++
          break
        }
        if (line[j] === '\\' && lang !== '1c') j++
        j++
      }
      push(line.slice(i, j), 'str')
      i = j
      continue
    }
    if (p.param && (ch === '&' || (lang === 'sql' && ch === '@'))) {
      const m = /^[&@:][\p{L}\d_]+/u.exec(rest)
      if (m) {
        push(m[0], 'param')
        i += m[0].length
        continue
      }
    }
    // Инструкции препроцессора 1С: #Если, #Область.
    if (lang === '1c' && ch === '#') {
      const m = /^#[\p{L}]+/u.exec(rest)
      if (m) {
        push(m[0], 'kw')
        i += m[0].length
        continue
      }
    }
    const num = /^\d+(?:\.\d+)?/.exec(rest)
    if (num) {
      push(num[0], 'num')
      i += num[0].length
      continue
    }
    const word = /^[\p{L}_$][\p{L}\d_$]*/u.exec(rest)
    if (word) {
      const w = word[0]
      push(w, p.kw.has(p.upper ? w.toUpperCase() : w) ? 'kw' : 'text')
      i += w.length
      continue
    }
    push(ch, 'punct')
    i++
  }
  return out
}

/** Все строки блока с общим состоянием: комментарий может начаться строкой выше. */
export function tokenizeLines(lines: string[], lang: Lang): Tok[][] {
  const state: TokState = { inBlock: false }
  return lines.map((l) => tokenize(l, lang, state))
}
