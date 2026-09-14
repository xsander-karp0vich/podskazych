import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  providerById,
  type ModelInfo,
  type ProviderId,
} from '@shared/providers'
import { modelFamily, modelName } from '@shared/models'
import type { AppSettings } from '@shared/settings'
import type { ProviderStatus } from '../../preload'
import { availabilityOf, chipOf, isUnchecked as unchecked, noteOf, viaOf } from '../providerStatus'
import { Critter, type CritterMode } from './Mascot'
import { Chevron } from './Icons'

/**
 * Кто отвечает подсказками и какой моделью — макет Claude Design v9, «Выбор модели».
 * Тот же поповер выбирает и того, кто проверяет: у второго агента свой провайдер и своя модель.
 *
 * Поповер в две колонки: слева провайдеры со своим зверьком и состоянием, справа —
 * модели того, на кого наведён курсор или фокус. Выбрать модель неготового
 * провайдера можно: выбор сохранится, а строка ошибки скажет, чего не хватает, —
 * человек мог поставить CLI заранее и просто ещё не войти.
 *
 * Состояние провайдеров держит useProviders: main отдаёт известное сразу и
 * досылает итоги проверок событиями, поэтому окно не ждёт запуска пяти CLI.
 */

/* ---------- состояние провайдеров ---------- */

export interface ProvidersCtl {
  statuses: Record<ProviderId, ProviderStatus>
  /** Провайдеры, чья проверка ещё идёт. */
  checking: ReadonlySet<ProviderId>
  /** Спросить main обо всех заново — при открытии выбора модели и настроек. */
  refresh: () => void
  /** Проверить одного заново — после входа или установки. */
  recheck: (id: ProviderId) => Promise<void>
  /** Открыть терминал со входом. Возвращает текст ошибки или null. */
  login: (id: ProviderId) => Promise<string | null>
}

/** До первого ответа main — «проверяю…»: сразу после монтирования окно о провайдерах и спрашивает. */
function initialStatuses(): Record<ProviderId, ProviderStatus> {
  const out = {} as Record<ProviderId, ProviderStatus>
  for (const p of PROVIDERS) out[p.id] = { id: p.id, available: { state: 'unknown' }, models: p.models, checking: true }
  return out
}

export function useProviders(): ProvidersCtl {
  const [statuses, setStatuses] = useState(initialStatuses)
  /** Проверки, запрошенные кнопкой: флаг main мог ещё не прийти, а кнопка уже должна стать «Проверяю…». */
  const [rechecking, setRechecking] = useState<ReadonlySet<ProviderId>>(() => new Set())

  const apply = useCallback((all: ProviderStatus[]) => {
    if (!Array.isArray(all)) return
    setStatuses((prev) => {
      const next = { ...prev }
      for (const st of all) if (st && isProviderId(st.id)) next[st.id] = st
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    window.copilot
      .listProviders()
      .then(apply)
      .catch(() => {
        // main не ответил — «проверяю…» больше не правда: итогов этой проверки не будет.
        setStatuses((prev) => {
          const next = { ...prev }
          for (const id of PROVIDER_IDS) next[id] = { ...prev[id], checking: false }
          return next
        })
      })
  }, [apply])

  useEffect(() => {
    const off = window.copilot.onProvidersUpdated(apply)
    refresh()
    return off
  }, [apply, refresh])

  const recheck = useCallback(
    async (id: ProviderId) => {
      setRechecking((s) => new Set(s).add(id))
      try {
        apply([await window.copilot.recheckProvider(id)])
      } catch {
        /* итог всё равно придёт событием или следующей проверкой */
      } finally {
        setRechecking((s) => {
          const next = new Set(s)
          next.delete(id)
          return next
        })
      }
    },
    [apply],
  )

  const login = useCallback(async (id: ProviderId) => {
    try {
      const r = await window.copilot.loginProvider(id)
      return r.ok ? null : r.error
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [])

  // Идёт ли проверка, говорит сам main (ProviderStatus.checking): считать события нельзя —
  // от пересекающихся проверок они приходят парами, и счёт кончался раньше самих проверок.
  const checking = useMemo(() => {
    const set = new Set<ProviderId>(rechecking)
    for (const id of PROVIDER_IDS) if (statuses[id].checking) set.add(id)
    return set
  }, [rechecking, statuses])

  return { statuses, checking, refresh, recheck, login }
}

/**
 * Что делать с неготовым провайдером: войти, поставить, проверить снова.
 * Ключей и паролей приложение не касается: вход идёт в окне терминала командой самого CLI.
 */
export function ProviderSetup({
  status,
  checking,
  claudeSource,
  ctl,
  onCopy,
}: {
  status: ProviderStatus
  checking: boolean
  claudeSource: AppSettings['claudeSource']
  ctl: ProvidersCtl
  onCopy: (text: string) => void
}) {
  const info = providerById(status.id)
  const a = availabilityOf(status, claudeSource)
  const [install, setInstall] = useState(false)
  const [login, setLogin] = useState<{ state: 'idle' | 'opening' | 'opened' } | { state: 'failed'; error: string }>({
    state: 'idle',
  })
  const [copied, setCopied] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const copiedTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  const copy = (text: string) => {
    onCopy(text)
    setCopied(text)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1600)
  }

  if (a.state === 'ok') return null

  // По ключу входить некуда: ключ читается из окружения при старте приложения.
  if (status.id === 'claude' && claudeSource === 'api') {
    return (
      <div className="setup">
        <p className="setup-lead">
          Ключ ANTHROPIC_API_KEY не найден. Задайте переменную окружения и перезапустите приложение — или обращайтесь
          к Claude через Claude Code (подписка).
        </p>
      </div>
    )
  }

  const lead = checking
    ? `Проверяю ${info.agent}…`
    : a.state === 'not-installed'
      ? `${info.agent} не найден на этом компьютере.`
      : a.state === 'not-logged-in'
        ? `${info.agent} установлен, но вход не выполнен.`
        : a.state === 'error'
          ? `${info.agent}: ${a.message}`
          : (a.message ?? `Не удалось узнать, выполнен ли вход в ${info.agent}.`)

  const canLogin = !!info.login && (a.state === 'not-logged-in' || a.state === 'unknown')
  const canInstall = a.state !== 'not-logged-in'
  // irm … | iex — команда PowerShell; в cmd она не сработает, и это стоит сказать.
  const shell = info.install.command && /\b(irm|iex)\b/.test(info.install.command) ? 'PowerShell' : 'терминале'

  /**
   * Страницу открывает main через системный браузер: обычная ссылка открылась бы окном
   * Electron поверх созвона. Не открылась — ссылку копируем, чтобы человек не остался ни с чем.
   */
  const openInstall = async () => {
    setOpenError(null)
    try {
      const r = await window.copilot.openExternal(info.install.url)
      if (r.ok) return
      setOpenError(r.error)
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e))
    }
    copy(info.install.url)
  }

  return (
    <div className="setup">
      <p className="setup-lead">{lead}</p>
      <div className="setup-actions">
        {canLogin && (
          <button
            type="button"
            data-nav=""
            className="btn-primary xs"
            disabled={login.state === 'opening'}
            onClick={async () => {
              setLogin({ state: 'opening' })
              const error = await ctl.login(status.id)
              setLogin(error ? { state: 'failed', error } : { state: 'opened' })
            }}
          >
            Войти
          </button>
        )}
        {canInstall && (
          <button
            type="button"
            data-nav=""
            className={`btn-secondary xs ${install ? 'on' : ''}`}
            aria-expanded={install}
            onClick={() => setInstall((v) => !v)}
          >
            Как установить
          </button>
        )}
        <button
          type="button"
          data-nav=""
          className="btn-secondary xs"
          disabled={checking}
          onClick={() => void ctl.recheck(status.id)}
        >
          {checking ? 'Проверяю…' : 'Проверить снова'}
        </button>
      </div>
      {login.state === 'opened' && (
        <p className="setup-hint">Войдите в открывшемся окне терминала, затем нажмите «Проверить снова».</p>
      )}
      {login.state === 'failed' && <p className="setup-error">Окно входа не открылось: {login.error}</p>}
      {install && canInstall && (
        <div className="setup-install">
          {/* Кнопка — в строке подписи, а команда — во всю ширину: в узкой колонке рядом с кнопкой она рвалась бы по буквам. */}
          {info.install.command && (
            <div className="setup-block">
              <span className="setup-bar">
                <span className="setup-cap">Выполните в {shell}:</span>
                <button type="button" data-nav="" className="setup-copy" onClick={() => copy(info.install.command!)}>
                  {copied === info.install.command ? 'Скопировано' : 'Копировать'}
                </button>
              </span>
              <code className="setup-code">{info.install.command}</code>
            </div>
          )}
          <div className="setup-block">
            <span className="setup-bar">
              <span className="setup-cap">Инструкция:</span>
              <button
                type="button"
                data-nav=""
                className="setup-copy"
                title="Открыть инструкцию в браузере"
                onClick={() => void openInstall()}
              >
                {copied === info.install.url ? 'Ссылка скопирована' : 'Открыть'}
              </button>
            </span>
            <code className="setup-code url">{info.install.url}</code>
          </div>
          {openError && <p className="setup-error">Браузер не открылся: {openError}. Ссылка скопирована.</p>}
          <span className="setup-cap">После установки нажмите «Проверить снова».</span>
        </div>
      )}
    </div>
  )
}

/* ---------- поповер выбора ---------- */

/** Ширина двух колонок с разделителем. Уже этого окна — одна колонка с переходом к моделям. */
const TWO_COL_W = 500
const EDGE = 12
/**
 * Столько места под поповером хватает, чтобы открыться вниз. Меньше — открываемся туда,
 * где просторнее: второй агент в узком окне стоит под основным, почти у низа окна.
 */
const ROOM_BELOW = 240

/** Подписи для того, кто отвечает, и для того, кто проверяет. */
const ROLE_TEXT = {
  main: { who: 'Кто отвечает', dialog: 'Кто отвечает и какой моделью' },
  verify: { who: 'Кто проверяет', dialog: 'Кто проверяет и какой моделью' },
} as const

interface Props {
  /** чей выбор: основного агента или второго, проверяющего */
  role?: keyof typeof ROLE_TEXT
  provider: ProviderId
  model: string
  /**
   * Как обращаться к Claude — от этого зависят его чип и подпись. Второй агент у Claude
   * всегда идёт через Claude Code, поэтому ему передают 'cli'.
   */
  claudeSource: AppSettings['claudeSource']
  ctl: ProvidersCtl
  /** состояние ответа — зверёк на кнопке думает, печатает, гаснет */
  mode: CritterMode
  /** короткое имя модели и без имени провайдера на кнопке */
  compact: boolean
  /** маленькая кнопка — для заголовка окна второго агента */
  small?: boolean
  onPick: (provider: ProviderId, model: string) => void
  onCopy: (text: string) => void
}

export function ProviderPicker({ role = 'main', provider: active, model, claudeSource, ctl, mode, compact, small, onPick, onCopy }: Props) {
  const text = ROLE_TEXT[role]
  const [open, setOpen] = useState(false)
  /** чьи модели справа: наведение и фокус меняют его, выбор — нет */
  const [shown, setShown] = useState<ProviderId>(active)
  /** в узком окне колонка одна: список провайдеров или модели одного из них */
  const [drilled, setDrilled] = useState(true)
  const [place, setPlace] = useState<{ narrow: boolean; shift: number; maxH: number; w: number; up: boolean }>({
    narrow: false,
    shift: 0,
    maxH: 420,
    w: TWO_COL_W,
    up: false,
  })
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { refresh } = ctl

  const liveOf = (id: ProviderId): readonly ModelInfo[] => ctl.statuses[id].models
  const activeLive = liveOf(active)
  const label = compact ? modelFamily(model, active, activeLive) : modelName(model, active, activeLive)
  const activeInfo = providerById(active)

  const close = useCallback((focusButton: boolean) => {
    setOpen(false)
    if (focusButton) btnRef.current?.focus()
  }, [])

  /**
   * Поповер не должен уходить за края окна: панель бывает шириной 560 px, а при
   * масштабе ×2 в ней остаётся 280 CSS-пикселей. Не влезают две колонки — одна.
   * Высота — сколько есть на выбранной стороне, без запаса сверх неё: вылезший за окно
   * низ не прокрутить, и последние модели с кнопкой «Войти» стали бы недоступны.
   */
  const measure = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    // Размер области без полос прокрутки: innerWidth их включает и при масштабе бывает шире видимого.
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const narrow = vw - EDGE * 2 < TWO_COL_W
    const w = narrow ? Math.min(300, vw - EDGE * 2) : TWO_COL_W
    const left = r.right - w
    const shift = left < EDGE ? EDGE - left : 0
    const below = Math.floor(vh - r.bottom - 4 - EDGE)
    const above = Math.floor(r.top - 4 - EDGE)
    const up = below < ROOM_BELOW && above > below
    const maxH = Math.max(0, up ? above : below)
    setPlace((p) =>
      p.narrow === narrow && p.shift === shift && p.maxH === maxH && p.w === w && p.up === up
        ? p
        : { narrow, shift, maxH, w, up },
    )
  }, [])

  const openPop = () => {
    // Место меряем до первой отрисовки: иначе фокус встал бы в две колонки, которые тут же сменятся одной.
    measure()
    setShown(active)
    setDrilled(true)
    setOpen(true)
    // Состояние могло устареть: вошли в CLI, пока окно висело. main отвечает из кэша, проверка — в фоне.
    refresh()
  }

  // Клик мимо закрывает; Esc закрывает только поповер — перехватываем раньше окон под ним.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false)
    }
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close(true)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open) return
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, measure])

  // Фокус при открытии — на выбранную модель: чаще всего меняют именно её.
  useEffect(() => {
    if (!open) return
    const pop = popRef.current
    const target =
      pop?.querySelector<HTMLElement>('.pp-model[aria-selected="true"]') ??
      pop?.querySelector<HTMLElement>(`.pp-prov[data-prov="${active}"]`) ??
      pop?.querySelector<HTMLElement>('[data-nav]')
    target?.focus()
    // Только при открытии: дальше фокус ведёт человек.
  }, [open])

  /**
   * Фокус стоял в колонке моделей, а курсор прошёл над другим провайдером: колонка
   * перерисовалась под него, кнопка с фокусом исчезла, и стрелки перестали работать.
   * Возвращаем фокус на строку провайдера, чьи модели теперь справа, — оттуда → ведёт к ним.
   */
  const refocus = useRef(false)
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    const pop = popRef.current
    if (!pop || pop.contains(document.activeElement)) return
    pop.querySelector<HTMLElement>(`.pp-prov[data-prov="${shown}"]`)?.focus({ preventScroll: true })
  }, [shown])

  const hover = (id: ProviderId) => {
    if (place.narrow || id === shown) return
    const el = document.activeElement
    refocus.current = !!el && !!popRef.current?.querySelector('.pp-models')?.contains(el)
    setShown(id)
  }

  const pick = (provider: ProviderId, id: string) => {
    onPick(provider, id)
    close(true)
  }

  /** В колонку моделей: на выбранную, иначе на первую модель или кнопку. */
  const focusModels = () => {
    const pop = popRef.current
    ;(
      pop?.querySelector<HTMLElement>('.pp-model[aria-selected="true"]') ??
      pop?.querySelector<HTMLElement>('.pp-models [data-nav]')
    )?.focus()
  }

  /** Стрелки ходят внутри колонки, ← → — между колонками, Home/End — к краям. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement as HTMLElement | null
    const pop = popRef.current
    if (!el || !pop || !pop.contains(el)) return
    const inProvs = !!el.closest('.pp-provs')
    const column = el.closest<HTMLElement>('.pp-provs, .pp-models')
    if (!column) return
    const items = [...column.querySelectorAll<HTMLElement>('[data-nav]:not(:disabled)')]
    const i = items.indexOf(el)
    const focusIn = (sel: string) => pop.querySelector<HTMLElement>(sel)?.focus()
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!items.length) return
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        items[(i + step + items.length) % items.length]?.focus()
        return
      }
      case 'Home':
      case 'End':
        if (!items.length) return
        e.preventDefault()
        items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
        return
      case 'ArrowRight':
        if (!inProvs) return
        e.preventDefault()
        if (place.narrow) {
          const id = el.dataset.prov
          if (id && isProviderId(id)) setShown(id)
          setDrilled(true)
          return
        }
        focusModels()
        return
      case 'ArrowLeft':
        if (inProvs) return
        e.preventDefault()
        if (place.narrow) {
          setDrilled(false)
          return
        }
        focusIn(`.pp-prov[data-prov="${shown}"]`)
        return
    }
  }

  // В узком окне переход между списками меняет разметку — фокус переносим следом.
  const prevDrilled = useRef(drilled)
  useEffect(() => {
    if (!open || !place.narrow || prevDrilled.current === drilled) {
      prevDrilled.current = drilled
      return
    }
    prevDrilled.current = drilled
    const pop = popRef.current
    if (drilled) {
      ;(
        pop?.querySelector<HTMLElement>('.pp-model[aria-selected="true"]') ??
        pop?.querySelector<HTMLElement>('.pp-models [data-nav]')
      )?.focus()
    } else {
      pop?.querySelector<HTMLElement>(`.pp-prov[data-prov="${shown}"]`)?.focus()
    }
  }, [drilled, open, place.narrow, shown])

  const shownInfo = providerById(shown)
  const shownStatus = ctl.statuses[shown]
  const shownChecking = ctl.checking.has(shown)
  const shownChip = chipOf(shownStatus, shownChecking, claudeSource)
  const shownModels = shownStatus.models
  // Выбранная модель могла пропасть из живого списка — показываем её всё равно, иначе выбор «пропал бы».
  const models: readonly ModelInfo[] =
    shown === active && model && !shownModels.some((m) => m.id === model) && shown !== 'claude'
      ? [...shownModels, { id: model, name: model, hint: 'нет в списке', efforts: null }]
      : shownModels

  const showProvs = !place.narrow || !drilled
  const showModels = !place.narrow || drilled

  return (
    <div className={`pp ${small ? 'xs' : ''}`} ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="picker-btn pp-btn"
        title={`${text.dialog} — ${activeInfo.name} · ${modelName(model, active, activeLive)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openPop())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openPop()
          }
        }}
      >
        <Critter mode={mode} size={small ? 16 : 22} provider={active} />
        {/* «Gemini Gemini 3.8 Flash» читается как опечатка: имя провайдера уже есть в имени модели. */}
        {!compact && !label.startsWith(activeInfo.name) && <span className="picker-brand">{activeInfo.name}</span>}
        <span className="picker-label">{label}</span>
        <Chevron />
      </button>

      {open && (
        <div
          ref={popRef}
          className={`pp-pop ${place.narrow ? 'narrow' : ''} ${place.up ? 'up' : ''}`}
          role="dialog"
          aria-label={text.dialog}
          style={{ right: -place.shift, maxHeight: place.maxH, width: place.w } as CSSProperties}
          onKeyDown={onKey}
        >
          {showProvs && (
            <div className="pp-provs" role="listbox" aria-label={text.who}>
              {PROVIDERS.map((p) => {
                const st = ctl.statuses[p.id]
                const on = p.id === active
                const chip = chipOf(st, ctl.checking.has(p.id), claudeSource)
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    data-nav=""
                    data-prov={p.id}
                    aria-selected={on}
                    className={`pp-prov ${shown === p.id ? 'shown' : ''} ${on ? 'active' : ''}`}
                    style={{ '--pc': p.color } as CSSProperties}
                    onMouseEnter={() => hover(p.id)}
                    onFocus={() => !place.narrow && setShown(p.id)}
                    onClick={() => {
                      setShown(p.id)
                      if (place.narrow) setDrilled(true)
                      // Колонка справа перерисуется под этого провайдера — фокус переносим после отрисовки.
                      else window.requestAnimationFrame(focusModels)
                    }}
                  >
                    {/* Спит всё, кроме выбранного сейчас: его видно без чтения. */}
                    <Critter mode={on ? 'idle' : 'off'} size={18} still provider={p.id} />
                    <span className="pp-prov-text">
                      <span className="pp-prov-top">
                        <span className="pp-name">{p.name}</span>
                        {on && <span className="pp-mark" aria-hidden>✓</span>}
                        <span className={`pp-chip ${chip.tone}`} title={chip.title}>
                          {chip.text}
                        </span>
                      </span>
                      <span className="pp-via">{viaOf(p.id, claudeSource)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {!place.narrow && <div className="pp-divider" aria-hidden />}

          {showModels && (
            <div className="pp-models">
              {place.narrow && (
                <button type="button" data-nav="" className="pp-back" onClick={() => setDrilled(false)}>
                  <span className="chev left" aria-hidden>
                    <Chevron />
                  </span>
                  Все провайдеры
                </button>
              )}
              <span className="pp-head">
                {shownInfo.name}
                {place.narrow && <span className={`pp-chip ${shownChip.tone}`}>{shownChip.text}</span>}
              </span>
              {models.length > 0 ? (
                <div role="listbox" aria-label={`Модели ${shownInfo.name}`} className="pp-list">
                  {models.map((m) => {
                    const on = shown === active && m.id === model
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        data-nav=""
                        aria-selected={on}
                        className={`pp-model ${on ? 'active' : ''}`}
                        title={m.note ?? `${m.name} — ${m.hint}`}
                        onClick={() => pick(shown, m.id)}
                      >
                        <span className="pp-model-name">
                          <i style={{ background: shownInfo.color }} />
                          <span>{m.name}</span>
                        </span>
                        <span className="hint">{m.hint}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="pp-empty">
                  {shownChecking ? 'Проверяю, какие модели доступны…' : (shownInfo.modelsHint ?? 'Список моделей пуст.')}
                </p>
              )}
              <p className="pp-note">{noteOf(shown, claudeSource)}</p>
              {!shownChecking || !unchecked(shownStatus.available) ? (
                <ProviderSetup
                  key={shown}
                  status={shownStatus}
                  checking={shownChecking}
                  claudeSource={claudeSource}
                  ctl={ctl}
                  onCopy={onCopy}
                />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
