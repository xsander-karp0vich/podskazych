/**
 * Команды из своего промпта: «/разбор», «/итог» и подобные.
 *
 * Промпт сам объясняет модели, что делать по команде («если интервьюер пишет /разбор —
 * выйди из роли и разбери ответы»). Приложению остаётся только найти эти слова и
 * показать их кнопками в строке запроса: нажатие отправляет команду, как если бы её
 * набрали руками. Никакого реестра команд нет — что написано в промпте, то и кнопка.
 */

export interface PromptCommand {
  /** «/разбор» — ровно так уходит модели */
  command: string
  /** фраза промпта, где команда описана, — подсказка по наведению */
  hint: string
}

/** Имя команды: буква или цифра, дальше буквы, цифры, «_» и «-»; до 30 знаков. */
const NAME = '[\\p{L}\\p{N}][\\p{L}\\p{N}_-]{0,29}'

/**
 * Где кончается имя: дальше не буква и не «/» (иначе это путь /usr/bin), и не точка,
 * двоеточие или «;» перед буквой (иначе это файл /config.json, версия /v1.2 или tl;dr).
 */
const NAME_END = '(?![\\p{L}\\p{N}_/-]|[.:;][\\p{L}\\p{N}])'

/**
 * Слеш — в начале строки или после пробела, кавычки, скобки, обратной кавычки; между ними
 * и слешем допустимы маркеры выделения markdown — звёздочки и подчёркивания жирной или
 * курсивной команды. «и/или», «км/ч», дроби и «//» комментариев так не проходят.
 */
const COMMAND = new RegExp(`(^|[\\s«"'“„\`(\\[{])[*_]{0,3}\\/(${NAME})${NAME_END}`, 'gu')

/** Строка-ограничитель блока кода: ``` или ~~~ в начале строки. Код в промпте — пример, а не инструкция. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/

const HINT_MAX = 180

/** Фраза, где описана команда: без разметки списка, заголовка и выделения, не длиннее HINT_MAX. */
function hintFor(line: string, command: string): string {
  const text = line
    .replace(/^[\s>#*\-•]+|^\s*\d+[.)]\s+/g, '')
    .replace(/[*_]{1,3}(?=\/)|(?<=\/[\p{L}\p{N}_-]+)[*_]{1,3}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  // В абзаце бывает несколько фраз — подсказке нужна та, где именно эта команда, а не /разбор для /раз.
  const own = new RegExp(`${command}${NAME_END}`, 'u')
  const phrase = text.split(/(?<=[.!?…])\s+/).find((p) => own.test(p)) ?? text
  return phrase.length > HINT_MAX ? `${phrase.slice(0, HINT_MAX - 1).trimEnd()}…` : phrase
}

/** Команды из промпта по порядку первого упоминания, без повторов (регистр не важен). */
export function promptCommands(prompt: string): PromptCommand[] {
  if (!prompt.includes('/')) return []
  const seen = new Set<string>()
  const out: PromptCommand[] = []
  let fence = ''
  for (const line of prompt.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(line)
    if (fence) {
      // Блок закрывает тот же знак не короче открывшего и без хвоста после.
      if (f?.[1] && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]?.trim()) fence = ''
      continue
    }
    if (f?.[1]) {
      fence = f[1]
      continue
    }
    for (const m of line.matchAll(COMMAND)) {
      // Закрывающий маркер «_/итог_» имя захватывает — отрезаем.
      const command = `/${(m[2] ?? '').replace(/[_-]+$/, '')}`
      const key = command.toLocaleLowerCase('ru-RU')
      if (command === '/' || seen.has(key)) continue
      seen.add(key)
      out.push({ command, hint: hintFor(line, command) })
    }
  }
  return out
}

/** Вопрос — команда из промпта: «/разбор», «/разбор?», «/разбор только по запросам». */
export function isPromptCommand(question: string): boolean {
  return new RegExp(`^\\/${NAME}${NAME_END}`, 'u').test(question.trim())
}
