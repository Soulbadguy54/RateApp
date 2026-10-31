import type { Game, LibraryEntry } from './data'
import { ratedStatuses } from './statusPresentation'

export type ProfileTopGame = { game: Game; score: number }

/** Only the signed-in user's real completed/dropped evaluations.
 * Do not use IGDB/community scores, wishlist/playing rows, or demo fallbacks. */
export function profileTopGames(entries: LibraryEntry[], gameById: Map<number, Game>): ProfileTopGame[] {
  return entries.flatMap(entry => {
    if (!ratedStatuses.has(entry.status) || typeof entry.score !== 'number' ||
      !Number.isFinite(entry.score) || entry.score < 1 || entry.score > 10) return []
    const game = gameById.get(entry.gameId)
    return game ? [{ game, score: entry.score }] : []
  }).sort((a, b) => b.score - a.score ||
    a.game.title.localeCompare(b.game.title, 'ru') || a.game.id - b.game.id)
    .slice(0, 6)
}

export type ProfileCloud = { game: Game; score: number | null; manual: boolean } | null

/** Three stable cloud slots. Manual picks have priority, automatic picks exclude
 * all manually pinned games so a top game cannot appear twice. */
export function resolveProfileClouds(
  topGames: ProfileTopGame[],
  manualIds: readonly (number | null)[],
  gameById: Map<number, Game>,
  entries: readonly LibraryEntry[],
): ProfileCloud[] {
  const eligible = new Map(entries.filter(entry =>
    ['completed', 'playing', 'dropped'].includes(entry.status)).map(entry => [entry.gameId, entry]))
  const requested = manualIds.slice(0, 3).map(id =>
    typeof id === 'number' && eligible.has(id) && gameById.has(id) ? id : null)
  const pinned = new Set(requested.filter((id): id is number => id != null))
  const used = new Set<number>()
  let cursor = 0
  return [0, 1, 2].map(slot => {
    const manualId = requested[slot]
    if (manualId != null && !used.has(manualId)) {
      used.add(manualId)
      const entry = eligible.get(manualId)!
      return { game: gameById.get(manualId)!, score: typeof entry.score === 'number' &&
        ratedStatuses.has(entry.status) ? entry.score : null, manual: true }
    }
    while (cursor < topGames.length) {
      const candidate = topGames[cursor++]
      if (used.has(candidate.game.id) || pinned.has(candidate.game.id)) continue
      used.add(candidate.game.id)
      return { ...candidate, manual: false }
    }
    return null
  })
}
