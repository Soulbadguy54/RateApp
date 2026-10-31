/** Profile appearance palette is shared by the sticky header and the bottom nav.
 * Default deliberately uses the existing Rate APP green: no green swatch. */
export type ProfileTint = 'default' | 'violet' | 'rose' | 'blue' | 'teal' | 'amber' | 'coral'

export const PROFILE_TINTS: ReadonlyArray<{
  id: ProfileTint
  label: string
  color: string
  rgb: string
  accentRgb: string
}> = [
  { id: 'default', label: 'Без оттенка', color: 'var(--accent)', rgb: '14,19,32', accentRgb: '140,242,125' },
  { id: 'violet', label: 'Фиолетовый', color: '#ad86ee', rgb: '155,105,230', accentRgb: '173,134,238' },
  { id: 'rose', label: 'Розовый', color: '#e384b5', rgb: '235,87,153', accentRgb: '227,132,181' },
  { id: 'blue', label: 'Синий', color: '#719be4', rgb: '75,129,225', accentRgb: '113,155,228' },
  { id: 'teal', label: 'Бирюзовый', color: '#60c9bd', rgb: '47,181,166', accentRgb: '96,201,189' },
  { id: 'amber', label: 'Янтарный', color: '#e4ad63', rgb: '221,171,57', accentRgb: '228,173,99' },
  { id: 'coral', label: 'Коралловый', color: '#ee8a72', rgb: '221,110,84', accentRgb: '238,138,114' },
]

export function profileTintOption(value?: string) {
  return PROFILE_TINTS.find(item => item.id === value) ?? PROFILE_TINTS[0]
}
