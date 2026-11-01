/** Public-facing *grouped* release notes. The 12 successful October VPS
 * batches remain individually audited in docs/RELEASE_VERSIONS.md, but the
 * public history groups the pre-November launches into one readable October
 * milestone. Keep the next planned release at index 0 until production ships.
 */
export type PublicRelease = Readonly<{
  version: string
  period: string
  changes: readonly string[]
}>

export const RELEASE_NOTES: readonly PublicRelease[] = [
  {
    version: '26.11.001',
    period: 'Ноябрь 2026',
    changes: [
      'Подключение Steam и синхронизация игр со своей библиотекой Rate APP.',
      'Ручной поиск игр из Steam и удобное связывание найденных совпадений.',
      'Обновлённый профиль: любимые игры, собственный аватар и цвета оформления.',
      'Раздел «Мои ссылки» для сохранения игровых материалов и поиска игр в них.',
    ],
  },
  {
    version: '26.10.012',
    period: 'Октябрь 2026 · Все октябрьские обновления',
    changes: [
      'Личная библиотека игр: отмечайте, во что играете, что прошли и что планируете пройти.',
      'Оценки игр по четырём критериям и собственные коллекции для удобной организации библиотеки.',
      'Раздел «Для тебя» с персональными рекомендациями и простыми жестами выбора игр.',
      'Уведомления о выходе игр, которые вы ждёте.',
      'Настройки профиля и возможность сохранить резервную копию своей библиотеки.',
      'Удобная навигация между играми, коллекциями и разделами приложения.',
    ],
  },
] as const

export const CURRENT_RELEASE_VERSION = RELEASE_NOTES[0].version
