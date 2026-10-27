// Only completed, playing and dropped represent playthroughs. The others are
// internal placeholders for collection-only records from the API.
export type LibraryStatus = 'completed' | 'playing' | 'dropped' | 'wishlist' | 'untracked'

export type Game = {
  id: number
  title: string
  genres: string[]
  year: number
  releaseDate: string
  developer: string
  platforms: string[]
  igdbRating: number
  communityRating: number
  communityRatings: number
  accent: string
  accent2: string
  glyph: string
  coverUrl?: string
  storeLinks?: { provider: string; label: string; url: string }[]
  trailerUrl?: string | null
  summary?: string
  storyline?: string
  storyHours?: number | null
  completionHours?: number | null
}

export type LibraryEntry = {
  gameId: number
  status: LibraryStatus
  platform?: string
  completedAt?: string
  startedAt?: string
  score?: number
  atmosphereScore?: number
  storyScore?: number
  technologyScore?: number
  gameplayScore?: number
  review?: string
  collectionIds: string[]
  collectionAddedAt?: Record<string, string>
  /** Timestamp of the most recent transition into completed, dropped, or playing. */
  statusChangedAt?: string | null
  addedAt: string
}

export type GameCollection = {
  id: string
  title: string
  description: string
  mark: string
  colorScheme?: string
  emoji?: string | null
  iconData?: string | null
  isSystem?: boolean
}

export const profile = {
  nickname: 'soulbadguy',
  displayName: 'Soul Badguy',
  email: 'soul@example.com',
  joinedAt: '2026-09-30',
}

export const collections: GameCollection[] = [
  {
    id: 'best',
    title: 'Лучшее из пройденного',
    description: 'Игры, к которым хочется возвращаться.',
    mark: '★',
  },
  {
    id: '2026',
    title: '2026',
    description: 'Что прошёл и прохожу в этом году.',
    mark: '26',
  },
  {
    id: 'coop',
    title: 'Кооп',
    description: 'Игры для совместных вечеров.',
    mark: 'CO',
  },
  {
    id: 'cozy',
    title: 'На расслабоне',
    description: 'Спокойные игры без спешки.',
    mark: '☁',
  },
]

export const games: Game[] = [
  {
    id: 1,
    title: 'Neon Divide',
    genres: ['RPG', 'Экшен'],
    year: 2026,
    releaseDate: '2026-03-12',
    developer: 'Northstar Assembly',
    platforms: ['PC', 'PS5', 'Xbox Series'],
    igdbRating: 88,
    communityRating: 9.0,
    communityRatings: 1284,
    accent: '#8cf27d',
    accent2: '#2c6bff',
    glyph: 'ND',
  },
  {
    id: 2,
    title: 'Ashes of Meridian',
    genres: ['RPG', 'Приключение'],
    year: 2025,
    releaseDate: '2025-11-04',
    developer: 'Red Hollow',
    platforms: ['PC', 'PS5'],
    igdbRating: 84,
    communityRating: 8.6,
    communityRatings: 872,
    accent: '#ff8b63',
    accent2: '#8b3dff',
    glyph: 'AM',
  },
  {
    id: 3,
    title: 'Driftline',
    genres: ['Гонки', 'Аркада'],
    year: 2026,
    releaseDate: '2026-06-19',
    developer: 'Vector Mile',
    platforms: ['PC', 'Xbox Series'],
    igdbRating: 81,
    communityRating: 8.2,
    communityRatings: 539,
    accent: '#54d8ff',
    accent2: '#0067ff',
    glyph: 'DL',
  },
  {
    id: 4,
    title: 'Tiny Kingdoms',
    genres: ['Стратегия', 'Инди'],
    year: 2024,
    releaseDate: '2024-08-27',
    developer: 'Pine & Pixel',
    platforms: ['PC', 'Switch'],
    igdbRating: 89,
    communityRating: 8.8,
    communityRatings: 1942,
    accent: '#ffd56b',
    accent2: '#f17f5a',
    glyph: 'TK',
  },
  {
    id: 5,
    title: 'Signal Lost',
    genres: ['Кооператив', 'Экшен'],
    year: 2025,
    releaseDate: '2025-10-09',
    developer: 'Null Beacon',
    platforms: ['PC', 'PS5', 'Xbox Series'],
    igdbRating: 83,
    communityRating: 8.5,
    communityRatings: 611,
    accent: '#fb6ea9',
    accent2: '#713cff',
    glyph: 'SL',
  },
  {
    id: 6,
    title: 'Paper Skies',
    genres: ['Инди', 'Приключение'],
    year: 2025,
    releaseDate: '2025-05-16',
    developer: 'Soft Harbour',
    platforms: ['PC', 'Switch'],
    igdbRating: 91,
    communityRating: 9.2,
    communityRatings: 2218,
    accent: '#a7efff',
    accent2: '#7b8dff',
    glyph: 'PS',
  },
  {
    id: 7,
    title: 'Black Circuit',
    genres: ['Экшен', 'Roguelike'],
    year: 2026,
    releaseDate: '2026-01-30',
    developer: 'Static Room',
    platforms: ['PC', 'PS5'],
    igdbRating: 86,
    communityRating: 8.9,
    communityRatings: 1007,
    accent: '#ff6464',
    accent2: '#4624d9',
    glyph: 'BC',
  },
  {
    id: 8,
    title: 'Long Way Home',
    genres: ['Приключение', 'Инди'],
    year: 2025,
    releaseDate: '2025-09-21',
    developer: 'Sunday Drive',
    platforms: ['PC', 'PS5', 'Switch'],
    igdbRating: 80,
    communityRating: 8.3,
    communityRatings: 403,
    accent: '#9dd899',
    accent2: '#e8a36d',
    glyph: 'LH',
  },
  {
    id: 9,
    title: 'Iron Choir',
    genres: ['Стратегия', 'RPG'],
    year: 2026,
    releaseDate: '2026-08-08',
    developer: 'Grey Banner',
    platforms: ['PC'],
    igdbRating: 87,
    communityRating: 8.7,
    communityRatings: 726,
    accent: '#d4c6a5',
    accent2: '#5d667a',
    glyph: 'IC',
  },
]

export const initialLibrary: LibraryEntry[] = [
  {
    gameId: 1,
    status: 'completed',
    platform: 'PS5',
    completedAt: '2026-09-28',
    score: 9.4,
    review: 'Очень цельная RPG. Больше всего зашла свобода в квестах и темп истории.',
    collectionIds: ['best', '2026'],
    addedAt: '2026-09-28',
  },
  {
    gameId: 2,
    status: 'playing',
    platform: 'PC',
    startedAt: '2026-09-22',
    collectionIds: ['2026'],
    addedAt: '2026-09-22',
  },
  {
    gameId: 4,
    status: 'completed',
    platform: 'Switch',
    completedAt: '2026-08-14',
    score: 8.7,
    review: 'Идеальная маленькая стратегия для коротких сессий.',
    collectionIds: ['cozy', '2026'],
    addedAt: '2026-08-14',
  },
  {
    gameId: 5,
    status: 'playing',
    platform: 'PS5',
    startedAt: '2026-08-03',
    collectionIds: ['coop', '2026'],
    addedAt: '2026-08-03',
  },
  {
    gameId: 6,
    status: 'completed',
    platform: 'PC',
    completedAt: '2026-07-03',
    score: 9.1,
    review: 'Редкий случай, когда короткая игра заканчивается ровно тогда, когда нужно.',
    collectionIds: ['best', 'cozy', '2026'],
    addedAt: '2026-07-03',
  },
  {
    gameId: 7,
    status: 'completed',
    platform: 'PS5',
    completedAt: '2026-05-18',
    score: 8.9,
    review: 'Быстрый, жёсткий и очень хорошо отполированный экшен.',
    collectionIds: ['best', '2026'],
    addedAt: '2026-05-18',
  },
  {
    gameId: 3,
    status: 'wishlist',
    collectionIds: [],
    addedAt: '2026-04-11',
  },
  {
    gameId: 8,
    status: 'wishlist',
    collectionIds: ['cozy'],
    addedAt: '2026-03-02',
  },
]
