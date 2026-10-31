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
  const gestureRef = useRef<{ id: number; x: number; left: number; lastX: number;
    lastT: number; velocity: number; moved: boolean } | null>(null)
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
    // Phones already have native inertia and edge elasticity.
    if (event.pointerType === 'touch' || event.button !== 0 || !event.isPrimary ||
        (event.target as HTMLElement).closest('.game-carousel-arrow')) return
    const el = track.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    stopMomentum()
    ignoreClickRef.current = false
    if (clickResetRef.current !== null) window.clearTimeout(clickResetRef.current)
    gestureRef.current = { id: event.pointerId, x: event.clientX, left: el.scrollLeft,
      lastX: event.clientX, lastT: performance.now(), velocity: 0, moved: false }
  }
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    const el = track.current
    if (!g || !el || g.id !== event.pointerId) return
    if (!g.moved && Math.abs(event.clientX - g.x) < 7) return
    if (!g.moved) {
      g.moved = true
      el.style.scrollSnapType = 'none'
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* no capture */ }
    }
    const now = performance.now()
    g.velocity = Math.max(-3, Math.min(3, -(event.clientX - g.lastX) / Math.max(1, now - g.lastT)))
    g.lastX = event.clientX
    g.lastT = now
    el.scrollLeft = g.left - (event.clientX - g.x)
    if (event.cancelable) event.preventDefault()
  }
  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g || g.id !== event.pointerId || !g.moved) return
    ignoreClickRef.current = true
    // Some browsers omit the synthetic click after a drag. Do not swallow a
    // subsequent independent tap on a card in that case.
    clickResetRef.current = window.setTimeout(() => {
      ignoreClickRef.current = false
      clickResetRef.current = null
    }, 80)
    const el = track.current
    if (!el) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (reduceMotion || Math.abs(g.velocity) < .11) {
      el.style.scrollSnapType = ''
      return
    }
    let velocity = g.velocity
    let last = performance.now()
    let frames = 0
    const tick = (now: number) => {
      const dt = Math.min(35, now - last)
      last = now
      velocity *= Math.pow(.91, dt / 16)
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      const target = el.scrollLeft + velocity * dt
      if (target < 0 || target > max) {
        el.scrollLeft = Math.max(0, Math.min(max, target))
        const offset = Math.min(15, Math.abs(target - el.scrollLeft))
        el.animate([{ transform: 'translateX(0px)' },
          { transform: 'translateX(' + (target < 0 ? offset : -offset) + 'px)' },
          { transform: 'translateX(0px)' }],
        { duration: 270, easing: 'cubic-bezier(.22,.8,.2,1)' })
        el.style.scrollSnapType = ''
        momentumRef.current = null
        return
      }
      el.scrollLeft = target
      if (++frames > 48 || Math.abs(velocity) < .07) {
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
      onPointerCancel={event => { onDragEnd(event); stopMomentum() }}>
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
