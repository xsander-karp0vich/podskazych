import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTrayPref, serializeTrayPref, shouldShowTray, type TrayState } from '../src/main/trayVisibility.ts'

/** Обычное состояние: панель на экране, все клавиши достались, режим сквозь панель выключен. */
const base: TrayState = {
  hideTray: true,
  clickThroughOn: false,
  clickThroughHotkey: 'Ctrl+Shift+X',
  overlayVisible: true,
  hideHotkey: 'Ctrl+Shift+H',
}

test('трей: настройка выключена — значок есть всегда', () => {
  for (const clickThroughOn of [false, true]) {
    for (const overlayVisible of [false, true]) {
      assert.equal(shouldShowTray({ ...base, hideTray: false, clickThroughOn, overlayVisible }), true)
    }
  }
})

test('трей: настройка включена и управление есть — значка нет', () => {
  assert.equal(shouldShowTray(base), false)
  // Режим включён, но выключается своей клавишей.
  assert.equal(shouldShowTray({ ...base, clickThroughOn: true }), false)
  // Панель спрятана, но возвращается своей клавишей.
  assert.equal(shouldShowTray({ ...base, overlayVisible: false }), false)
})

test('трей: клики сквозь панель без клавиши выхода — значок возвращается', () => {
  assert.equal(shouldShowTray({ ...base, clickThroughOn: true, clickThroughHotkey: null }), true)
  // Клавиши нет, но режим выключен — панель ловит клики, трей не нужен.
  assert.equal(shouldShowTray({ ...base, clickThroughOn: false, clickThroughHotkey: null }), false)
})

test('трей: панель спрятана без клавиши, которая её вернёт, — значок возвращается', () => {
  assert.equal(shouldShowTray({ ...base, overlayVisible: false, hideHotkey: null }), true)
  // Клавиши нет, но панель на экране — управлять можно из её меню.
  assert.equal(shouldShowTray({ ...base, overlayVisible: true, hideHotkey: null }), false)
})

test('трей: панель не отвечает — значок возвращается', () => {
  assert.equal(shouldShowTray({ ...base, overlayUsable: false }), true)
  assert.equal(shouldShowTray({ ...base, overlayUsable: true }), false)
})

test('трей: файл настройки — битое и чужое не прячет значок', () => {
  for (const raw of [undefined, null, '', 'не json', '[]', 'null', '42', '{"hideTray":"true"}', '{"hideTray":1}', '{}']) {
    assert.equal(parseTrayPref(raw), false, String(raw))
  }
  assert.equal(parseTrayPref('{"hideTray":true}'), true)
  assert.equal(parseTrayPref(serializeTrayPref(true)), true)
  assert.equal(parseTrayPref(serializeTrayPref(false)), false)
})
