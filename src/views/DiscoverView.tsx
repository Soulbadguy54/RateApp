import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import type { PanInfo, MotionStyle } from 'motion/react'
import { Cover } from '../components/GameCard'
import Icon from '../components/Icon'
import type { Game } from '../data'

type DiscoveryAction = 'like' | 'dislike' | 'wishlist'
type Direction = 'left' | 'right' | 'up'
type Feed = { items: Game[]; remaining: number }
type DescriptionTranslation = { description: string; language: 'ru' | 'en'; translated: boolean }
const STORE_ICONS: Record<string, string> = {
  steam: '/brand/steam.svg', epic: '/brand/epicgames.svg',
  gog: '/brand/gogdotcom.svg', itch: '/brand/itchdotio.svg',
  playstation: '/brand/playstation.svg', xbox: '/brand/xbox.svg',
  nintendo: '/brand/nintendoswitch.svg', youtube: '/brand/youtube.svg',
}
function ExternalIcon({ provider }: { provider: string }) {
  const src = STORE_ICONS[provider]
  return src
    ? <img src={src} className="detail-external-link__icon" alt="" aria-hidden="true" width={20} height={20} />
    : <Icon name="globe" size={20} />
}
type Pull = { pointerId: number; startY: number; startReveal: number; allowTap: boolean }

const HELP_KEY = 'rateapp-discovery-integrated-v3'
const getHelpKey = (nickname: string) => HELP_KEY + ':' + nickname.toLowerCase()
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function heroCoverUrl(url?: string): string | undefined {
  // Request a larger IGDB image for this poster only, never for catalog tiles.
  if (!url?.startsWith('https://images.igdb.com/igdb/image/upload/')) return url
  return url.replace(/\/t_cover_big_2x\//, '/t_1080p/')
}

function releaseLabel(game: Game) {
  if (!game.releaseDate) return game.year ? String(game.year) : 'Дата неизвестна'
  const date = new Date(game.releaseDate + 'T12:00:00')
  return Number.isNaN(date.getTime())
    ? String(game.year || 'Дата неизвестна')
    : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

export default function DiscoverView({
  nickname, onExit, onWishlistChange,
}: {
  nickname: string
  onExit: () => void
  onWishlistChange: () => void
}) {
  const reducedMotion = useReducedMotion()
  const [cards, setCards] = useState<Game[]>([])
  const [index, setIndex] = useState(0)
  const [history, setHistory] = useState<{ gameId: number; action: DiscoveryAction }[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [departure, setDeparture] = useState<Direction>('right')
  const [helpOpen, setHelpOpen] = useState(() => {
    try { return !localStorage.getItem(getHelpKey(nickname)) } catch { return true }
  })
  const [artworkReady, setArtworkReady] = useState(false)
  const [descriptions, setDescriptions] = useState<Record<number, DescriptionTranslation>>({})
  const [translationPendingId, setTranslationPendingId] = useState<number | null>(null)
  const [feedbackDirection, setFeedbackDirection] = useState<Direction | null>(null)
  const feedbackOpacity = useMotionValue(0)
  const feedbackAnimationRef = useRef<{ stop: () => void } | null>(null)
  const cardPivot = useMotionValue('center top')

  const stageRef = useRef<HTMLDivElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const [stageHeight, setStageHeight] = useState(550)
  const [summaryHeight, setSummaryHeight] = useState(74)
  // Keep the sheet independent of the keyed artwork: its top edge springs to
  // the actual bottom of each fitted poster, while its foot stays at the nav.
  const [posterBottom, setPosterBottom] = useState<number | null>(null)
  const posterNodeRef = useRef<HTMLElement | null>(null)
  const posterObserverRef = useRef<ResizeObserver | null>(null)
  const measurePoster = useCallback(() => {
    const poster = posterNodeRef.current
    const stage = stageRef.current
    if (!poster || !stage) return
    const art = poster.getBoundingClientRect()
    if (art.width < 1 || art.height < 1) return
    const bottom = art.bottom - stage.getBoundingClientRect().top
    setPosterBottom(previous => previous === null || Math.abs(previous - bottom) > .5 ? bottom : previous)
  }, [])
  const attachPoster = useCallback((node: HTMLElement | null) => {
    posterObserverRef.current?.disconnect()
    posterObserverRef.current = null
    posterNodeRef.current = node
    if (!node) return
    const observer = new ResizeObserver(measurePoster)
    posterObserverRef.current = observer
    observer.observe(node)
    measurePoster()
  }, [measurePoster])
  useEffect(() => () => posterObserverRef.current?.disconnect(), [])
  const mountedRef = useRef(true)
  const loadingRef = useRef(false)
  const pullRef = useRef<Pull | null>(null)
  const sheetAnimationRef = useRef<{ stop: () => void } | null>(null)
  const reveal = useMotionValue(0)
  const cardShift = useMotionValue(0)
  const cardTilt = useMotionValue(0)
  const cardLift = useMotionValue(0)
  const cardScale = useMotionValue(1)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height
      if (height && height > 0) setStageHeight(height)
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  // A full-stage-height sheet sits offscreen below its visible edge. When
  // closed, its top meets the poster's bottom; very tall posters retain enough
  // visible glass for the title, ratings and handle.
  const fullSheetHeight = stageHeight
  const minimumPeek = Math.min(stageHeight - 8, 33 + summaryHeight + 8)
  const peekHeight = Math.min(stageHeight - 8, Math.max(minimumPeek,
    posterBottom === null ? minimumPeek : stageHeight - posterBottom - 12))
  const collapsedTop = stageHeight - peekHeight
  // Opening still reveals at least 80% of the viewport, or more when the
  // poster is unusually short and the closed glass already fills most of it.
  const expandedTop = Math.min(stageHeight * .2, Math.max(0, collapsedTop - 72))
  const travel = Math.max(1, collapsedTop - expandedTop)
  const restingTop = useMotionValue(stageHeight - (33 + 74 + 8))
  const sheetY = useTransform(() => restingTop.get() * (1 - reveal.get()) + expandedTop * reveal.get())
  const visibleSheetHeight = useTransform(() => `${Math.max(0, stageHeight - sheetY.get())}px`)
  useEffect(() => {
    const movement = animate(restingTop, collapsedTop, reducedMotion
      ? { duration: 0 }
      : { type: 'spring', stiffness: 250, damping: 24, mass: .9 })
    return () => movement.stop()
  }, [collapsedTop, reducedMotion, restingTop])
  useEffect(() => { measurePoster() }, [stageHeight, measurePoster])
  const detailOpacity = useTransform(reveal, [0, .32, .98], [0, 0, 1])
  const detailRise = useTransform(reveal, [0, 1], [16, 0])

  const settleSheet = (open: boolean) => {
    sheetAnimationRef.current?.stop()
    setExpanded(open)
    sheetAnimationRef.current = animate(reveal, open ? 1 : 0, reducedMotion
      ? { duration: 0 }
      : { duration: .38, ease: [0.22, 1, 0.36, 1] })
  }

  const startPull = (id: number, y: number, target: EventTarget | null) => {
    if (busy || helpOpen || pullRef.current) return
    // Links must remain tappable in expanded details.
    const element = target instanceof Element ? target : null
    if (element?.closest('a') || (expanded && element?.closest('.discover-sheet__description'))) return
    sheetAnimationRef.current?.stop()
    pullRef.current = {
      pointerId: id, startY: y, startReveal: reveal.get(),
      allowTap: !!element?.closest('.discover-sheet__handle'),
    }
  }
  const movePull = (id: number, y: number) => {
    const pull = pullRef.current
    if (!pull || pull.pointerId !== id) return
    // Dead zone and gentle resistance prevent jerky half-screen pulls.
    const difference = pull.startY - y
    const useful = Math.sign(difference) * Math.max(0, Math.abs(difference) - 18)
    reveal.set(clamp(pull.startReveal + useful / (travel * 1.13), 0, 1))
  }
  const finishPull = (id: number, y: number) => {
    const pull = pullRef.current
    if (!pull || pull.pointerId !== id) return
    movePull(id, y)
    pullRef.current = null
    if (Math.abs(y - pull.startY) < 9) {
      // Tapping the chevron toggles; tapping text does not accidentally close.
      if (pull.allowTap) {
        if (expanded) settleSheet(false)
        else showDetails()
      }
      return
    }
    if (reveal.get() >= .46) void showDetails()
    else settleSheet(false)
  }
  const onPointerStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    startPull(event.pointerId, event.clientY, event.target)
  }
  const onMouseStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    startPull(-1, event.clientY, event.target)
  }
  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.touches.length) startPull(-2, event.touches[0].clientY, event.target)
  }

  useEffect(() => {
    // A moving transformed handle may lose capture on WebKit. Observe the same
    // pull on window until it is released, including mouse and native touch.
    const pointerMove = (event: PointerEvent) => {
      if (pullRef.current?.pointerId !== event.pointerId) return
      if (event.cancelable) event.preventDefault()
      movePull(event.pointerId, event.clientY)
    }
    const pointerUp = (event: PointerEvent) => finishPull(event.pointerId, event.clientY)
    const mouseMove = (event: MouseEvent) => {
      if (pullRef.current) movePull(pullRef.current.pointerId, event.clientY)
    }
    const mouseUp = (event: MouseEvent) => {
      if (pullRef.current) finishPull(pullRef.current.pointerId, event.clientY)
    }
    const touchMove = (event: TouchEvent) => {
      if (!pullRef.current || !event.touches.length) return
      if (event.cancelable) event.preventDefault()
      movePull(pullRef.current.pointerId, event.touches[0].clientY)
    }
    const touchEnd = (event: TouchEvent) => {
      if (pullRef.current && event.changedTouches.length)
        finishPull(pullRef.current.pointerId, event.changedTouches[0].clientY)
    }
    const pointerCancel = (event: PointerEvent) => {
      if (pullRef.current?.pointerId !== event.pointerId) return
      pullRef.current = null
      settleSheet(expanded)
    }
    window.addEventListener('pointermove', pointerMove, { passive: false })
    window.addEventListener('pointerup', pointerUp)
    window.addEventListener('pointercancel', pointerCancel)
    window.addEventListener('mousemove', mouseMove)
    window.addEventListener('mouseup', mouseUp)
    window.addEventListener('touchmove', touchMove, { passive: false })
    window.addEventListener('touchend', touchEnd)
    return () => {
      window.removeEventListener('pointermove', pointerMove)
      window.removeEventListener('pointerup', pointerUp)
      window.removeEventListener('pointercancel', pointerCancel)
      window.removeEventListener('mousemove', mouseMove)
      window.removeEventListener('mouseup', mouseUp)
      window.removeEventListener('touchmove', touchMove)
      window.removeEventListener('touchend', touchEnd)
    }
  })

  const loadFeed = useCallback(async (initial = false) => {
    if (loadingRef.current) return
    loadingRef.current = true
    if (initial) setLoading(true)
    else setLoadingMore(true)
    try {
      const response = await fetch('/api/discover/feed', { credentials: 'same-origin' })
      if (!response.ok) throw new Error('Не удалось загрузить рекомендации.')
      const data = await response.json() as Feed
      if (!mountedRef.current) return
      setRemaining(data.remaining)
      setCards(previous => {
        const seen = new Set(previous.map(item => item.id))
        const added = data.items.filter(item => !seen.has(item.id))
        return initial ? data.items : [...previous, ...added]
      })
      setError('')
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить игры.')
    } finally {
      loadingRef.current = false
      if (mountedRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadFeed(true)
    return () => {
      mountedRef.current = false
      sheetAnimationRef.current?.stop()
      feedbackAnimationRef.current?.stop()
    }
  }, [loadFeed])

  const game = cards[index]
  useEffect(() => {
    if (!expanded || !game?.id || descriptions[game.id]) return
    const id = game.id
    const fallbackDescription = game.summary || game.storyline || ''
    const controller = new AbortController()
    setTranslationPendingId(id)
    fetch('/api/discover/description/' + id + '?lang=ru', {
      credentials: 'same-origin', signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error('Description translation unavailable')
        return response.json() as Promise<DescriptionTranslation>
      })
      .then(translation => setDescriptions(previous => ({ ...previous, [id]: translation })))
      .catch(() => {
        if (!controller.signal.aborted) setDescriptions(previous => ({
          ...previous, [id]: { description: fallbackDescription, language: 'en', translated: false },
        }))
      })
      .finally(() => {
        if (!controller.signal.aborted) setTranslationPendingId(previous => previous === id ? null : previous)
      })
    return () => controller.abort()
  }, [expanded, game?.id, descriptions])
  useEffect(() => {
    const summary = summaryRef.current
    if (!summary) return
    const measure = () => {
      const height = summary.getBoundingClientRect().height
      if (height > 0) setSummaryHeight(previous => Math.abs(previous - height) > .5 ? height : previous)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(summary)
    return () => observer.disconnect()
  }, [game?.id])
  useEffect(() => {
    if (!game) return
    setArtworkReady(false)
    // Allow the underlying card to paint before the first-use glass tutorial.
    const timeout = window.setTimeout(() => setArtworkReady(true), 520)
    return () => window.clearTimeout(timeout)
  }, [game?.id])

  useEffect(() => {
    if (!loading && cards.length - index <= 5 && remaining > cards.length - index && !loadingMore && !error) {
      void loadFeed()
    }
  }, [cards.length, index, remaining, loading, loadingMore, error, loadFeed])

  const showDetails = () => {
    if (!game || busy || helpOpen) return
    // Everything already arrived with the local feed. No network request.
    settleSheet(true)
  }

  const showSwipeFeedback = (direction: Direction, strength: number, release = false) => {
    if (reducedMotion) return
    feedbackAnimationRef.current?.stop()
    setFeedbackDirection(direction)
    feedbackOpacity.set(strength)
    if (release) feedbackAnimationRef.current = animate(feedbackOpacity, 0,
      { duration: .6, ease: [0.22, 1, 0.36, 1] })
  }

  const resetTilt = () => {
    const transition = reducedMotion ? { duration: 0 } : { duration: .22, ease: 'easeOut' as const }
    animate(cardShift, 0, transition)
    animate(cardTilt, 0, transition)
    animate(cardLift, 0, transition)
    animate(cardScale, 1, transition)
    cardPivot.set('center top')
  }
  const decide = async (action: DiscoveryAction) => {
    if (!game || busy || helpOpen || expanded || pullRef.current || reveal.get() > .03) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/discover/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: game.id, action }),
      })
      if (!response.ok) throw new Error('Не получилось сохранить свайп — попробуй ещё раз.')
      setDeparture(action === 'like' ? 'right' : action === 'dislike' ? 'left' : 'up')
      setHistory(previous => [...previous, { gameId: game.id, action }])
      setIndex(value => value + 1)
      if (action === 'wishlist') onWishlistChange()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка соединения.')
    } finally {
      resetTilt()
      setBusy(false)
    }
  }

  const undo = async () => {
    const last = history[history.length - 1]
    if (!last || busy || expanded || helpOpen) return
    setBusy(true)
    try {
      const response = await fetch('/api/discover/feedback/' + last.gameId, { method: 'DELETE' })
      if (!response.ok) throw new Error('Не получилось отменить свайп.')
      setHistory(current => current.slice(0, -1))
      setIndex(value => Math.max(0, value - 1))
      if (last.action === 'wishlist') onWishlistChange()
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка соединения.')
    } finally {
      setBusy(false)
    }
  }

  const onPosterPan = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (busy || expanded || helpOpen || pullRef.current) return
    const { x, y } = info.offset
    if (y < -5 && Math.abs(y) > Math.abs(x) * 1.15) {
      cardPivot.set('center top')
      cardLift.set(clamp(y * .21, -32, 0))
      cardScale.set(1)
      cardShift.set(0)
      cardTilt.set(0)
      showSwipeFeedback('up', clamp((Math.abs(y) - 12) / 115, 0, .8))
    } else if (Math.abs(x) > 5 && Math.abs(x) > Math.abs(y) * 1.1) {
      cardPivot.set(x < 0 ? 'right top' : 'left top')
      cardShift.set(clamp(x * .22, -32, 32))
      cardTilt.set(clamp(x * .034, -5.8, 5.8))
      cardLift.set(0)
      cardScale.set(1)
      showSwipeFeedback(x > 0 ? 'right' : 'left', clamp((Math.abs(x) - 12) / 100, 0, .84))
    }
  }
  const onPosterPanEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (busy || expanded || helpOpen || pullRef.current || reveal.get() > .03) {
      resetTilt()
      return
    }
    const { x, y } = info.offset
    const up = y < -120 && Math.abs(y) > Math.abs(x) * 1.16
    const sideways = Math.abs(x) > 115 && Math.abs(x) > Math.abs(y) * 1.12
    if (up || sideways) {
      const direction = up ? 'up' : x > 0 ? 'right' : 'left'
      showSwipeFeedback(direction, 1, true)
      void decide(up ? 'wishlist' : x > 0 ? 'like' : 'dislike')
    } else {
      feedbackAnimationRef.current?.stop()
      feedbackAnimationRef.current = animate(feedbackOpacity, 0, { duration: .22 })
    }
    resetTilt()
  }

  const dismissHelp = () => {
    setHelpOpen(false)
    try { localStorage.setItem(getHelpKey(nickname), '1') } catch { /* Storage blocked */ }
  }
  const currentDetails = game

  return (
    <section className="discover-screen" aria-label="Персональные рекомендации игр">
      <header className="discover-topbar">
        <button type="button" className="discover-icon-button" aria-label="Вернуться в базу игр" onClick={onExit}>
          <Icon name="back" size={22} />
        </button>
        {history.length > 0 && !expanded && (
          <button type="button" className="discover-icon-button discover-icon-button--undo"
            aria-label="Шаг назад" onClick={() => void undo()} disabled={busy || helpOpen}>↶</button>
        )}
        <button type="button" className="discover-icon-button discover-icon-button--info"
          aria-label="Показать обучение" onClick={() => setHelpOpen(true)}>i</button>
      </header>

      <div className="discover-stage" ref={stageRef} aria-live="polite"
        style={{ '--discover-min-peek': `${minimumPeek}px` } as CSSProperties}>
        {loading ? (
          <div className="discover-state" role="status"><span className="discover-loader" />Подбираем игры…</div>
        ) : !game ? (
          <div className="discover-state">
            <span className="discover-state__icon">✦</span>
            <h2>Пока всё просмотрено</h2>
            <p>Новые варианты появятся, когда каталог пополнится.</p>
            <button type="button" onClick={() => { setCards([]); setIndex(0); void loadFeed(true) }}>Обновить ленту</button>
          </div>
        ) : (
          <>
          <AnimatePresence mode="wait" initial={false} custom={departure}>
            <motion.div key={game.id} className="discover-deck"
              initial={reducedMotion ? false : { opacity: 0, scale: .993 }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              variants={{ exit: (direction: Direction) => reducedMotion
                ? { opacity: 0 }
                : direction === 'right'
                  ? { x: '115%', opacity: 0, rotate: 7 }
                  : direction === 'left'
                    ? { x: '-115%', opacity: 0, rotate: -7 }
                    : { y: '-110%', opacity: 0, scale: .95 },
              }}
              exit="exit"
              transition={{ duration: .36, ease: [0.22, 1, 0.36, 1] }}>
              <motion.div className="discover-artwork"
                style={{ x: cardShift, y: cardLift, scale: cardScale, rotate: cardTilt, transformOrigin: cardPivot }}>
                <div className="discover-cover" aria-hidden="true">
                  {game.coverUrl ? (
                    <img ref={attachPoster} onLoad={measurePoster} className="discover-cover__image" src={heroCoverUrl(game.coverUrl)}
                      alt="" loading="eager" fetchPriority="high" decoding="async" />
                  ) : (
                    <div ref={attachPoster} className="discover-cover__fallback"><Cover game={game} priority /></div>
                  )}
                </div>
                <motion.div
                  className="discover-cover__gesture"
                  onPan={onPosterPan}
                  onPanEnd={onPosterPanEnd}
                  aria-label={'Свайпы для игры ' + game.title}
                />
                {!helpOpen && !expanded && (
                  <div className="discover-hints" aria-hidden="true">
                    <span className="discover-hint discover-hint--up">↑ Хочу поиграть</span>
                    <span className="discover-hint discover-hint--left">← Не нравится</span>
                    <span className="discover-hint discover-hint--right">Нравится →</span>
                  </div>
                )}
              </motion.div>

            </motion.div>
          </AnimatePresence>
              <motion.div className={expanded ? 'discover-sheet discover-sheet--expanded' : 'discover-sheet'}
                  style={{ height: fullSheetHeight, y: sheetY, '--sheet-visible-height': visibleSheetHeight } as MotionStyle}
                  onPointerDown={onPointerStart}
                  onMouseDown={onMouseStart}
                  onTouchStart={onTouchStart}
                  onPanEnd={(event, info) => {
                    if (expanded && event.target instanceof Element &&
                        event.target.closest('.discover-sheet__description')) return
                    // Motion sees continuous pointer gestures even when native
                    // scrolling or a transformed panel interrupts the pointer-up
                    // fallback. Keep the same deliberate distance threshold.
                    const distance = info.offset.y
                    if (Math.abs(distance) < Math.max(125, travel * .42) ||
                        Math.abs(distance) < Math.abs(info.offset.x) * 1.15) return
                    pullRef.current = null
                    if (distance > 0 && expanded) settleSheet(false)
                    else if (distance < 0 && !expanded) showDetails()
                  }}>
                  <button type="button" className="discover-sheet__handle"
                    aria-label={expanded ? 'Свернуть подробности' : 'Развернуть подробности'}
                    aria-expanded={expanded}>
                    <span className={expanded ? 'discover-sheet__chevron discover-sheet__chevron--down' : 'discover-sheet__chevron'} />
                  </button>
                  <div className="discover-sheet__body">
                    <div className="discover-sheet__summary-row" ref={summaryRef}>
                      <div className="discover-sheet__identity">
                        <h2>{game.title}</h2>
                        <p>{releaseLabel(game)}</p>
                        <p>{game.genres.slice(0, 2).join(' · ') || 'Жанр не указан'}</p>
                      </div>
                      <div className="discover-sheet__ratings" aria-label="Рейтинги игры">
                        <span className="discover-rating discover-rating--igdb"><small>IGDB</small><strong>{game.igdbRating || '—'}</strong></span>
                        <span className="discover-rating discover-rating--rateapp"><small>Rate APP</small><strong>{game.communityRating || '—'}</strong></span>
                      </div>
                    </div>
                    <motion.div className="discover-sheet__extra"
                      style={{ opacity: detailOpacity, y: detailRise, pointerEvents: expanded ? 'auto' : 'none' }}
                      aria-hidden={!expanded}>
                      {!!game.platforms.length && <p className="discover-sheet__platforms">{game.platforms.slice(0, 4).join(' · ')}</p>}
                      {(!!currentDetails?.storeLinks?.length || !!currentDetails?.trailerUrl) && (
                        <div className="discover-sheet__links" aria-label="Магазины и трейлер">
                          {currentDetails.storeLinks?.map(link => (
                            <a key={link.provider}
                              className={`detail-external-link detail-external-link--${link.provider}`}
                              href={link.url} target="_blank" rel="noopener noreferrer"
                              title={link.label} aria-label={`Открыть ${link.label}`}>
                              <ExternalIcon provider={link.provider} />
                            </a>
                          ))}
                          {!!currentDetails.trailerUrl && <a className="detail-external-link detail-external-link--trailer"
                            href={currentDetails.trailerUrl} target="_blank" rel="noopener noreferrer"
                            title="Смотреть трейлер" aria-label="Смотреть трейлер на YouTube">
                            <ExternalIcon provider="youtube" />
                          </a>}
                        </div>
                      )}
                      <div className="discover-sheet__description" role="region" tabIndex={0}
                        aria-label="Описание игры">
                        {translationPendingId === game.id && !descriptions[game.id]
                          ? 'Переводим описание…'
                          : descriptions[game.id]?.description || currentDetails?.summary || currentDetails?.storyline || 'Описание пока не загружено в каталог.'}
                        {descriptions[game.id]?.language === 'en' && !!descriptions[game.id]?.description && (
                          <span className="discover-sheet__translation-note">Оригинал на английском — перевод временно недоступен</span>
                        )}
                      </div>
                    </motion.div>
                  </div>
                </motion.div>
          </>
        )}
        {!loading && !!game && feedbackDirection && (
          <motion.div className={`discover-swipe-feedback discover-swipe-feedback--${feedbackDirection}`}
            style={{ opacity: feedbackOpacity }} aria-hidden="true">
            <span>{feedbackDirection === 'up' ? 'Хочу поиграть' : feedbackDirection === 'left' ? 'Не нравится' : 'Нравится'}</span>
          </motion.div>
        )}
        {error && <div className="discover-error" role="alert">{error}</div>}
        <AnimatePresence>
          {helpOpen && game && artworkReady && !loading && (
            <motion.div className="discover-guide" role="dialog" aria-modal="true" aria-label="Обучение рекомендациям"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }} transition={{ duration: .32 }}>
              <motion.div className="discover-guide__backdrop"
                initial={{ backdropFilter: 'blur(0px)', backgroundColor: 'rgba(6,10,23,0)' }}
                animate={{ backdropFilter: 'blur(7px)', backgroundColor: 'rgba(6,10,23,.32)' }}
                exit={{ backdropFilter: 'blur(0px)', backgroundColor: 'rgba(6,10,23,0)' }}
                transition={{ duration: .52, ease: [0.22, 1, 0.36, 1] }} />
              {/* Full-screen invisible dismissal target: no framed card or visible
                  action button. First poster stays in place behind the blur. */}
              <button type="button" className="discover-guide__dismiss"
                aria-label="Закрыть обучение" onClick={dismissHelp} />
              <div className="discover-guide__directions" aria-hidden="true">
                <div className="discover-guide__direction discover-guide__direction--up">
                  <strong>↑ Хочу поиграть</strong><span>В список желаемого</span>
                </div>
                <div className="discover-guide__direction discover-guide__direction--left">
                  <strong>← Не нравится</strong><span>Меньше похожих</span>
                </div>
                <div className="discover-guide__direction discover-guide__direction--right">
                  <strong>Нравится →</strong><span>Больше похожих</span>
                </div>
              </div>
              <div className="discover-guide__intro">
                <h2>Новые игры для тебя</h2>
                <p>Подбираем игры по твоим оценкам и предпочтениям. Листай обложки жестами — так рекомендации становятся точнее.</p>
                <p className="discover-guide__detail-tip">Потяни стеклянную панель вверх, чтобы узнать об игре больше.</p>
              </div>
              <p className="discover-guide__tap-hint" aria-hidden="true">Коснись экрана, чтобы продолжить</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}
