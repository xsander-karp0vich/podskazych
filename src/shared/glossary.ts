/**
 * Словарь распознавания речи, собранный из базы вопросов.
 *
 * Зачем по темам, а не одним списком. В подсказку распознавателю влезает 222
 * токена, а частые термины базы вместе стоят около тысячи. При этом термины
 * одной темы помещаются почти всегда (20 тем из 22). И это не просто экономия:
 * на замере общий словарь не помог вообще — 2 из 13 технических терминов, как
 * и без словаря, — а словарь с нужными терминами дал 6 из 13. Подсказка
 * работает, только если в ней те слова, которые сейчас звучат.
 *
 * Модуль чистый — без Electron и Node, — потому что он нужен и главному
 * процессу (строит словарь из снимка базы), и окну (собирает подсказку под
 * текущую тему), а ещё его можно прогнать на настоящей базе прямо через Node.
 */

export interface TopicGlossary {
  /**
   * Термины, которые встречаются почти во всех темах, — уходят в каждую
   * подсказку. Латиница плюс три кириллических якоря (см. buildGlossary).
   */
  base: string[]
  /** Термины темы: сначала латиница, внутри — по убыванию частоты; без тех, что в base. */
  topics: Record<string, string[]>
  /** Сколько вопросов в теме — для подписи в интерфейсе. */
  sizes: Record<string, number>
}

type Row = Record<string, unknown>

/** Порог «встречается в стольких темах» для постоянной части. */
const BASE_MIN_TOPICS = 8
const BASE_MAX = 10
/** Кириллических якорей в постоянной части: не дают подсказке утянуть речь в английский. */
const BASE_CYR = 3
/** Термин темы должен встретиться хотя бы в двух её вопросах — иначе это случайность. */
const TOPIC_MIN_DF = 2
/** Больше всё равно не влезет в бюджет; сайдкар дорежет точно. */
const TOPIC_MAX = 60

/**
 * Служебные поля. Первый прогон извлечения набрал оттуда мусора: should,
 * middle и senior — это значения «Приоритета» и «Уровня», perf и subd — «Темы».
 * Код тоже не берём: там идентификаторы, а не то, что говорят вслух.
 */
const SKIP_FIELDS = new Set(['Код', 'Уровень', 'Приоритет', 'Тема', 'UID', 'externalKey'])

/**
 * Ключевые слова языка запросов. В ответах их пишут капсом прямо в тексте
 * («ЛЕВОЕ СОЕДИНЕНИЕ … ГДЕ»), и без этого списка они выглядят как сокращения.
 */
const QUERY_WORDS = new Set(
  `ВЫБРАТЬ ГДЕ ИЗ КАК ЛЕВОЕ ПРАВОЕ ПОЛНОЕ ВНУТРЕННЕЕ СОЕДИНЕНИЕ ВСЕ ВСЕМ ИЛИ НЕ ЕСТЬ СУММА
   ПЕРВЫЕ ВЫБОР КОГДА ТОГДА ИНАЧЕ КОНЕЦ ИТОГИ ПО ДО ДЕНЬ РАЗЛИЧНЫЕ СГРУППИРОВАТЬ
   УПОРЯДОЧИТЬ УБЫВ ВОЗР МЕЖДУ ПОДОБНО ОБЪЕДИНИТЬ ПОМЕСТИТЬ ИНДЕКСИРОВАТЬ ДЛЯ ИЗМЕНЕНИЯ
   МАКСИМУМ МИНИМУМ КОЛИЧЕСТВО СРЕДНЕЕ ВЫРАЗИТЬ ССЫЛКА ИЕРАРХИИ ЗНАЧЕНИЕ ТИП ДАТАВРЕМЯ
   ГОД МЕСЯЦ КВАРТАЛ НЕДЕЛЯ ЧАС МИНУТА СЕКУНДА ПЕРИОД РАЗРЕШЕННЫЕ АВТОУПОРЯДОЧИВАНИЕ
   УНИЧТОЖИТЬ ИСТИНА ЛОЖЬ СТРОКА ЧИСЛО ДАТА БУЛЕВО ЦЕЛ ОБЩИЕ ОНЛАЙН ВНЕ`.split(/\s+/),
)

/**
 * Латинские термины, записанные кириллицей (ХТТП, ЕРП). В подсказке они
 * тянули бы распознавание к кириллице — ровно против того, зачем словарь нужен.
 */
const CYR_STOP = new Set(['ХТТП', 'ЕРП'])

/** Английские слова из текста ответов, которые проходят по форме, но терминами не являются. */
const LATIN_STOP = new Set(
  `vs etc ok id the and of to in a is it on for or by as at be an if no not
   ms hr pr ui ux`.split(/\s+/),
)

/**
 * Служебные слова SQL. Их пишут капсом в объяснениях, и по форме они похожи на
 * аббревиатуры, но отдельным термином вслух не звучат — только занимают бюджет.
 * События техжурнала (CALL, EXCP, TLOCK) и уровни изоляции (SERIALIZABLE,
 * SNAPSHOT) сюда не входят: их говорят.
 */
const SQL_STOP = new Set(
  `select from where with table sum row number over include convert implicit allow
   isolation index statistics update read partition join isnull top set into values
   case when then else end group order having distinct`.split(/\s+/),
)

/**
 * Внутренние имена полей и таблиц из разборов: их пишут, но не произносят.
 * Команды конфигуратора вроде LoadConfigFromFiles сюда не входят — на созвонах
 * они звучат, и без подсказки распознаватель их не выдаст никогда.
 */
const IDENT_STOP = new Set(
  `accumrgt accumrgtn rowcounts memorypeak waitconnections dataseparationhash
   additionalinfo adodb.connection excel.application ix rid f7`.split(/\s+/),
)

/** Термины, которые пишутся строчными, но говорятся вслух как названия. */
const LOWER_ALLOW = new Set([
  'rphost', 'rmngr', 'ragent', 'ras', 'rac', 'tempdb', 'cf', 'cfu', 'cfe', 'dt', 'epf', 'erf', 'ibcmd',
])

/** Названия продуктов, которые пишутся с одной заглавной. */
const TITLE_ALLOW = new Set([
  'Git', 'Vanessa', 'Automation', 'Postman', 'Jenkins', 'Apache', 'Kafka', 'Docker', 'Jira',
  'Redis', 'Linux', 'Nginx', 'Grafana', 'Zabbix', 'Allure', 'Selenium', 'Python', 'Java',
])

const LATIN = /(?<![A-Za-zА-Яа-яЁё0-9])[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*(?![A-Za-zА-Яа-яЁё0-9])/g
const ABBR = /(?<![A-Za-zА-Яа-яЁё0-9])[А-ЯЁ]{2,6}\d{0,2}(?![A-Za-zА-Яа-яЁё0-9])/g

/**
 * Латинское слово — термин? Правило из разбора базы: аббревиатуры и смешанный
 * регистр (TLOCK, EnterpriseData, YAxUnit), слова с цифрой, точкой или дефисом
 * (UTF8, logcfg.xml, round-trip) — да. Обычные английские слова строчными
 * (work, shared, code) и с одной заглавной (Server, Context) — нет, кроме
 * известных названий из списков выше.
 */
function isLatinTerm(w: string): boolean {
  if (w.length < 2) return false
  const low = w.toLowerCase()
  if (LATIN_STOP.has(low) || SQL_STOP.has(low) || IDENT_STOP.has(low)) return false
  if (/^U\d{3,}$/.test(w) || /^std\d+$/i.test(w) || /^sys\./i.test(w) || /\.exe$/i.test(w)) return false
  if (LOWER_ALLOW.has(low) || TITLE_ALLOW.has(w)) return true
  const upper = w.match(/[A-Z]/g)?.length ?? 0
  return upper >= 2 || /[\d.-]/.test(w)
}

/**
 * Кириллическое сокращение — термин? Двухбуквенные не берём. Пользы от них
 * мало: кириллические сокращения распознаются и без подсказки. А риск есть:
 * «НУ» — это налоговый учёт, но «ну» — самое частое слово-паразит, и
 * подсказка могла бы начать превращать одно в другое. С цифрой (КД2) — берём.
 */
function isCyrTerm(w: string): boolean {
  if (QUERY_WORDS.has(w) || CYR_STOP.has(w)) return false
  return w.length >= 3 || /\d/.test(w)
}

const isLatinKey = (key: string) => /^[a-z]/.test(key)

export function buildGlossary(rows: Row[]): TopicGlossary {
  /** в скольких вопросах всей базы */
  const df = new Map<string, number>()
  /** как термин пишут чаще всего: RLS, а не rls */
  const forms = new Map<string, Map<string, number>>()
  /** тема -> термин -> в скольких вопросах темы */
  const perTopic = new Map<string, Map<string, number>>()
  const sizes: Record<string, number> = {}

  for (const row of rows) {
    const topic = typeof row['Тема'] === 'string' ? row['Тема'].trim() : ''
    if (!topic) continue
    sizes[topic] = (sizes[topic] ?? 0) + 1

    const text = Object.entries(row)
      .filter(([k, v]) => !SKIP_FIELDS.has(k) && typeof v === 'string')
      .map(([, v]) => v as string)
      .join(' ')

    const seen = new Set<string>()
    const note = (w: string) => {
      const key = w.toLowerCase()
      let f = forms.get(key)
      if (!f) forms.set(key, (f = new Map()))
      f.set(w, (f.get(w) ?? 0) + 1)
      seen.add(key)
    }
    for (const m of text.matchAll(LATIN)) if (isLatinTerm(m[0])) note(m[0])
    for (const m of text.matchAll(ABBR)) if (isCyrTerm(m[0])) note(m[0])

    let bucket = perTopic.get(topic)
    if (!bucket) perTopic.set(topic, (bucket = new Map()))
    for (const key of seen) {
      df.set(key, (df.get(key) ?? 0) + 1)
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
  }

  const show = (key: string): string => {
    let best = key
    let n = -1
    for (const [w, c] of forms.get(key) ?? []) if (c > n) [best, n] = [w, c]
    return best
  }

  // Постоянная часть — в основном латиница: кириллические сокращения вроде СКД
  // распознаются и без подсказки, а на замере ломалось латинское.
  //
  // Но совсем без кириллицы нельзя. Подсказка из одних латинских слов тянула
  // русскую речь в английский: «Менеджер кластера» стало «Manager Cluster»,
  // «БСП» — «BSP». Три самых распространённых кириллических термина это гасят:
  // было 2 фразы из 21 с лишним английским, стало 0, попадание терминов то же.
  const spread = new Map<string, number>()
  for (const bucket of perTopic.values()) for (const key of bucket.keys()) spread.set(key, (spread.get(key) ?? 0) + 1)
  const widest = (latin: boolean, max: number) =>
    [...spread]
      .filter(([key, n]) => n >= BASE_MIN_TOPICS && isLatinKey(key) === latin)
      .sort((a, b) => b[1] - a[1] || (df.get(b[0]) ?? 0) - (df.get(a[0]) ?? 0))
      .slice(0, max)
      .map(([key]) => key)
  const baseKeys = [...widest(true, BASE_MAX), ...widest(false, BASE_CYR)]
  const inBase = new Set(baseKeys)

  // Внутри темы латиница идёт первой. Сайдкар режет список с хвоста, а
  // помогает подсказка именно латинице — значит, отрезаться должна кириллица.
  const topics: Record<string, string[]> = {}
  for (const [topic, bucket] of perTopic) {
    topics[topic] = [...bucket]
      .filter(([key, n]) => n >= TOPIC_MIN_DF && !inBase.has(key))
      .sort(
        (a, b) =>
          Number(isLatinKey(b[0])) - Number(isLatinKey(a[0])) ||
          b[1] - a[1] ||
          (df.get(b[0]) ?? 0) - (df.get(a[0]) ?? 0) ||
          a[0].localeCompare(b[0]),
      )
      .slice(0, TOPIC_MAX)
      .map(([key]) => show(key))
  }

  return { base: baseKeys.map(show), topics, sizes }
}

/**
 * Список терминов для распознавателя по приоритету. Порядок важен: сайдкар
 * режет по бюджету с хвоста, поэтому первыми идут имена пользователя — их нет
 * ни в какой базе, и терять их нельзя, — потом постоянная часть, потом тема.
 */
export function composeTerms(
  glossary: TopicGlossary | null,
  topic: string | null,
  names: string[],
  exclude: string[],
): string[] {
  const banned = new Set(exclude.map((w) => w.trim().toLowerCase()).filter(Boolean))
  const seen = new Set<string>()
  const out: string[] = []
  const push = (w: string) => {
    const t = w.trim()
    const key = t.toLowerCase()
    if (!t || banned.has(key) || seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  names.forEach(push)
  glossary?.base.forEach(push)
  if (topic) glossary?.topics[topic]?.forEach(push)
  return out
}

/** Строки из многострочного поля: по одной на строку, пустые не считаются. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Темы в базе заведены английскими метками — в интерфейсе показываем по-русски. */
const TOPIC_LABELS: Record<string, string> = {
  soft: 'Софт-скиллы',
  perf: 'Производительность',
  subd: 'СУБД',
  queries: 'Запросы',
  registers: 'Регистры',
  tasks: 'Практические задачи',
  arch: 'Архитектура',
  exchange: 'Обмен данными',
  configs: 'Типовые конфигурации',
  extensions: 'Расширения',
  meta: 'Метаданные',
  domain: 'Предметная область',
  forms: 'Формы',
  admin: 'Администрирование',
  skd: 'СКД',
  other: 'Разное',
  devops: 'DevOps',
  testing: 'Тестирование',
  clientserver: 'Клиент-сервер',
  rls: 'RLS',
  http: 'HTTP-сервисы',
  bsp: 'БСП',
}

export function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic
}
