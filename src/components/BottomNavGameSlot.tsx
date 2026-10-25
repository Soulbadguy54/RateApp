import { useEffect, useRef, useState } from 'react'
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
  const pressRef = useRef<Press | null>(null)
  const suppressedClickAtRef = useRef(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const option = options.find(item => item.id === pinned) ?? options[0]

  useEffect(() => {
    setPinned(readPinned(nickname))
  }, [nickname])

  useEffect(() => () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
  }, [])

  const pin = (tab: GameNavTab) => {
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
    return id === 'add' || id === 'discovery' ? id : null
  }

  const clearPress = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    clearPress()
    suppressedClickAtRef.current = 0
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
      suppressedClickAtRef.current = Date.now()
      const choice = findChoice(event.clientX, event.clientY)
      if (choice) select(choice)
      else dismiss() // Releasing on the original button or outside cancels.
    } else if (
      duration <= SWIPE_MAX_MS &&
      Math.abs(dx) >= SWIPE_PX &&
      Math.abs(dy) <= SWIPE_MAX_VERTICAL_PX &&
      Math.abs(dx) >= Math.abs(dy) * 1.5
    ) {
      suppressedClickAtRef.current = Date.now()
      // A swipe changes the persistent shortcut, not the page underneath it.
      pin(pinned === 'add' ? 'discovery' : 'add')
    } else if (Math.abs(dy) > SWIPE_MAX_VERTICAL_PX) {
      suppressedClickAtRef.current = Date.now()
    }
  }

  const onPointerCancel = () => {
    clearPress()
    suppressedClickAtRef.current = Date.now()
    dismiss()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      pin(pinned === 'add' ? 'discovery' : 'add')
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
          if (Date.now() - suppressedClickAtRef.current < 750) return
          dismiss()
          onNavigate(pinned)
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

      <div className="bottom-nav__bubble-anchor">
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              className="bottom-nav__bubble"
              role="group"
              aria-label="Выбрать раздел базы игр"
              initial={reduceMotion ? false : { opacity: 0, y: 16, scale: .62 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 7, scale: .85 }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 470, damping: 22, mass: .7 }}
            >
              {options.map(choice => (
                <button
                  key={choice.id}
                  type="button"
                  className="bottom-nav__bubble-choice"
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
                  {hovered === choice.id && (
                    <motion.span
                      className="bottom-nav__bubble-highlight"
                      layoutId="bottom-nav-game-bubble-highlight"
                      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    />
                  )}
                  <span className="bottom-nav__bubble-choice-content">
                    <Icon name={choice.icon} size={20} />
                    <span>{choice.label}</span>
                  </span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
