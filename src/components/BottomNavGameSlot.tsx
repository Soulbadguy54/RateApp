import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, usePresence, useReducedMotion, useTransform } from 'motion/react'
import Icon, { type IconName } from './Icon'
import './BottomNavGameSlot.css'

export type GameNavTab = 'add' | 'discovery' | 'collections' | 'links'
export type NavSlotGroup = 'games' | 'collections'

const gameOptions: { id: GameNavTab; label: string; icon: IconName }[] = [
  { id: 'add', label: 'База игр', icon: 'library' },
  { id: 'discovery', label: 'Для тебя', icon: 'sparkles' },
]
const collectionOptions: { id: GameNavTab; label: string; icon: IconName }[] = [
  { id: 'collections', label: 'Коллекции', icon: 'heart' },
  { id: 'links', label: 'Мои ссылки', icon: 'link' },
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
  'M 19 3 C 10 3 3 10 3 19 C 3 29 3 43 3 53 C 3 62 10 69 19 69 C 60 69 142 69 183 69 C 192 69 199 62 199 53 C 199 43 199 29 199 19 C 199 10 192 3 183 3 C 140 3 60 3 19 3 Z'

// Closing must go BEYOND the visible 29×27px starting droplet, otherwise
// that rounded square lingers until AnimatePresence removes the SVG.
// Eight identical cubic commands preserve 1:1 path morphing on WebKit.
const LIQUID_VANISH =
  'M 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 C 101 82 101 82 101 82 Z'
const LIQUID_VANISH_PROGRESS = -.36


/**
 * Shape and clickable choices share a single lifecycle/progress value.
 * The former two AnimatePresence trees raced one another on close: the
 * choices faded/remounted independently while the SVG was still collapsing.
 * Keep them mounted together until the final invisible drop frame.
 */
function LiquidMorph({ reduceMotion, children, ariaLabel }: { reduceMotion: boolean; children: ReactNode; ariaLabel: string }) {
  const [isPresent, safeToRemove] = usePresence()
  const progress = useMotionValue(reduceMotion ? 1 : 0)
  const shape = useTransform(progress, [LIQUID_VANISH_PROGRESS, 0, .46, 1], [
    LIQUID_VANISH, LIQUID_DROP, LIQUID_STRETCH, LIQUID_PANEL,
  ])
  // Keep the real liquid silhouette visible for almost the entire expansion.
  // Previously the rectangular backdrop became visible at 34%, hiding the
  // opening morph. Reverse these same values for a visible close morph.
  const surfaceOpacity = useTransform(progress, [LIQUID_VANISH_PROGRESS, 0, .85, .98, 1], [0, 1, 1, .14, 0])
  const choicesOpacity = useTransform(progress, [0, .79, .89, 1], [0, 0, .25, 1])

  useEffect(() => {
    if (reduceMotion) {
      progress.set(isPresent ? 1 : LIQUID_VANISH_PROGRESS)
      if (!isPresent) safeToRemove()
      return
    }
    let interrupted = false
    const animation = animate(progress, isPresent ? 1 : LIQUID_VANISH_PROGRESS, {
      duration: isPresent ? .66 : .54,
      ease: isPresent ? [.22, .73, .2, 1] : [.35, 0, .36, 1],
    })
    if (!isPresent) {
      void animation.then(() => {
        if (!interrupted) safeToRemove()
      })
    }
    return () => {
      interrupted = true
      animation.stop()
    }
  }, [isPresent, progress, reduceMotion, safeToRemove])

  return (
    <>
      <motion.svg
        className="bottom-nav__liquid-surface"
        style={{ opacity: surfaceOpacity }}
        viewBox="0 0 202 88"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <motion.path className="bottom-nav__liquid-path" d={shape} />
      </motion.svg>
      <motion.div
        className="bottom-nav__bubble"
        role="group"
        aria-label={ariaLabel}
        aria-hidden={!isPresent}
        style={{ opacity: choicesOpacity, pointerEvents: isPresent ? 'auto' : 'none' }}
      >
        {children}
      </motion.div>
    </>
  )
}

function readPinned(nickname: string, group: NavSlotGroup): GameNavTab {
  const fallback = group === 'games' ? 'add' : 'collections'
  const alternate = group === 'games' ? 'discovery' : 'links'
  try {
    const prefix = group === 'games' ? STORAGE_PREFIX : 'rateapp-collection-nav-slot-v1:'
    return localStorage.getItem(prefix + nickname) === alternate ? alternate : fallback
  } catch {
    return fallback
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
  group?: NavSlotGroup
}

export default function BottomNavGameSlot({ nickname, active, onNavigate, group = 'games' }: Props) {
  const options = group === 'games' ? gameOptions : collectionOptions
  const [first, second] = options
  const reduceMotion = useReducedMotion()
  const [pinned, setPinned] = useState<GameNavTab>(() => readPinned(nickname, group))
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState<GameNavTab | null>(null)
  const [navItemSize, setNavItemSize] = useState({ width: 92, height: 44 })
  const [floatingRect, setFloatingRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const pressRef = useRef<Press | null>(null)
  // Ignore only the click belonging to the handled gesture, not a later tap.
  const ignoreGestureClickRef = useRef(false)
  const gestureClickTimerRef = useRef<number | null>(null)
  // A synchronous ref avoids stale values when swipe and tap share a render batch.
  const pinnedRef = useRef<GameNavTab>(pinned)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const bubbleAnchorRef = useRef<HTMLDivElement>(null)
  const floatingRef = useRef<HTMLDivElement>(null)

  // Measure a real sibling nav button. SVG size alone does NOT define the
  // overall tap target; fonts, line height and platform metrics also matter.
  useEffect(() => {
    const bar = buttonRef.current?.closest('.bottom-nav')
    const reference = bar?.querySelector<HTMLButtonElement>(':scope > button.bottom-nav__item')
    if (!reference) return
    const sync = () => {
      const { width, height } = reference.getBoundingClientRect()
      if (width > 0 && height > 0) {
        setNavItemSize(current => current.width === width && current.height === height
          ? current
          : { width, height })
      }
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(reference)
    return () => observer.disconnect()
  }, [])
  // The bottom bar itself uses backdrop-filter, creating a backdrop root.
  // A nested popup cannot sample/blur the page behind that root, even with
  // identical CSS tokens. Portal the popup out to <body> but keep its measured
  // anchor and React gesture handlers associated with the original nav slot.
  useLayoutEffect(() => {
    if (!menuOpen) return
    const sync = () => {
      const r = bubbleAnchorRef.current?.getBoundingClientRect()
      if (!r) return
      setFloatingRect(prev => prev && prev.left === r.left && prev.top === r.top &&
        prev.width === r.width && prev.height === r.height ? prev : {
          left: r.left, top: r.top, width: r.width, height: r.height,
        })
    }
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [menuOpen, navItemSize.width, navItemSize.height])

  const option = options.find(item => item.id === pinned) ?? options[0]

  useEffect(() => {
    const next = readPinned(nickname, group)
    pinnedRef.current = next
    setPinned(next)
    ignoreGestureClickRef.current = false
  }, [nickname, group])

  useEffect(() => () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
    if (gestureClickTimerRef.current !== null) window.clearTimeout(gestureClickTimerRef.current)
  }, [])

  const pin = (tab: GameNavTab) => {
    pinnedRef.current = tab
    setPinned(tab)
    try { localStorage.setItem((group === 'games' ? STORAGE_PREFIX : 'rateapp-collection-nav-slot-v1:') + nickname, tab) } catch { /* storage disabled */ }
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
    const choiceAttribute = group === 'games' ? 'data-game-nav-choice' : 'data-collection-nav-choice'
    const candidate = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${choiceAttribute}]`)
    const id = candidate?.getAttribute(choiceAttribute)
    if (id === first.id || id === second.id) return id
    // During liquid expansion the visual bubble starts as a tiny droplet.
    // Resolve against its full layout box so a fast drag/release still works.
    const bounds = bubbleAnchorRef.current?.getBoundingClientRect()
    if (bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      return x < bounds.left + bounds.width / 2 ? first.id : second.id
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
      pin(pinnedRef.current === first.id ? second.id : first.id)
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
      pin(pinnedRef.current === first.id ? second.id : first.id)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setMenuOpen(true)
      window.requestAnimationFrame(() => {
        floatingRef.current?.querySelector<HTMLButtonElement>('[data-game-nav-choice], [data-collection-nav-choice]')?.focus()
      })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    }
  }

  return (
    <div className={group === 'games' ? "bottom-nav__slot" : "bottom-nav__slot bottom-nav__slot--collections"} data-nav-slot={group}>
      <motion.button
        ref={buttonRef}
        type="button"
        className={'bottom-nav__item ' + (group === 'games' ? 'bottom-nav__item--switchable' : 'bottom-nav__item--collection-switchable') + (active ? ' bottom-nav__item--active' : '')}
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
        style={{
          '--game-nav-item-width': `${navItemSize.width}px`,
          '--game-nav-item-height': `${navItemSize.height}px`,
        } as CSSProperties}
      />
      {floatingRect && createPortal(
        <div
          ref={floatingRef}
          className={'bottom-nav__bubble-floating' + (group === 'collections' ? ' bottom-nav__bubble-floating--collections' : '')}
          data-nav-popup={group}
          style={{
            ...floatingRect,
            '--game-nav-item-width': `${navItemSize.width}px`,
            '--game-nav-item-height': `${navItemSize.height}px`,
          } as CSSProperties}
        >
          <AnimatePresence initial={false}>
            {menuOpen && (
              <LiquidMorph key="liquid" reduceMotion={Boolean(reduceMotion)}
                ariaLabel={group === 'games' ? "Выбрать раздел базы игр" : "Выбрать Коллекции или Мои ссылки"}>
                {options.map(choice => (
                  <button
                    key={choice.id}
                    type="button"
                    className="bottom-nav__item bottom-nav__bubble-choice"
                    {...(group === 'games' ? { 'data-game-nav-choice': choice.id } : { 'data-collection-nav-choice': choice.id })}
                    data-highlighted={hovered === choice.id}
                    onPointerEnter={() => { if (!pressRef.current) setHovered(choice.id) }}
                    onPointerLeave={() => { if (!pressRef.current) setHovered(null) }}
                    onClick={() => {
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
                    {hovered === choice.id && (
                      <span className="bottom-nav__active-surface bottom-nav__bubble-highlight" />
                    )}
                    <span className="bottom-nav__content bottom-nav__bubble-choice-content">
                      <Icon name={choice.icon} />
                      <span>{choice.label}</span>
                    </span>
                  </button>
                ))}
              </LiquidMorph>
            )}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </div>
  )
}
