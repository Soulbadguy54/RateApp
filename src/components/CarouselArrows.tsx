import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
      onPointerDown={event => event.stopPropagation()}>
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
