import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/settings'
import { Chevron, Exit, Gear, Mic, Screen } from './Icons'
import { SwitchMark } from './Controls'
import { Mascot } from './Mascot'

interface Props {
  settings: AppSettings
  mics: MediaDeviceInfo[]
  screens: Array<{ id: string; label: string; primary: boolean }>
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /** режим «клики сквозь окно» — его держит main, меню только показывает */
  clickThrough: boolean
  /** клавиши выхода из режима; пусто — комбинацию занять не удалось, выход только через трей */
  clickThroughKeys: string[]
  onClickThrough: () => void
  /** показать обучение заново */
  onOpenTour: () => void
  onOpenSettings: () => void
  onQuit: () => void
  onClose: () => void
}

type Flag = 'contentProtected' | 'showTranscript' | 'useKnowledgeBase' | 'autoSuggest'

/**
 * Меню из гамбургера. Стоит внутри окна и не выше его: max-height —
 * окно минус 96 px, лишнее прокручивается. Закрывается кликом по слою под
 * меню и по Esc.
 */
export function Menu({
  settings,
  mics,
  screens,
  onChange,
  clickThrough,
  clickThroughKeys,
  onClickThrough,
  onOpenTour,
  onOpenSettings,
  onQuit,
  onClose,
}: Props) {
  const [open, setOpen] = useState<'mic' | 'screen' | null>(null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  const micOptions = [
    { value: '', label: 'По умолчанию' },
    ...mics.map((d) => ({ value: d.deviceId, label: d.label || 'Микрофон' })),
  ]
  const screenOptions = [
    { value: '', label: 'Основной' },
    ...screens.map((d) => ({ value: d.id, label: d.label })),
  ]
  const micLabel = micOptions.find((o) => o.value === settings.micDeviceId)?.label ?? 'По умолчанию'
  const screenLabel = screenOptions.find((o) => o.value === settings.displayId)?.label ?? 'Основной'
  const density = Math.round(Math.max(0.3, Math.min(1, settings.opacity)) * 100)

  const list = (
    kind: 'mic' | 'screen',
    options: Array<{ value: string; label: string }>,
    value: string,
    pick: (v: string) => void,
  ) =>
    open === kind && (
      <div className="menu-options" role="listbox">
        {options.map((o) => (
          <button
            key={o.value || 'default'}
            type="button"
            role="option"
            aria-selected={o.value === value}
            className={`menu-option ${o.value === value ? 'active' : ''}`}
            onClick={() => {
              pick(o.value)
              setOpen(null)
            }}
          >
            <span>{o.label}</span>
            <span className="mark">{o.value === value ? '✓' : ''}</span>
          </button>
        ))}
      </div>
    )

  const flag = (key: Flag, label: string, sub?: string) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={settings[key]}
      className="menu-toggle"
      onClick={() => onChange(key, !settings[key])}
    >
      <span className="text">
        <span className="label">{label}</span>
        {sub && <span className="sub">{sub}</span>}
      </span>
      <SwitchMark on={settings[key]} />
    </button>
  )

  return (
    <>
      <div className="menu-layer" onMouseDown={onClose} />
      <div className="menu" role="menu">
        <button type="button" className="menu-item" role="menuitem" onClick={onOpenTour}>
          <Mascot size={16} live={false} still />
          <span>Обучение</span>
          <span className="end">2 минуты</span>
        </button>
        <button type="button" className="menu-item" role="menuitem" onClick={onOpenSettings}>
          <Gear />
          <span>Настройки</span>
          <span className="end">›</span>
        </button>

        <div className="menu-block">
          <button
            type="button"
            className="menu-select"
            aria-expanded={open === 'mic'}
            onClick={() => setOpen((o) => (o === 'mic' ? null : 'mic'))}
          >
            <span className="name">
              <Mic />
              Микрофон
            </span>
            <span className="value">
              <span>{micLabel}</span>
              <Chevron />
            </span>
          </button>
          {list('mic', micOptions, settings.micDeviceId, (v) => onChange('micDeviceId', v))}

          <button
            type="button"
            className="menu-select"
            aria-expanded={open === 'screen'}
            onClick={() => setOpen((o) => (o === 'screen' ? null : 'screen'))}
          >
            <span className="name">
              <Screen />
              Экран для снимка
            </span>
            <span className="value">
              <span>{screenLabel}</span>
              <Chevron />
            </span>
          </button>
          {list('screen', screenOptions, settings.displayId, (v) => onChange('displayId', v))}

          <div className="menu-note">Звук собеседника — берётся с устройства вывода системы</div>
        </div>

        <div className="menu-sep" />

        <div className="menu-sliders">
          <label className="slider">
            <span className="slider-head">
              <span>Прозрачность</span>
              <span className="slider-val">{density} %</span>
            </span>
            <input
              type="range"
              min={30}
              max={100}
              value={density}
              aria-label="Плотность подложки"
              onChange={(e) => onChange('opacity', Number(e.target.value) / 100)}
            />
            <span className="slider-note">плотность подложки · текст всегда непрозрачный</span>
          </label>
          <label className="slider">
            <span className="slider-head">
              <span>Размер шрифта</span>
              <span className="slider-val">{settings.fontSize} px</span>
            </span>
            <input
              type="range"
              min={13}
              max={24}
              value={settings.fontSize}
              aria-label="Размер шрифта ответа"
              onChange={(e) => onChange('fontSize', Number(e.target.value))}
            />
          </label>
          <label className="slider">
            <span className="slider-head">
              <span>Масштаб интерфейса</span>
              <span className="slider-val">{Math.round(settings.zoom * 100)} %</span>
            </span>
            <input
              type="range"
              min={60}
              max={200}
              step={5}
              value={Math.round(settings.zoom * 100)}
              aria-label="Масштаб интерфейса"
              onChange={(e) => onChange('zoom', Number(e.target.value) / 100)}
            />
            <span className="slider-note">
              Ctrl <kbd>+</kbd> / <kbd>−</kbd>
            </span>
          </label>
        </div>

        <div className="menu-sep wide" />

        {/* Скрытие от захвата — под рукой, а не только в настройках: перед демонстрацией экрана его
            проверяют за секунду, а «виден в захвате» в строке состояния должно выключаться в один щелчок. */}
        {flag(
          'contentProtected',
          'Скрывать от захвата экрана',
          settings.contentProtected
            ? 'панели не видно в демонстрации, записи и на скриншотах'
            : 'сейчас панель видна в демонстрации экрана и в записи',
        )}
        {/* Режим держит main: строка не переключает его сама, а просит — и закрывает меню,
            потому что в этом режиме по меню уже не кликнуть. Выход — клавишами или из трея. */}
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={clickThrough}
          className="menu-toggle"
          onClick={onClickThrough}
        >
          <span className="text">
            <span className="label">Клики сквозь окно</span>
            <span className="sub">
              клики уходят в окно под панелью · выйти{' '}
              {clickThroughKeys.length ? clickThroughKeys.join(' ') : 'через трей'}
            </span>
          </span>
          <SwitchMark on={clickThrough} />
        </button>
        {flag('showTranscript', 'Расшифровка разговора')}
        {flag('useKnowledgeBase', 'База знаний', 'вопросы с собеседований 1С — найденное уходит в запрос')}
        {flag('autoSuggest', 'Готовить ответ заранее', 'ищет по базе, пока собеседник говорит')}

        <div className="menu-sep" />
        <button type="button" className="menu-item danger" role="menuitem" onClick={onQuit}>
          <Exit />
          <span>Закрыть приложение</span>
        </button>
      </div>
    </>
  )
}
