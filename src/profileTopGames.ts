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
    .slice(0, 3)
}
