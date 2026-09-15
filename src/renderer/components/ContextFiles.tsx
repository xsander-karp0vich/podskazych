import { useEffect, useRef, useState, type DragEvent } from 'react'
import {
  CONTEXT_MAX_FILES,
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_MAX_FILE_CHARS,
  contextPlan,
  type ContextFile,
  type ContextKind,
} from '@shared/contextFiles'
import type { ContextAddResult } from '../../preload'
import { Switch } from './Controls'

/**
 * Файлы для контекста во вкладке «Свой промпт»: резюме, описание проекта, вакансия.
 *
 * Список и флаги — в настройках (onEdit правит их от свежего списка), текст — в main.
 * Новых стилей здесь почти нет: карточка — как запись созвона, пометки — значки состояния,
 * пустой список — пустая карточка. Своя только рамка, пока над блоком несут файлы.
 */

const KIND_LABEL: Record<ContextKind, string> = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT', md: 'MD' }

/** 60000 -> «60 000»: подписи читают по-русски. */
const num = (n: number) => n.toLocaleString('ru-RU')

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return one
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few
  return many
}

// Неразрывный пробел: число не должно оставаться на одной строке, а слово — уезжать на другую.
const chars = (n: number) => `${num(n)} ${plural(n, 'символ', 'символа', 'символов')}`

const TOO_MANY = `Не больше ${CONTEXT_MAX_FILES} файлов — уберите ненужные и добавьте снова`

/** Не прочитавшийся файл: в настройки не попадает, висит строкой с причиной, пока её не уберут. */
interface Failure {
  key: number
  name: string
  error: string
}

let failureSeq = 0

/** Перетаскивают ли файлы, а не выделенный текст: подсвечивать блок под текстом незачем. */
const hasFiles = (e: DragEvent | globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

export function ContextFiles({
  files,
  onEdit,
}: {
  files: ContextFile[]
  onEdit: (edit: (files: ContextFile[]) => ContextFile[]) => void
}) {
  /** сколько добавлений ещё читается: брошенные во время чтения файлы ждут очереди, а не теряются */
  const [busy, setBusy] = useState(0)
  const [over, setOver] = useState(false)
  const [failures, setFailures] = useState<Failure[]>([])
  /** файлы, чей текст пропал с диска: обещать их в запросе нельзя */
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())

  // Добавления идут по одному: main знает только присланное число файлов, и два чтения разом
  // вдвоём перешагнули бы лимит. Список — из ref: ответ приходит позже, чем его отрисовали.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const filesRef = useRef(files)
  filesRef.current = files

  const ids = files.map((f) => f.id).join(',')
  useEffect(() => {
    if (!ids) return setMissing(new Set())
    let alive = true
    void window.copilot.missingContextFiles(ids.split(',')).then((m) => alive && setMissing(new Set(m)))
    return () => {
      alive = false
    }
  }, [ids])

  // Файл, брошенный мимо блока, Chromium открыл бы вместо панели — окно ушло бы на file://.
  // Пока открыт этот блок, промах просто ничего не делает.
  useEffect(() => {
    const block = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    document.addEventListener('dragover', block)
    document.addEventListener('drop', block)
    return () => {
      document.removeEventListener('dragover', block)
      document.removeEventListener('drop', block)
    }
  }, [])

  const apply = (res: ContextAddResult, extra: Array<{ name: string; error: string }> = []) => {
    // Место — по свежему списку, а не по числу, отправленному в main: сверх десяти в список не берём,
    // а текст лишнего сразу стираем с диска — иначе он лежал бы там без строки до следующего запуска.
    const room = Math.max(0, CONTEXT_MAX_FILES - filesRef.current.length)
    const added = res.added.slice(0, room)
    const extraFiles = res.added.slice(room)
    for (const f of extraFiles) void window.copilot.removeContextFile(f.id)
    if (added.length) {
      filesRef.current = [...filesRef.current, ...added]
      onEdit((prev) => [...prev, ...added].slice(0, CONTEXT_MAX_FILES))
    }
    const failed = [...extra, ...res.failed, ...extraFiles.map((f) => ({ name: f.name, error: TOO_MANY }))]
    if (failed.length) setFailures((prev) => [...prev, ...failed.map((f) => ({ ...f, key: ++failureSeq }))])
  }

  /** Поставить добавление в очередь. extra — отказы, известные ещё до чтения (размер). */
  const enqueue = (job: () => Promise<ContextAddResult>, extra: Array<{ name: string; error: string }> = []) => {
    setBusy((n) => n + 1)
    queue.current = queue.current.then(async () => {
      try {
        apply(await job(), extra)
      } catch (err) {
        apply({ added: [], failed: [{ name: 'Файлы', error: `Не прочитались: ${err instanceof Error ? err.message : String(err)}` }] }, extra)
      } finally {
        setBusy((n) => n - 1)
      }
    })
  }

  const pick = () => enqueue(() => window.copilot.pickContextFiles(filesRef.current.length))

  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setOver(false)
    const list = Array.from(e.dataTransfer.files)
    if (!list.length) return
    // Размер видно до чтения: 300 МБ в память окна ради отказа тянуть незачем.
    const big = list.filter((f) => f.size > CONTEXT_MAX_FILE_BYTES).map((f) => ({ name: f.name, error: 'Файл больше 20 МБ' }))
    const fit = list.filter((f) => f.size <= CONTEXT_MAX_FILE_BYTES)
    enqueue(async () => {
      if (!fit.length) return { added: [], failed: [] }
      // Сами File остаются читаемыми и после события — поэтому файлы можно дочитать в очереди.
      const payload = await Promise.all(fit.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))
      return window.copilot.addContextFiles(payload, filesRef.current.length)
    }, big)
  }

  const remove = (id: string) => {
    filesRef.current = filesRef.current.filter((f) => f.id !== id)
    onEdit((prev) => prev.filter((f) => f.id !== id))
    void window.copilot.removeContextFile(id)
  }

  const toggle = (id: string) => onEdit((prev) => prev.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f)))

  // Итог — той же функцией, по которой main режет текст: строка обещает ровно то, что уйдёт.
  const sendable = (f: ContextFile) => f.chars > 0 && !missing.has(f.id)
  const sent = files.filter((f) => f.enabled && sendable(f))
  const plan = contextPlan(sent.map((f) => f.chars))
  const takeOf = new Map(sent.map((f, i) => [f.id, plan.take[i] ?? 0]))
  const full = files.length >= CONTEXT_MAX_FILES

  const summary = !files.length
    ? `До ${CONTEXT_MAX_FILES} файлов PDF, DOCX, TXT или MD, каждый до 20 МБ`
    : (!plan.files
        ? 'Сейчас в запрос не уйдёт ни один файл'
        : `В запрос уйдёт ${chars(plan.chars)} из ${plan.files} ${plural(plan.files, 'файла', 'файлов', 'файлов')}` +
          (plan.partial ? ', последний — частично' : '') +
          ' · применится при следующем «Спросить»') + (full ? ` · больше ${CONTEXT_MAX_FILES} файлов не добавить` : '')

  return (
    <div
      className={`ctx-drop ${over ? 'over' : ''}`}
      onDragEnter={(e) => hasFiles(e) && setOver(true)}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(e) => {
        // Уход на дочернюю карточку — тоже dragleave: гасим, только когда курсор покинул весь блок.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={drop}
    >
      {files.length === 0 && failures.length === 0 ? (
        <div className="empty-card">
          {over ? 'Отпустите — файлы добавятся' : 'Перетащите файлы сюда или нажмите «Добавить файл»'}
        </div>
      ) : (
        <div className="records">
          {files.map((f) => {
            const take = takeOf.get(f.id) ?? 0
            const lost = missing.has(f.id)
            // Скан без текста и пропавший текст в запрос не уйдут при любом флаге: переключатель
            // выключен и недоступен, чтобы не спорить с итоговой строкой.
            const usable = sendable(f)
            const on = f.enabled && usable
            return (
              <article className={`record ctx-file ${on ? '' : 'off'}`} key={f.id}>
                <div className="ctx-main">
                  <div className="record-head">
                    <span className="record-when ctx-name">{f.name}</span>
                    <span className="record-sum">
                      {KIND_LABEL[f.kind]} · {chars(f.chars)}
                    </span>
                  </div>
                  {lost ? (
                    <span className="status-badge bad ctx-note">
                      <i />
                      Текст файла пропал с диска — удалите файл и добавьте заново
                    </span>
                  ) : f.chars === 0 ? (
                    <span className="status-badge warn ctx-note">
                      <i />
                      {f.kind === 'pdf' ? 'В PDF нет текстового слоя — похоже на скан' : 'В файле нет текста'}
                    </span>
                  ) : (
                    <>
                      {f.truncated && (
                        <span className="status-badge warn ctx-note">
                          <i />
                          Текст обрезан до {num(CONTEXT_MAX_FILE_CHARS)} символов
                        </span>
                      )}
                      {f.enabled && take < f.chars && (
                        <span className="status-badge warn ctx-note">
                          <i />
                          {take > 0
                            ? `Общий лимит: уйдёт ${num(take)} из ${chars(f.chars)}`
                            : 'Не влез в общий лимит — в запрос не уйдёт'}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="record-actions">
                  {/* label: щелчок по слову переключает так же, как по самому переключателю */}
                  <label className="ctx-toggle">
                    <Switch
                      on={on}
                      disabled={!usable}
                      label={`Учитывать «${f.name}»`}
                      onClick={() => toggle(f.id)}
                    />
                    учитывать
                  </label>
                  <button type="button" className="btn-danger" aria-label={`Удалить «${f.name}»`} onClick={() => remove(f.id)}>
                    Удалить
                  </button>
                </div>
              </article>
            )
          })}
          {failures.map((x) => (
            <article className="record ctx-file" key={x.key}>
              <div className="ctx-main">
                <div className="record-head">
                  <span className="record-when ctx-name">{x.name}</span>
                  <span className="record-sum">Не добавлен</span>
                </div>
                <span className="status-badge bad ctx-note">
                  <i />
                  {x.error}
                </span>
              </div>
              <div className="record-actions">
                <button
                  type="button"
                  className="btn-secondary ink4 small"
                  aria-label={`Убрать сообщение о «${x.name}»`}
                  onClick={() => setFailures((prev) => prev.filter((y) => y.key !== x.key))}
                >
                  Убрать
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="prompt-foot">
        <span aria-live="polite">{busy ? 'Читаю файлы…' : summary}</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy > 0 || full}
          title={full ? `Не больше ${CONTEXT_MAX_FILES} файлов` : undefined}
          onClick={pick}
        >
          Добавить файл
        </button>
      </div>
    </div>
  )
}
