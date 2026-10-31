import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useReducedMotion } from 'motion/react'
import Icon from './Icon'
import './CarouselArrows.css'

/** Shared edge indicators for every horizontally scrolling game carousel.
 * Arrows only appear when scrollWidth exceeds clientWidth on that side.
 * The buttons are also usable as controls, including mouse and keyboard. */
export default function CarouselArrows({
  children, className, label,
}: {
  children: ReactNode
  className: string
  label: string
}) {
  const track = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const gestureRef = useRef<{ id: number; kind: string; x: number; y: number;
    left: number; moved: boolean; samples: { x: number; time: number }[] } | null>(null)
  const momentumRef = useRef<number | null>(null)
  const ignoreClickRef = useRef(false)
  const clickResetRef = useRef<number | null>(null)
  const stopMomentum = () => {
    if (momentumRef.current !== null) cancelAnimationFrame(momentumRef.current)
    momentumRef.current = null
    if (track.current) track.current.style.scrollSnapType = ''
  }
  useEffect(() => () => {
    if (momentumRef.current !== null) cancelAnimationFrame(momentumRef.current)
    if (clickResetRef.current !== null) window.clearTimeout(clickResetRef.current)
  }, [])
  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary ||
        (event.target as HTMLElement).closest('.game-carousel-arrow')) return
    const el = track.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    stopMomentum()
    ignoreClickRef.current = false
    if (clickResetRef.current !== null) window.clearTimeout(clickResetRef.current)
    gestureRef.current = {
      id: event.pointerId, kind: event.pointerType, x: event.clientX,
      y: event.clientY, left: el.scrollLeft, moved: false,
      samples: [{ x: event.clientX, time: performance.now() }],
    }
  }
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    const el = track.current
    if (!g || !el || g.id !== event.pointerId) return
    const dx = event.clientX - g.x
    const dy = event.clientY - g.y
    // Accept mild diagonals. Vertical scrolling still belongs to the page.
    if (!g.moved && (Math.abs(dx) < 8 ||
        Math.abs(dx) < Math.abs(dy) * .48)) return
    if (!g.moved) {
      g.moved = true
      el.style.scrollSnapType = 'none'
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* no capture */ }
    }
    const now = performance.now()
    g.samples.push({ x: event.clientX, time: now })
    while (g.samples.length > 2 && now - g.samples[0].time > 120) g.samples.shift()
    // A light drag is deliberately less direct than the fingertip: weighted
    // movement creates the feeling of a shelf with physical mass.
    el.scrollLeft = g.left - dx * .83
    if (event.cancelable) event.preventDefault()
  }
  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g || g.id !== event.pointerId || !g.moved) return
    ignoreClickRef.current = true
    clickResetRef.current = window.setTimeout(() => {
      ignoreClickRef.current = false
      clickResetRef.current = null
    }, 120)
    const el = track.current
    if (!el) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancelled || reduceMotion) {
      el.style.scrollSnapType = ''
      return
    }
    const current = g.samples[g.samples.length - 1]
    const first = g.samples[0]
    // Release velocity is computed over the last ~120 ms, not from the
    // last noisy touch event. Fast flings can cross the whole remaining shelf.
    const speed = -.83 * (current.x - first.x) /
      Math.max(16, current.time - first.time)
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    let velocity = Math.max(-3.8, Math.min(3.8, speed * 1.65))
    if (Math.abs(speed) < .16) {
      el.style.scrollSnapType = ''
      return
    }
    let last = performance.now()
    let elapsed = 0
    let frames = 0
    // A decisive flick should continue to the far end; a measured gesture
    // settles naturally with friction so users can inspect nearby cards.
    const rush = Math.abs(speed) >= 1.05
    const startLeft = el.scrollLeft
    const destination = speed > 0 ? max : 0
    const duration = Math.min(1300, 780 + Math.abs(destination - startLeft) * .27)
    const tick = (now: number) => {
      const dt = Math.min(40, now - last)
      last = now
      elapsed += dt
      let target: number
      if (rush) {
        const fraction = Math.min(1, elapsed / duration)
        const eased = 1 - Math.pow(1 - fraction, 3)
        target = startLeft + (destination - startLeft) * eased
      } else {
        velocity *= Math.pow(.979, dt / 16)
        target = el.scrollLeft + velocity * dt
      }
      const clamped = Math.max(0, Math.min(max, target))
      el.scrollLeft = clamped
      const edge = target !== clamped || (rush && elapsed >= duration)
      if (edge || ++frames > 150 || (!rush && Math.abs(velocity) < .035)) {
        if (target !== clamped && !reduceMotion) {
          const offset = Math.min(17, Math.abs(target - clamped) + 5)
          el.animate([{ transform: 'translateX(0px)' },
            { transform: 'translateX(' + (target < 0 ? offset : -offset) + 'px)' },
            { transform: 'translateX(0px)' }],
          { duration: 360, easing: 'cubic-bezier(.2,.8,.25,1)' })
        }
        el.style.scrollSnapType = ''
        momentumRef.current = null
        return
      }
      momentumRef.current = requestAnimationFrame(tick)
    }
    momentumRef.current = requestAnimationFrame(tick)
  }
  const onDragClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!ignoreClickRef.current) return
    ignoreClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }
  const [edges, setEdges] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = track.current
    if (!el) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    setEdges(previous => {
      const next = { left: el.scrollLeft > 3, right: el.scrollLeft < max - 3 }
      return previous.left === next.left && previous.right === next.right ? previous : next
    })
  }, [])

  useEffect(() => {
    const el = track.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    const frame = requestAnimationFrame(measure)
    const onResize = () => measure()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [children, measure])

  const scroll = (direction: -1 | 1) => {
    const el = track.current
    if (!el) return
    el.scrollBy({ left: direction * Math.max(105, el.clientWidth * .7), behavior: 'smooth' })
  }
  return (
    <div className="game-carousel-shell"
      onClick={event => event.stopPropagation()}
      onClickCapture={onDragClick}
      onPointerDown={event => { event.stopPropagation(); onDragStart(event) }}
      onPointerMove={onDragMove} onPointerUp={onDragEnd}
      onPointerCancel={event => { onDragEnd(event, true); stopMomentum() }}>
      <div ref={track} className={className} role="list" aria-label={label}
        onScroll={measure} onLoadCapture={measure}>
        {children}
      </div>
      {edges.left && (
        <button type="button" className="game-carousel-arrow game-carousel-arrow--left"
          aria-label="Прокрутить игры влево" onClick={() => scroll(-1)}>
          <Icon name="chevron-left" size={17} />
        </button>
      )}
      {edges.right && (
        <button type="button" className="game-carousel-arrow game-carousel-arrow--right"
          aria-label="Прокрутить игры вправо" onClick={() => scroll(1)}>
          <Icon name="chevron-right" size={17} />
        </button>
      )}
    </div>
  )
}
