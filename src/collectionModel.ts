/** Collection business rules shared across screens. No React state or API calls. */
import type { CSSProperties } from 'react'
import type { GameCollection, LibraryEntry } from './data'

export const WISHLIST_COLLECTION_ID = 'wishlist'

export const COLLECTION_THEMES = [
  { id: 'violet', name: 'Фиолетовый', accent: '#c4a2ff', shade: '#7b46c7', glow: 'rgba(155, 105, 230, .22)' },
  { id: 'rose', name: 'Розовый', accent: 'rgb(var(--palette-wishlist-rgb))', shade: '#b94478', glow: 'rgba(235, 87, 153, .22)' },
  { id: 'blue', name: 'Синий', accent: 'rgb(var(--palette-dislike-rgb))', shade: '#366ac1', glow: 'rgba(75, 129, 225, .24)' },
  { id: 'cyan', name: 'Голубой', accent: '#85ddf2', shade: '#238ba8', glow: 'rgba(50, 170, 198, .23)' },
  { id: 'teal', name: 'Бирюзовый', accent: '#7ee2d7', shade: '#218e88', glow: 'rgba(47, 181, 166, .22)' },
  { id: 'emerald', name: 'Зелёный', accent: 'rgb(var(--palette-like-rgb))', shade: '#35895a', glow: 'rgba(59, 175, 102, .22)' },
  { id: 'lime', name: 'Лаймовый', accent: '#d7ee86', shade: '#859831', glow: 'rgba(175, 194, 65, .21)' },
  { id: 'amber', name: 'Жёлтый', accent: '#f8d783', shade: '#ae7b29', glow: 'rgba(221, 171, 57, .21)' },
  { id: 'orange', name: 'Оранжевый', accent: '#ffb285', shade: '#bc623a', glow: 'rgba(226, 120, 64, .22)' },
  { id: 'slate', name: 'Серый', accent: '#b8c7d8', shade: '#61758d', glow: 'rgba(117, 143, 171, .20)' },
] as const

export function collectionThemeStyle(collection: GameCollection): CSSProperties {
  const id = collection.colorScheme ?? (collection.id === WISHLIST_COLLECTION_ID ? 'rose' : 'violet')
  const theme = COLLECTION_THEMES.find((choice) => choice.id === id) ?? COLLECTION_THEMES[0]
  return {
    '--collection-accent': theme.accent,
    '--collection-shade': theme.shade,
    '--collection-glow': theme.glow,
  } as CSSProperties
}

export const sortCollections = (items: GameCollection[]) =>
  [...items].sort((a, b) =>
    a.id === WISHLIST_COLLECTION_ID ? -1 :
    b.id === WISHLIST_COLLECTION_ID ? 1 :
    a.title.localeCompare(b.title, 'ru', { sensitivity: 'base' }),
  )

// Wishlist first; then already-added collections alphabetically; then remaining.
export const sortCollectionsForGame = (items: GameCollection[], memberships: string[]) => {
  const selected = new Set(memberships)
  return [...items].sort((a, b) => {
    if (a.id === WISHLIST_COLLECTION_ID) return -1
    if (b.id === WISHLIST_COLLECTION_ID) return 1
    if (selected.has(a.id) !== selected.has(b.id)) return selected.has(a.id) ? -1 : 1
    return a.title.localeCompare(b.title, 'ru', { sensitivity: 'base' })
  })
}


// A collection-only entry tracks membership but is not a playthrough.
export const isPlaythrough = (entry?: LibraryEntry): entry is LibraryEntry =>
  Boolean(entry && ['completed', 'playing', 'dropped'].includes(entry.status))

// Optimistic update that preserves existing playthrough data and other collections.
export function withCollectionMembership(
  entries: LibraryEntry[], gameId: number, collectionId: string, enabled: boolean,
): LibraryEntry[] {
  const entry = entries.find((item) => item.gameId === gameId)
  if (!entry) {
    if (!enabled) return entries
    return [...entries, {
      gameId,
      status: 'untracked',
      collectionIds: [collectionId],
      collectionAddedAt: { [collectionId]: new Date().toISOString() },
      addedAt: new Date().toISOString().slice(0, 10),
    }]
  }

  const collectionIds = enabled
    ? Array.from(new Set([...entry.collectionIds, collectionId]))
    : entry.collectionIds.filter((id) => id !== collectionId)
  const others = entries.filter((item) => item.gameId !== gameId)
  const collectionAddedAt = { ...entry.collectionAddedAt }
  if (enabled && !entry.collectionIds.includes(collectionId)) {
    collectionAddedAt[collectionId] = new Date().toISOString()
  }
  if (!enabled) delete collectionAddedAt[collectionId]
  return !isPlaythrough(entry) && collectionIds.length === 0
    ? others
    : [...others, { ...entry, collectionIds, collectionAddedAt }]
}

