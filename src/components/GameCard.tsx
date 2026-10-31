import { forwardRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { isPlaythrough } from '../collectionModel'
import { statusMeta, statusIcons, ratedStatuses } from '../statusPresentation'
import type { Game, LibraryEntry } from '../data'
import Icon from './Icon'

function formatCardDate(value?: string) {
  if (!value) return ''
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}.${month}.${year}`
}

export function Cover({
  game,
  compact = false,
  thumbnail = false,
  priority = false,
  smoothLoad = false,
}: {
  game: Game
  compact?: boolean
  thumbnail?: boolean
  priority?: boolean
  smoothLoad?: boolean
}) {
  const [readyUrl, setReadyUrl] = useState<string | null>(null)
  const imageUrl = thumbnail
    ? game.coverUrl?.replace('/t_cover_big_2x/', '/t_cover_small/')
    : game.coverUrl
  const style = {
    '--cover-accent': game.accent,
    '--cover-accent-2': game.accent2,
  } as CSSProperties

  const imageReady = !smoothLoad || (imageUrl && readyUrl === imageUrl)
  return (
    <div className={'cover' + (compact ? ' cover--compact' : '') +
      (smoothLoad ? ' cover--smooth' : '') + (imageReady ? ' cover--image-ready' : '')}
      style={style}>
      {imageUrl && (
        <img
          className="cover__image"
          src={imageUrl}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : undefined}
          decoding="async"
          onLoad={smoothLoad ? () => setReadyUrl(imageUrl) : undefined}
          onError={smoothLoad ? () => setReadyUrl(imageUrl) : undefined}
        />
      )}
      {!game.coverUrl && <div className="cover__orb cover__orb--one" />}
      {!game.coverUrl && <div className="cover__orb cover__orb--two" />}
      {!game.coverUrl && <span className="cover__noise" />}
      {!game.coverUrl && <span className="cover__glyph">{game.glyph}</span>}
    </div>
  )
}

type GameCardProps = {
  game: Game
  entry: LibraryEntry
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void
  animationIndex?: number
  readOnly?: boolean
  quietPress?: boolean
  selectionMode?: boolean
  selected?: boolean
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerLeave?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

const GameCard = forwardRef<HTMLButtonElement, GameCardProps>(function GameCard({
  game,
  entry,
  onOpen,
  animationIndex = 0,
  readOnly = false,
  quietPress = false,
  selectionMode = false,
  selected = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
}, ref) {
  const shouldReduceMotion = useReducedMotion()
  const activityDate =
    ratedStatuses.has(entry.status) && entry.completedAt
      ? entry.completedAt
      : entry.status === 'playing' && entry.startedAt
        ? entry.startedAt
        : entry.addedAt

  return (
    <motion.button
      ref={ref}
      layout="position"
      className={[
        'game-card',
        quietPress && 'game-card--quiet-touch',
        selectionMode && 'game-card--selection-mode',
        selected && 'game-card--selected',
      ].filter(Boolean).join(' ')}
      disabled={readOnly}
      aria-pressed={selectionMode ? selected : undefined}
      aria-label={selectionMode ? `${game.title}, ${selected ? 'выбрано' : 'выбрать'}` : undefined}
      onClick={onOpen}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      initial={shouldReduceMotion ? false : { opacity: 0, y: 28, scale: .96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={shouldReduceMotion ? undefined : { opacity: 0, scale: .975 }}
      whileTap={shouldReduceMotion || quietPress ? undefined : { scale: .985 }}
      transition={{
        layout: { type: 'spring', stiffness: 430, damping: 34, mass: .72 },
        opacity: { duration: .3, delay: Math.min(animationIndex, 12) * .045 },
        scale: { type: 'spring', stiffness: 330, damping: 29, delay: Math.min(animationIndex, 12) * .045 },
        y: { type: 'spring', stiffness: 335, damping: 29, delay: Math.min(animationIndex, 12) * .045 },
      }}
    >
      <div className="game-card__cover-wrap">
        <Cover game={game} />
        {selectionMode && (
          <span className={selected
            ? 'game-card__selection game-card__selection--checked'
            : 'game-card__selection'} aria-hidden="true">
            {selected && <Icon name="check" size={16} />}
          </span>
        )}
        {entry.score != null && (
          <span className="score-badge">{entry.score.toFixed(1)}</span>
        )}
        {isPlaythrough(entry) && (
          <span className={`status-badge status-badge--${entry.status}`}>
            <Icon name={statusIcons[entry.status]} size={12} />
            <span className="status-badge__label">{statusMeta[entry.status].short}</span>
            <span className="status-badge__date">{formatCardDate(activityDate)}</span>
          </span>
        )}
      </div>
      <div className="game-card__body">
        <h3>{game.title}</h3>
      </div>
    </motion.button>
  )
})


export default GameCard
