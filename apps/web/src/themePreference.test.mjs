import test from 'node:test'
import assert from 'node:assert/strict'
import { parseThemePreference, readThemePreference, resolveColorTheme, THEME_STORAGE_KEY } from './themePreference.ts'

test('theme preference accepts the three supported choices and falls back safely', () => {
  assert.equal(parseThemePreference('light'), 'light')
  assert.equal(parseThemePreference('dark'), 'dark')
  assert.equal(parseThemePreference('system'), 'system')
  assert.equal(parseThemePreference('sepia'), 'system')
  assert.equal(parseThemePreference(null), 'system')
})

test('system preference follows the OS while explicit choices override it', () => {
  assert.equal(resolveColorTheme('system', true), 'dark')
  assert.equal(resolveColorTheme('system', false), 'light')
  assert.equal(resolveColorTheme('light', true), 'light')
  assert.equal(resolveColorTheme('dark', false), 'dark')
})

test('stored theme preference reads the expected key and tolerates unavailable storage', () => {
  let keyRead = ''
  assert.equal(readThemePreference({ getItem: key => { keyRead = key; return 'dark' } }), 'dark')
  assert.equal(keyRead, THEME_STORAGE_KEY)
  assert.equal(readThemePreference({ getItem: () => 'invalid' }), 'system')
  assert.equal(readThemePreference({ getItem: () => { throw new Error('storage disabled') } }), 'system')
})
