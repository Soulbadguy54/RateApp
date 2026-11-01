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
      'Подключение Steam и синхронизация игр со своей библиотекой Rate APP',
      'Ручной поиск игр из Steam и удобное связывание найденных совпадений',
      'Обновлённый профиль: любимые игры, собственный аватар и цвета оформления',
      'Раздел «Мои ссылки» для сохранения игровых материалов и поиска игр в них',
    ],
  },
  {
    version: '26.10.012',
    period: 'Октябрь 2026',
    changes: [
      '«Для тебя» — персональный Tinder по играм: листайте рекомендации и отмечайте интересные',
      'Уведомления о выходе игр из коллекции «Хочу поиграть»',
      'Новое меню навигации между разделами приложения',
      'Интерактивная история обновлений с возможностью листать версии',
      'Личная библиотека, прохождения, оценки по четырём критериям и коллекции',
    ],
  },
] as const

export const CURRENT_RELEASE_VERSION = RELEASE_NOTES[0].version
