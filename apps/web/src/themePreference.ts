export type ThemePreference = 'light' | 'dark' | 'system'
export type ColorTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'flowline-theme'

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function resolveColorTheme(preference: ThemePreference, systemPrefersDark: boolean): ColorTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export function readThemePreference(storage?: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const availableStorage = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    return parseThemePreference(availableStorage?.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}
