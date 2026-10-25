import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Icon, { type IconName } from './Icon'
import './BottomNavGameSlot.css'

export type GameNavTab = 'add' | 'discovery'

const options: { id: GameNavTab; label: string; icon: IconName }[] = [
  { id: 'add', label: 'База игр', icon: 'library' },
  { id: 'discovery', label: 'Для тебя', icon: 'sparkles' },
]

const HOLD_MS = 390
const HOLD_SLOP_PX = 12
const SWIPE_PX = 46
const SWIPE_MAX_VERTICAL_PX = 25
const SWIPE_MAX_MS = 850
const STORAGE_PREFIX = 'rateapp-game-nav-slot-v1:'
/**
 * A real shape morph, not scaling/fading a rectangular dialog.
 * The bottom tip initially sits near the selected nav cell. It stretches
 * upward and spreads sideways before settling into the rounded 2-cell panel.
 * All three paths use the same eight cubic curves for smooth interpolation.
 */
const LIQUID_DROP =
  'M 95 59 C 91 59 87 62 87 66 C 87 70 87 75 87 78 C 87 83 91 86 95 86 C 98 86 104 86 107 86 C 112 86 116 83 116 78 C 116 75 116 70 116 66 C 116 62 112 59 107 59 C 104 59 98 59 95 59 Z'
const LIQUID_STRETCH =
  'M 91 17 C 77 17 67 27 63 40 C 58 51 59 64 61 71 C 64 81 77 84 88 84 C 96 85 106 85 114 84 C 125 84 138 81 141 71 C 143 64 144 51 139 40 C 135 27 125 17 111 17 C 105 17 97 17 91 17 Z'
const LIQUID_PANEL =
  'M 24 3 C 12 3 3 12 3 24 C 3 36 3 44 3 56 C 3 65 12 69 24 69 C 70 69 132 69 178 69 C 190 69 199 65 199 56 C 199 44 199 36 199 24 C 199 12 190 3 178 3 C 132 3 70 3 24 3 Z'


function readPinned(nickname: string): GameNavTab {
  try {
    return localStorage.getItem(STORAGE_PREFIX + nickname) === 'discovery' ? 'discovery' : 'add'
  } catch {
    return 'add'
  }
}

type Press = {
  pointerId: number
  startX: number
  startY: number
  startTime: number
  timer: number
  longPressed: boolean
}

type Props = {
  nickname: string
  active: boolean
  onNavigate: (tab: GameNavTab) => void
}

export default function BottomNavGameSlot({ nickname, active, onNavigate }: Props) {
  const reduceMotion = useReducedMotion()
  const [pinned, setPinned] = useState<GameNavTab>(() => readPinned(nickname))
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState<GameNavTab | null>(null)
  const [navItemHeight, setNavItemHeight] = useState(44)
  const pressRef = useRef<Press | null>(null)
  // Ignore only the click belonging to the handled gesture, not a later tap.
  const ignoreGestureClickRef = useRef(false)
  const gestureClickTimerRef = useRef<number | null>(null)
  // A synchronous ref avoids stale values when swipe and tap share a render batch.
  const pinnedRef = useRef<GameNavTab>(pinned)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const bubbleAnchorRef = useRef<HTMLDivElement>(null)

  // Measure a real sibling nav button. SVG size alone does NOT define the
  // overall tap target; fonts, line height and platform metrics also matter.
  useEffect(() => {
    const bar = buttonRef.current?.closest('.bottom-nav')
    const reference = bar?.querySelector<HTMLButtonElement>(':scope > button.bottom-nav__item')
    if (!reference) return
    const sync = () => {
      const height = reference.getBoundingClientRect().height
      if (height > 0) setNavItemHeight(height)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(reference)
    return () => observer.disconnect()
  }, [])
  const option = options.find(item => item.id === pinned) ?? options[0]

  useEffect(() => {
    const next = readPinned(nickname)
    pinnedRef.current = next
    setPinned(next)
    ignoreGestureClickRef.current = false
  }, [nickname])

  useEffect(() => () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
    if (gestureClickTimerRef.current !== null) window.clearTimeout(gestureClickTimerRef.current)
  }, [])

  const pin = (tab: GameNavTab) => {
    pinnedRef.current = tab
    setPinned(tab)
    try { localStorage.setItem(STORAGE_PREFIX + nickname, tab) } catch { /* storage disabled */ }
  }

  const dismiss = () => {
    setMenuOpen(false)
    setHovered(null)
  }

  const select = (tab: GameNavTab) => {
    pin(tab)
    dismiss()
    onNavigate(tab)
  }

  const findChoice = (x: number, y: number): GameNavTab | null => {
    const candidate = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-game-nav-choice]')
    const id = candidate?.dataset.gameNavChoice
    if (id === 'add' || id === 'discovery') return id
    // During liquid expansion the visual bubble starts as a tiny droplet.
    // Resolve against its full layout box so a fast drag/release still works.
    const bounds = bubbleAnchorRef.current?.getBoundingClientRect()
    if (bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      return x < bounds.left + bounds.width / 2 ? 'add' : 'discovery'
    }
    return null
  }

  const clearPress = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }

  const suppressGestureClick = () => {
    ignoreGestureClickRef.current = true
    if (gestureClickTimerRef.current !== null) window.clearTimeout(gestureClickTimerRef.current)
    // A swipe's synthetic click is dispatched immediately after pointerup.
    // Do not suppress the next independent tap when the browser omits it.
    gestureClickTimerRef.current = window.setTimeout(() => {
      ignoreGestureClickRef.current = false
      gestureClickTimerRef.current = null
    }, 0)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    clearPress()
    ignoreGestureClickRef.current = false
    if (gestureClickTimerRef.current !== null) window.clearTimeout(gestureClickTimerRef.current)
    gestureClickTimerRef.current = null
    dismiss()
    const press: Press = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: Date.now(),
      timer: 0,
      longPressed: false,
    }
    press.timer = window.setTimeout(() => {
      if (pressRef.current !== press) return
      press.longPressed = true
      setMenuOpen(true)
    }, HOLD_MS)
    pressRef.current = press
    // Keep receiving coordinates while the finger leaves the fixed nav and
    // travels into the bubble. Hit testing uses elementFromPoint, not target.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic input */ }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current
    if (!press || press.pointerId !== event.pointerId) return
    if (press.longPressed) {
      setHovered(findChoice(event.clientX, event.clientY))
    } else if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > HOLD_SLOP_PX) {
      // Movement before the hold cancels long-press, but a deliberate sideways
      // movement can still become a swipe once it crosses the larger threshold.
      window.clearTimeout(press.timer)
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current
    if (!press || press.pointerId !== event.pointerId) return
    const duration = Date.now() - press.startTime
    const dx = event.clientX - press.startX
    const dy = event.clientY - press.startY
    const longPressed = press.longPressed
    clearPress()

    if (longPressed) {
      suppressGestureClick()
      const choice = findChoice(event.clientX, event.clientY)
      if (choice) select(choice)
      else dismiss() // Releasing on the original button or outside cancels.
    } else if (
      duration <= SWIPE_MAX_MS &&
      Math.abs(dx) >= SWIPE_PX &&
      Math.abs(dy) <= SWIPE_MAX_VERTICAL_PX &&
      Math.abs(dx) >= Math.abs(dy) * 1.5
    ) {
      suppressGestureClick()
      // A swipe changes the persistent shortcut, not the page underneath it.
      pin(pinnedRef.current === 'add' ? 'discovery' : 'add')
    } else if (Math.abs(dy) > SWIPE_MAX_VERTICAL_PX) {
      suppressGestureClick()
    }
  }

  const onPointerCancel = () => {
    clearPress()
    suppressGestureClick()
    dismiss()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      pin(pinnedRef.current === 'add' ? 'discovery' : 'add')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setMenuOpen(true)
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('[data-game-nav-choice="add"]')?.focus()
      })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    }
  }

  return (
    <div className="bottom-nav__slot">
      <motion.button
        ref={buttonRef}
        type="button"
        className={active ? 'bottom-nav__item bottom-nav__item--active bottom-nav__item--switchable' : 'bottom-nav__item bottom-nav__item--switchable'}
        aria-label={option.label}
        aria-description="Свайп влево или вправо меняет ярлык. Удержание открывает выбор раздела."
        aria-haspopup="true"
        aria-expanded={menuOpen}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (ignoreGestureClickRef.current) {
            ignoreGestureClickRef.current = false
            return
          }
          dismiss()
          onNavigate(pinnedRef.current)
        }}
        whileTap={reduceMotion ? undefined : { scale: .92 }}
        transition={{ type: 'spring', stiffness: 500, damping: 34 }}
      >
        {active && (
          <motion.span
            className="bottom-nav__active-surface"
            layoutId="bottom-nav-active-surface"
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          />
        )}
        <span className="bottom-nav__content">
          <motion.span
            key={pinned}
            className="bottom-nav__slot-icon"
            initial={reduceMotion ? false : { opacity: .5, x: 7, scale: .9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ duration: reduceMotion ? 0 : .19 }}
          ><Icon name={option.icon} /></motion.span>
          <span>{option.label}</span>
        </span>
      </motion.button>

      <div
        ref={bubbleAnchorRef}
        className="bottom-nav__bubble-anchor"
        style={{ '--game-nav-item-height': `${navItemHeight}px` } as CSSProperties}
      >
        <AnimatePresence>
          {menuOpen && (
            <svg
              className="bottom-nav__liquid-surface"
              viewBox="0 0 202 88"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <motion.path
                className="bottom-nav__liquid-path"
                initial={reduceMotion ? false : { d: LIQUID_DROP }}
                animate={{
                  d: reduceMotion
                    ? LIQUID_PANEL
                    : [LIQUID_DROP, LIQUID_STRETCH, LIQUID_PANEL],
                }}
                exit={reduceMotion ? undefined : {
                  d: LIQUID_DROP,
                  opacity: 0,
                  transition: { duration: .26, ease: 'easeInOut' },
                }}
                transition={reduceMotion ? { duration: 0 } : {
                  d: { duration: .72, times: [0, .46, 1], ease: [ .25, .72, .22, 1 ] },
                }}
              />
            </svg>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              className="bottom-nav__bubble"
              role="group"
              aria-label="Выбрать раздел базы игр"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : .1 } }}
              transition={{ duration: reduceMotion ? 0 : .24, delay: reduceMotion ? 0 : .34 }}
            >
              {options.map(choice => (
                <button
                  key={choice.id}
                  type="button"
                  className="bottom-nav__item bottom-nav__bubble-choice"
                  data-game-nav-choice={choice.id}
                  data-highlighted={hovered === choice.id}
                  aria-pressed={pinned === choice.id}
                  onPointerEnter={() => { if (!pressRef.current) setHovered(choice.id) }}
                  onPointerLeave={() => { if (!pressRef.current) setHovered(null) }}
                  onClick={() => {
                    // Real clicks/keyboard selection also work without the
                    // continuous press-and-drag gesture.
                    select(choice.id)
                    buttonRef.current?.focus()
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      dismiss()
                      buttonRef.current?.focus()
                    }
                  }}
                >
                  {(hovered ?? pinned) === choice.id && (
                    <motion.span
                      className="bottom-nav__active-surface bottom-nav__bubble-highlight"
                      layoutId="bottom-nav-game-bubble-highlight"
                      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    />
                  )}
                  <motion.span
                    className="bottom-nav__content bottom-nav__bubble-choice-content"
                    initial={reduceMotion ? false : { opacity: 0, y: 9, scale: .85 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={reduceMotion ? { duration: 0 } : {
                      type: 'spring', stiffness: 380, damping: 22,
                      delay: choice.id === 'add' ? .035 : .07,
                    }}
                  >
                    <Icon name={choice.icon} />
                    <span>{choice.label}</span>
                  </motion.span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
