import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Icon from './Icon'
import { profileTintOption, type ProfileTint } from '../profilePalette'
import { RELEASE_NOTES } from '../releaseNotes'
import './ReleaseNotesDialog.css'

type Props = {
  open: boolean
  tint: ProfileTint
  onClose: () => void
}

/** A profile overlay: Android Back and Safari edge-swipe behave like ×. */
export default function ReleaseNotesDialog({ open, tint, onClose }: Props) {
  const [index, setIndex] = useState(0)
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  const palette = profileTintOption(tint)
  const release = RELEASE_NOTES[index]

  useEffect(() => {
    if (!open) return
    setIndex(0)
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus())

    const onBack = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Home') {
        event.preventDefault()
        setIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setIndex(RELEASE_NOTES.length - 1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setIndex(value => Math.min(RELEASE_NOTES.length - 1, value + 1))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        setIndex(value => Math.max(0, value - 1))
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        )
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('rateapp:cancel-transient', onBack)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('rateapp:cancel-transient', onBack)
      document.querySelector<HTMLButtonElement>('.app-build-version__trigger')?.focus()
    }
  }, [open, onClose])

  const style = {
    '--release-accent': palette.color,
    '--release-accent-rgb': palette.accentRgb,
    '--release-tint-rgb': palette.rgb,
  } as CSSProperties

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="release-notes-backdrop"
          className="release-notes__backdrop"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : .18 }}
          onPointerDown={event => {
            if (event.target === event.currentTarget) onClose()
          }}
        >
          <motion.section
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-notes-heading"
            className="release-notes__panel"
            style={style}
            initial={reducedMotion ? false : { opacity: 0, y: 24, scale: .96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: .96 }}
            transition={{ type: 'spring', stiffness: 350, damping: 33 }}
          >
            <header className="release-notes__header">
              <div className="release-notes__heading-wrap">
                <span className="release-notes__eyebrow">Rate APP</span>
                <h2 id="release-notes-heading">История обновлений</h2>
              </div>
              <button
                type="button"
                ref={closeRef}
                className="release-notes__close"
                aria-label="Закрыть историю обновлений"
                onClick={onClose}
              >
                <Icon name="x" size={20} />
              </button>
            </header>

            <div className="release-notes__navigation" aria-label="Навигация по версиям">
              <button type="button" className="release-notes__arrow"
                aria-label="Предыдущая версия"
                disabled={index >= RELEASE_NOTES.length - 1}
                onClick={() => setIndex(value => Math.min(RELEASE_NOTES.length - 1, value + 1))}>
                <Icon name="chevron-left" size={23} />
              </button>
              <div className="release-notes__version" aria-live="polite" aria-atomic="true">
                <strong>{release.version}</strong>
                <span>{release.period}</span>
              </div>
              <button type="button" className="release-notes__arrow"
                aria-label="Следующая версия"
                disabled={index === 0}
                onClick={() => setIndex(value => Math.max(0, value - 1))}>
                <Icon name="chevron-right" size={23} />
              </button>
            </div>

            <div className="release-notes__body">
              <h3>Что нового</h3>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={release.version}
                  initial={reducedMotion ? false : { opacity: 0, y: 7 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -7 }}
                  transition={{ duration: reducedMotion ? 0 : .16 }}
                >
                  {release.changes.length ? (
                    <ul className="release-notes__changes">
                      {release.changes.map(change => <li key={change}>{change}</li>)}
                    </ul>
                  ) : (
                    <p className="release-notes__quiet">
                      В этой версии не было крупных изменений в возможностях приложения.
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
