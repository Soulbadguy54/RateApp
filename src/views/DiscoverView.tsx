import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import type { PanInfo, MotionStyle } from 'motion/react'
import { Cover } from '../components/GameCard'
import { WishlistHeart } from '../components/CollectionAppearance'
import Icon from '../components/Icon'
import type { Game } from '../data'

type DiscoveryAction = 'like' | 'dislike' | 'wishlist'
type Direction = 'left' | 'right' | 'up' | 'down'
type Feed = { items: Game[]; remaining: number }
type DescriptionTranslation = { description: string; language: 'ru' | 'en'; translated: boolean }
type PosterState = { width: number; height: number; failed?: boolean }
type PosterBounds = {
  index: number; left: number; top: number; width: number; height: number
  screenLeft: number; screenTop: number
}
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
type Pull = {
  pointerId: number; startY: number; startReveal: number; allowTap: boolean
  samples: { y: number; time: number }[]
}

const HELP_KEY = 'rateapp-discovery-integrated-v3'
const getHelpKey = (nickname: string) => HELP_KEY + ':' + nickname.toLowerCase()
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function heroCoverUrl(url?: string): string | undefined {
  // Reuse the feed's high-density cover URL instead of downloading a much
  // heavier 1080p duplicate on mobile. It is shared with the catalog cache.
  return url
}

function releaseLabel(game: Game) {
  if (!game.releaseDate) return game.year ? String(game.year) : 'Дата неизвестна'
  const date = new Date(game.releaseDate + 'T12:00:00')
  return Number.isNaN(date.getTime())
    ? String(game.year || 'Дата неизвестна')
    : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

export default function DiscoverView({
  nickname, onExit, onWishlistChange, onAddPlaythrough,
}: {
  nickname: string
  onExit: () => void
  onWishlistChange: () => void
  onAddPlaythrough: (game: Game) => void
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
  const [posters, setPosters] = useState<Record<string, PosterState>>({})
  const preloadedPostersRef = useRef(new Map<string, HTMLImageElement>())
  const [descriptions, setDescriptions] = useState<Record<number, DescriptionTranslation>>({})
  const [translationPendingId, setTranslationPendingId] = useState<number | null>(null)
  const [feedbackDirection, setFeedbackDirection] = useState<Direction | null>(null)
  const feedbackOpacity = useMotionValue(0)
  // Words are deliberately much brighter than the translucent edge atmosphere.
  const feedbackLabelOpacity = useTransform(feedbackOpacity, value => clamp(value * 2.7, 0, 1))
  const feedbackAnimationRef = useRef<{ stop: () => void } | null>(null)
  const feedbackHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardPivot = useMotionValue('center top')
  const cardResetRef = useRef<{ stop: () => void }[]>([])

  const stageRef = useRef<HTMLDivElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const [stageHeight, setStageHeight] = useState(550)
  const [summaryHeight, setSummaryHeight] = useState(74)
  // Keep the sheet independent of the keyed artwork: its top edge springs to
  // the actual bottom of each fitted poster, while its foot stays at the nav.
  const [posterBottom, setPosterBottom] = useState<number | null>(null)
  const [posterBounds, setPosterBounds] = useState<PosterBounds | null>(null)
  const posterNodeRef = useRef<HTMLElement | null>(null)
  const posterObserverRef = useRef<ResizeObserver | null>(null)
  const measurePoster = useCallback(() => {
    const poster = posterNodeRef.current
    const stage = stageRef.current
    if (!poster || !stage) return
    const art = poster.getBoundingClientRect()
    if (art.width < 1 || art.height < 1) return
    const stageRect = stage.getBoundingClientRect()
    const screenRect = stage.closest('.discover-screen')?.getBoundingClientRect() ?? stageRect
    const bottom = art.bottom - stageRect.top
    const nextBounds: PosterBounds = {
      index, left: art.left - stageRect.left, top: art.top - stageRect.top,
      width: art.width, height: art.height,
      screenLeft: art.left - screenRect.left, screenTop: art.top - screenRect.top,
    }
    setPosterBottom(previous => previous === null || Math.abs(previous - bottom) > .5 ? bottom : previous)
    setPosterBounds(previous => previous && previous.index === nextBounds.index &&
      Math.abs(previous.left - nextBounds.left) < .5 &&
      Math.abs(previous.top - nextBounds.top) < .5 &&
      Math.abs(previous.width - nextBounds.width) < .5 &&
      Math.abs(previous.height - nextBounds.height) < .5
      ? previous : nextBounds)
  }, [index])
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
  // Smooth over individual pointer events and changes in velocity/axis.
  // Transform values remain continuous when reversing within one swipe.
  const smoothShift = useSpring(cardShift, { stiffness: 295, damping: 36, mass: .72 })
  const smoothTilt = useSpring(cardTilt, { stiffness: 275, damping: 34, mass: .72 })
  const smoothLift = useSpring(cardLift, { stiffness: 295, damping: 36, mass: .72 })
  const smoothScale = useSpring(cardScale, { stiffness: 295, damping: 36, mass: .72 })
  const panAxisRef = useRef<'horizontal' | 'vertical' | null>(null)

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
      samples: [{ y, time: performance.now() }],
    }
  }
  const movePull = (id: number, y: number) => {
    const pull = pullRef.current
    if (!pull || pull.pointerId !== id) return
    // Dead zone and gentle resistance prevent jerky half-screen pulls.
    const now = performance.now()
    pull.samples.push({ y, time: now })
    while (pull.samples.length > 2 && now - pull.samples[0].time > 110) pull.samples.shift()
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
    // Quick deliberate flicks complete the gesture without a long drag.
    // Require real movement to avoid treating small taps as fast flicks.
    const distance = y - pull.startY
    const first = pull.samples[0]
    const last = pull.samples[pull.samples.length - 1]
    const elapsed = last.time - first.time
    const velocity = elapsed >= 12 ? (last.y - first.y) / elapsed : 0 // px/ms
    const flick = Math.abs(distance) >= 50 && Math.abs(velocity) >= .48
    if (!expanded && (reveal.get() >= .46 || (distance < 0 && flick && velocity < 0))) {
      void showDetails()
    } else if (expanded && (reveal.get() <= .54 || (distance > 0 && flick && velocity > 0))) {
      settleSheet(false)
    } else {
      settleSheet(expanded)
    }
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
      if (feedbackHoldRef.current) window.clearTimeout(feedbackHoldRef.current)
      for (const control of cardResetRef.current) control.stop()
      preloadedPostersRef.current.clear()
    }
  }, [loadFeed])

  const game = cards[index]
  const activePosterBounds = posterBounds?.index === index ? posterBounds : null
  const posterUrl = heroCoverUrl(game?.coverUrl)
  const posterState = posterUrl ? posters[posterUrl] : undefined

  useEffect(() => {
    // Prefetch and decode the visible cover plus three upcoming cards. Keep the
    // decoded Image objects nearby: a fast flick should not wait on the CDN.
    const upcoming = cards.slice(Math.max(0, index - 1), index + 4)
    const urls = new Set(upcoming.map(item => heroCoverUrl(item.coverUrl)).filter((url): url is string => !!url))
    const cached = preloadedPostersRef.current
    for (const url of urls) {
      if (cached.has(url)) continue
      const picture = new Image()
      picture.decoding = 'async'
      cached.set(url, picture)
      picture.onload = () => {
        const done = () => {
          if (!mountedRef.current || !picture.naturalWidth || !picture.naturalHeight) return
          setPosters(previous => previous[url] ? previous : {
            ...previous, [url]: { width: picture.naturalWidth, height: picture.naturalHeight },
          })
        }
        // decode() is supported in Chromium and WebKit; the fallback still
        // gives slow connections a complete image before the fade-in.
        if (picture.decode) void picture.decode().then(done, done)
        else done()
      }
      picture.onerror = () => {
        if (mountedRef.current) setPosters(previous => ({
          ...previous, [url]: { width: 0, height: 0, failed: true },
        }))
      }
      picture.src = url
    }
    // Do not accumulate full-size decoded covers while swiping a long feed.
    for (const [url, picture] of cached) {
      if (urls.has(url) || cached.size <= 5) continue
      picture.onload = null
      picture.onerror = null
      cached.delete(url)
    }
  }, [cards, index])

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
    if (feedbackHoldRef.current) window.clearTimeout(feedbackHoldRef.current)
    setFeedbackDirection(previous => previous === direction ? previous : direction)
    feedbackOpacity.set(strength)
    if (release) {
      // Retain the label and glow over the next card, then fade smoothly.
      feedbackHoldRef.current = window.setTimeout(() => {
        feedbackHoldRef.current = null
        feedbackAnimationRef.current = animate(feedbackOpacity, 0,
          { duration: .7, ease: [0.22, 1, 0.36, 1] })
      }, 550)
    }
  }

  const stopCardReset = () => {
    for (const control of cardResetRef.current) control.stop()
    cardResetRef.current = []
  }
  const resetTilt = () => {
    stopCardReset()
    // A spring follows these targets; don't start four competing tweens.
    cardShift.set(0)
    cardTilt.set(0)
    cardLift.set(0)
    cardScale.set(1)
  }
  const resetAfterCardExit = () => {
    // The old card has left. Snap shared springs only while no art is visible,
    // so the next card never inherits its tilt or has a mid-exit reset jerk.
    resetTilt()
    smoothShift.jump(0)
    smoothTilt.jump(0)
    smoothLift.jump(0)
    smoothScale.jump(1)
  }
  const decide = async (action: DiscoveryAction) => {
    if (!game || busy || helpOpen || expanded || pullRef.current || reveal.get() > .03) return
    let saved = false
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/discover/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: game.id, action }),
      })
      if (!response.ok) throw new Error('Не получилось сохранить свайп — попробуй ещё раз.')
      const direction = action === 'like' ? 'right' : action === 'dislike' ? 'left' : 'up'
      saved = true
      setDeparture(direction)
      showSwipeFeedback(direction, 1, true)
      setHistory(previous => [...previous, { gameId: game.id, action }])
      setIndex(value => value + 1)
      if (action === 'wishlist') onWishlistChange()
    } catch (reason) {
      feedbackAnimationRef.current?.stop()
      feedbackAnimationRef.current = animate(feedbackOpacity, 0, { duration: .22 })
      setError(reason instanceof Error ? reason.message : 'Ошибка соединения.')
    } finally {
      // Never animate the dragged art back to centre while it is also exiting.
      if (!saved) resetTilt()
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
    // Lock only the AXIS (not the sign): a user can reverse direction smoothly
    // without switching translate/rotate models mid-gesture.
    if (!panAxisRef.current) {
      if (Math.hypot(x, y) < 12) return
      panAxisRef.current = Math.abs(y) > Math.abs(x) * 1.12 ? 'vertical' : 'horizontal'
    }
    if (panAxisRef.current === 'vertical') {
      cardLift.set(clamp(y * .42, -105, 105))
      cardShift.set(0)
      cardTilt.set(0)
      cardScale.set(1 - clamp(Math.abs(y) / 1600, 0, .07))
      if (Math.abs(y) > 12) {
        showSwipeFeedback(y < 0 ? 'up' : 'down', clamp((Math.abs(y) - 10) / 115, 0, .82))
      } else {
        feedbackOpacity.set(0)
      }
    } else {
      cardShift.set(clamp(x * .48, -stageHeight * .34, stageHeight * .34))
      cardTilt.set(clamp(x * .019, -6.5, 6.5))
      cardLift.set(0)
      cardScale.set(1 - clamp(Math.abs(x) / 2400, 0, .045))
      if (Math.abs(x) > 10) {
        showSwipeFeedback(x > 0 ? 'right' : 'left', clamp((Math.abs(x) - 10) / 115, 0, .82))
      } else {
        feedbackOpacity.set(0)
      }
    }
  }
  const onPosterPanEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const axis = panAxisRef.current
    panAxisRef.current = null
    if (busy || expanded || helpOpen || pullRef.current || reveal.get() > .03) {
      resetTilt()
      return
    }
    const { x, y } = info.offset
    const up = axis === 'vertical' && y < -120
    const down = axis === 'vertical' && y > 120
    const sideways = axis === 'horizontal' && Math.abs(x) > 115
    if (down && game) {
      // Navigation, not feedback: do not consume this recommendation or
      // add an invented playthrough. The existing add form handles validation.
      onAddPlaythrough(game)
      return
    }
    if (up || sideways) {
      const direction = up ? 'up' : x > 0 ? 'right' : 'left'
      showSwipeFeedback(direction, 1)
      void decide(up ? 'wishlist' : x > 0 ? 'like' : 'dislike')
      return
    }
    feedbackAnimationRef.current?.stop()
    feedbackAnimationRef.current = animate(feedbackOpacity, 0, { duration: .24 })
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
          <AnimatePresence mode="wait" initial={false} custom={departure}
            onExitComplete={resetAfterCardExit}>
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
                style={{
                  x: reducedMotion ? cardShift : smoothShift,
                  y: reducedMotion ? cardLift : smoothLift,
                  scale: reducedMotion ? cardScale : smoothScale,
                  rotate: reducedMotion ? cardTilt : smoothTilt,
                  transformOrigin: cardPivot,
                }}>
                <div className="discover-cover" aria-hidden="true">
                  {posterUrl && !posterState?.failed ? (
                    <>
                      {!posterState && <div className="discover-cover__skeleton" data-testid="poster-loading" />}
                      <img ref={attachPoster}
                        onLoad={event => {
                          const element = event.currentTarget
                          const done = () => {
                            if (!element.isConnected || !element.naturalWidth || !element.naturalHeight) return
                            setPosters(previous => previous[posterUrl]?.failed ? previous : {
                              ...previous, [posterUrl]: {
                                width: element.naturalWidth, height: element.naturalHeight,
                              },
                            })
                            measurePoster()
                          }
                          if (element.decode) void element.decode().then(done, done)
                          else done()
                        }}
                        onError={() => setPosters(previous => ({
                          ...previous, [posterUrl]: { width: 0, height: 0, failed: true },
                        }))}
                        className={posterState ? 'discover-cover__image discover-cover__image--ready' : 'discover-cover__image'}
                        src={posterUrl} width={posterState?.width || undefined} height={posterState?.height || undefined}
                        alt="" loading="eager" fetchPriority="high" decoding="async" />
                    </>
                  ) : (
                    <div ref={attachPoster} className="discover-cover__fallback"><Cover game={game} priority /></div>
                  )}
                </div>
                <motion.div
                  className="discover-cover__gesture"
                  onPanStart={() => { panAxisRef.current = null; resetTilt() }}
                  onPan={onPosterPan}
                  onPanEnd={onPosterPanEnd}
                  aria-label={'Свайпы для игры ' + game.title}
                />
                {!helpOpen && !expanded && (
                  <div className="discover-hints" aria-hidden="true"
                    style={activePosterBounds ? {
                      left: activePosterBounds.left, top: activePosterBounds.top,
                      width: activePosterBounds.width, height: activePosterBounds.height,
                    } : { visibility: 'hidden' }}>
                    <span className="discover-hint discover-hint--up">↑ <WishlistHeart size={13} /> Хочу поиграть</span>
                    <span className="discover-hint discover-hint--left">← Не нравится</span>
                    <span className="discover-hint discover-hint--right">Нравится →</span>
                    <span className="discover-hint discover-hint--down">↓ Добавить прохождение</span>
                  </div>
                )}
              </motion.div>

            </motion.div>
          </AnimatePresence>
              <motion.div className={expanded ? 'discover-sheet discover-sheet--expanded' : 'discover-sheet'}
                  style={{ height: fullSheetHeight, y: sheetY, '--sheet-visible-height': visibleSheetHeight } as MotionStyle}
                  onPointerDown={onPointerStart}
                  onMouseDown={onMouseStart}
                  onTouchStart={onTouchStart}>
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
        {error && <div className="discover-error" role="alert">{error}</div>}
        <AnimatePresence>
          {helpOpen && game && artworkReady && !loading && (
            <motion.div className="discover-guide" role="dialog" aria-modal="true" aria-label="Обучение рекомендациям"
              initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : .2 }}>
              <motion.div className="discover-guide__backdrop"
                initial={reducedMotion ? false : { backdropFilter: 'blur(0px)', backgroundColor: 'rgba(6,10,23,0)' }}
                animate={{ backdropFilter: 'blur(7px)', backgroundColor: 'rgba(6,10,23,.32)' }}
                exit={{ backdropFilter: 'blur(0px)', backgroundColor: 'rgba(6,10,23,0)' }}
                transition={{ duration: reducedMotion ? 0 : .24, ease: [0.22, 1, 0.36, 1] }} />
              {/* Full-screen invisible dismissal target: no framed card or visible
                  action button. First poster stays in place behind the blur. */}
              <button type="button" className="discover-guide__dismiss"
                aria-label="Закрыть обучение" onClick={dismissHelp} />
              <motion.div className="discover-guide__content"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: reducedMotion ? 0 : .2, duration: reducedMotion ? 0 : .25 }}>
              <div className="discover-guide__directions" aria-hidden="true"
                style={activePosterBounds ? {
                  left: activePosterBounds.left, top: activePosterBounds.top,
                  width: activePosterBounds.width, height: activePosterBounds.height,
                } : { inset: 0 }}>
                <div className="discover-guide__direction discover-guide__direction--up">
                  <strong>↑ <WishlistHeart size={14} /> Хочу поиграть</strong><span>В список желаемого</span>
                </div>
                <div className="discover-guide__direction discover-guide__direction--left">
                  <strong>← Не нравится</strong><span>Меньше похожих</span>
                </div>
                <div className="discover-guide__direction discover-guide__direction--right">
                  <strong>Нравится →</strong><span>Больше похожих</span>
                </div>
                <div className="discover-guide__direction discover-guide__direction--down">
                  <strong>↓ Добавить прохождение</strong><span>Открыть форму игры</span>
                </div>
              </div>
              <div className="discover-guide__intro">
                <h2>Новые игры для тебя</h2>
                <p>Подбираем игры по твоим оценкам и предпочтениям. Листай обложки жестами — так рекомендации становятся точнее.</p>
                <p className="discover-guide__detail-tip">Потяни стеклянную панель вверх, чтобы узнать об игре больше.</p>
              </div>
              <p className="discover-guide__tap-hint" aria-hidden="true">Коснись экрана, чтобы продолжить</p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {!helpOpen && feedbackDirection && (
        <div className={`discover-swipe-feedback discover-swipe-feedback--${feedbackDirection}`}
          aria-hidden="true">
          <motion.div className="discover-swipe-feedback__haze" style={{ opacity: feedbackOpacity }} />
          <motion.span className="discover-swipe-feedback__label"
            style={{
              opacity: feedbackLabelOpacity,
              ...(activePosterBounds ? {
                left: activePosterBounds.screenLeft + activePosterBounds.width / 2,
                top: activePosterBounds.screenTop + activePosterBounds.height / 2,
              } : {}),
            }}>
            {feedbackDirection === 'up' ? <><WishlistHeart size={26} /> Хочу поиграть</> :
              feedbackDirection === 'down' ? 'Добавить прохождение' :
                feedbackDirection === 'left' ? 'Не нравится' : 'Нравится'}
          </motion.span>
        </div>
      )}
    </section>
  )
}
