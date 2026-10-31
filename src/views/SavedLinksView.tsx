import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { createPortal } from 'react-dom'
import Icon from '../components/Icon'
import { sessionFetch } from '../sessionFetch'
import './SavedLinksView.css'

type SavedGame = { id: number; title: string; coverUrl?: string | null }
type SavedLink = {
  id: number
  url: string
  title: string | null
  createdAt: string
  games: SavedGame[]
}
type LinksPage = { items: SavedLink[]; nextBefore: number | null }

const DELETE_DELAY_MS = 4000
const HOLD_DELAY_MS = 480

function displayHost(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function readableDate(date: string) {
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: string }
    if (typeof body.detail === 'string' && body.detail.length < 220) return body.detail
  } catch { /* Use the safe fallback. */ }
  return fallback
}

export default function SavedLinksView({ onOpenGame }: { onOpenGame: (gameId: number) => void }) {
  const reduceMotion = useReducedMotion()
  const [items, setItems] = useState<SavedLink[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [previews, setPreviews] = useState<Record<number, { title: string | null; description: string | null }>>({})
  const previewAttemptedRef = useRef(new Set<number>())
  const requestRef = useRef<AbortController | null>(null)
  const pendingDeleteRef = useRef<{ id: number; timer: number } | null>(null)
  const holdRef = useRef<{ pointerId: number; id: number; x: number; y: number; timer: number } | null>(null)
  const suppressCardClickRef = useRef<{ id: number; until: number } | null>(null)
  const cancelDialogRef = useRef<HTMLButtonElement>(null)

  const cancelDelete = () => {
    if (pendingDeleteRef.current) window.clearTimeout(pendingDeleteRef.current.timer)
    pendingDeleteRef.current = null
    setPendingDeleteId(null)
  }
  const cancelHold = () => {
    if (holdRef.current) window.clearTimeout(holdRef.current.timer)
    holdRef.current = null
  }

  useEffect(() => {
    return () => {
      requestRef.current?.abort()
      if (pendingDeleteRef.current) window.clearTimeout(pendingDeleteRef.current.timer)
      if (holdRef.current) window.clearTimeout(holdRef.current.timer)
    }
  }, [])

  useEffect(() => {
    if (!bulkConfirmOpen) return
    cancelDialogRef.current?.focus()
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) {
        event.preventDefault()
        setBulkConfirmOpen(false)
      }
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [bulkConfirmOpen, deleting])

  const fetchLinks = useCallback(async (before: number | null = null) => {
    if (!before) requestRef.current?.abort()
    const controller = new AbortController()
    if (!before) requestRef.current = controller
    if (before) setLoadingMore(true)
    else setLoading(true)
    try {
      const response = await sessionFetch('/api/saved-links?limit=50' + (before ? '&before=' + before : ''), { signal: controller.signal })
      if (!response.ok) throw new Error(await responseError(response, 'Не удалось загрузить ссылки.'))
      const payload = await response.json() as LinksPage
      if (controller.signal.aborted) return
      setItems(current => before
        ? [...current.filter(item => !payload.items.some(next => next.id === item.id)), ...payload.items]
        : payload.items)
      setNextBefore(payload.nextBefore)
      setError('')
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить ссылки.')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => { void fetchLinks() }, [fetchLinks])

  // Preview fetches happen separately from the fast URL save. The API checks
  // Safe Browsing, DNS, redirects and TLS; never load unverified remote images.
  useEffect(() => {
    let cancelled = false
    const candidates = items.slice(0, 8).filter(item =>
      !previewAttemptedRef.current.has(item.id))
    for (const item of candidates) previewAttemptedRef.current.add(item.id)
    const load = async () => {
      for (const item of candidates) {
        if (cancelled) return
        try {
          const response = await sessionFetch('/api/saved-links/' + item.id + '/preview', { method: 'POST' })
          if (!response.ok || cancelled) continue
          const info = await response.json() as { title: string | null; description: string | null }
          if (!cancelled) setPreviews(previous => ({ ...previous, [item.id]: info }))
        } catch { /* A failed safety check leaves the local fallback preview. */ }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [items])

  // Native Android Back and Safari edge-swipe dismiss transient UI first,
  // including multi-select, confirmation and the pending deletion countdown.
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (!bulkConfirmOpen && selectedIds.length === 0 && pendingDeleteId === null) return
      event.preventDefault()
      setBulkConfirmOpen(false)
      setSelectedIds([])
      cancelDelete()
    }
    window.addEventListener('rateapp:cancel-transient', dismiss)
    return () => window.removeEventListener('rateapp:cancel-transient', dismiss)
  }, [bulkConfirmOpen, selectedIds, pendingDeleteId])

  const addLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || deleting) return
    const raw = url.trim()
    const normalized = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw
    try {
      const parsed = new URL(normalized)
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) throw new Error()
    } catch {
      setError('Укажи адрес сайта, например example.com.')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await sessionFetch('/api/saved-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: normalized }),
      })
      if (!response.ok) throw new Error(await responseError(response, 'Не удалось сохранить ссылку.'))
      setUrl('')
      setNotice('Ссылка добавлена.')
      await fetchLinks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить ссылку.')
    } finally {
      setSaving(false)
    }
  }

  const performSingleDelete = async (id: number) => {
    setDeleting(true)
    setError('')
    setNotice('')
    try {
      const response = await sessionFetch('/api/saved-links/' + id, { method: 'DELETE' })
      if (!response.ok) throw new Error(await responseError(response, 'Не удалось удалить ссылку.'))
      setNotice('Ссылка удалена.')
      await fetchLinks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось удалить ссылку.')
    } finally {
      setDeleting(false)
    }
  }

  const armDelete = (id: number) => {
    if (deleting || saving || selectedIds.length) return
    if (pendingDeleteRef.current?.id === id) {
      cancelDelete()
      return
    }
    cancelDelete()
    const timer = window.setTimeout(() => {
      if (pendingDeleteRef.current?.id !== id) return
      pendingDeleteRef.current = null
      setPendingDeleteId(null)
      void performSingleDelete(id)
    }, DELETE_DELAY_MS)
    pendingDeleteRef.current = { id, timer }
    setPendingDeleteId(id)
    setError('')
    setNotice('')
  }

  const toggleSelection = (id: number) => {
    setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  }

  const holdStart = (link: SavedLink, event: PointerEvent<HTMLElement>) => {
    if (selectedIds.length || deleting || event.button !== 0 || !event.isPrimary) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input')) return
    cancelHold()
    suppressCardClickRef.current = null
    // Capture touch and pen events to keep the hold stable across nested
    // text/preview elements. Scrolling still cancels via pointercancel/move.
    if (event.pointerType !== 'mouse') {
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* unsupported */ }
    }
    const timer = window.setTimeout(() => {
      if (holdRef.current?.id !== link.id || holdRef.current.pointerId !== event.pointerId) return
      holdRef.current = null
      cancelDelete()
      suppressCardClickRef.current = { id: link.id, until: Date.now() + 1600 }
      setSelectedIds([link.id])
    }, HOLD_DELAY_MS)
    holdRef.current = { id: link.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer }
  }

  const holdMove = (event: PointerEvent<HTMLElement>) => {
    const held = holdRef.current
    if (held?.pointerId === event.pointerId && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 10) cancelHold()
  }

  const cardClick = (link: SavedLink, event: MouseEvent<HTMLElement>) => {
    if (suppressCardClickRef.current?.id === link.id &&
        Date.now() < suppressCardClickRef.current.until) {
      // Long-press may produce click after pointerup on Safari/Chromium.
      suppressCardClickRef.current = null
      return
    }
    if ((event.target as HTMLElement).closest('button, a')) return
    if (selectedIds.length) toggleSelection(link.id)
    else window.open(link.url, '_blank', 'noopener,noreferrer')
  }

  const cardKeyDown = (link: SavedLink, event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (selectedIds.length) toggleSelection(link.id)
      else window.open(link.url, '_blank', 'noopener,noreferrer')
    }
  }

  const bulkDelete = async () => {
    if (!selectedIds.length || deleting) return
    const ids = [...selectedIds]
    setDeleting(true)
    setError('')
    try {
      const response = await sessionFetch('/api/saved-links/bulk-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!response.ok) throw new Error(await responseError(response, 'Не удалось удалить выбранные ссылки.'))
      setBulkConfirmOpen(false)
      setSelectedIds([])
      setNotice('Выбранные ссылки удалены.')
      await fetchLinks()
    } catch (cause) {
      setBulkConfirmOpen(false)
      setError(cause instanceof Error ? cause.message : 'Не удалось удалить выбранные ссылки.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section className="saved-links-page" aria-label="Мои ссылки">
      <header className="saved-links-header topbar">
        <h1>Мои ссылки</h1>
        <p>Сохранённые ссылки из других источников</p>
      </header>

      <form className="saved-links-add" onSubmit={event => void addLink(event)}>
        <label htmlFor="saved-links-url">Добавить ссылку</label>
        <div className="saved-links-add__row">
          <input id="saved-links-url" type="text" inputMode="url" autoComplete="url"
            value={url} onChange={event => setUrl(event.target.value)}
            placeholder="example.com" maxLength={2048} required />
          <motion.button type="submit" disabled={saving || deleting || !url.trim()}
            whileTap={reduceMotion ? undefined : { scale: .94 }}
            aria-label="Сохранить ссылку">
            <Icon name={saving ? 'clock' : 'plus'} size={21} />
          </motion.button>
        </div>
      </form>

      {error && <div className="saved-links-message saved-links-message--error" role="alert">{error}</div>}
      {notice && <div className="saved-links-message" role="status">{notice}</div>}

      <div className="saved-links-subheading">
        <div>
          <h2>Сохранённое <span>{items.length}{nextBefore ? '+' : ''}</span></h2>
          {selectedIds.length > 0 && <p className="saved-links-selection-count">Выбрано: {selectedIds.length}</p>}
        </div>
        {selectedIds.length > 0 && (
          <div className="saved-links-bulk-actions">
            <button type="button" aria-label="Отменить выбор ссылок" title="Отменить выбор"
              onClick={() => setSelectedIds([])} disabled={deleting}>
              <Icon name="close" size={19} />
            </button>
            <button type="button" aria-label={'Удалить выбранные ссылки: ' + selectedIds.length}
              title="Удалить выбранные ссылки" className="saved-links-bulk-trash"
              onClick={() => setBulkConfirmOpen(true)} disabled={deleting}>
              <Icon name="trash" size={20} />
            </button>
          </div>
        )}
      </div>

      {loading && <div className="saved-links-empty" role="status">Загружаем ссылки…</div>}
      {!loading && !items.length && (
        <div className="saved-links-empty">
          <Icon name="bookmark" size={34} />
          <strong>Пока нет ссылок</strong>
          <p>Добавь статью, обзор или подборку — всё будет под рукой.</p>
        </div>
      )}

      <div className="saved-links-list">
        {!loading && items.map((link, index) => (
          <motion.article
            key={link.id}
            data-saved-link-id={link.id}
            className={'saved-link-card' + (selectedIds.includes(link.id) ? ' saved-link-card--selected' : selectedIds.length ? ' saved-link-card--selection-mode' : '')}
            role="button"
            tabIndex={0}
            aria-pressed={selectedIds.length ? selectedIds.includes(link.id) : undefined}
            aria-label={selectedIds.length ? (link.title || displayHost(link.url)) + ', ' + (selectedIds.includes(link.id) ? 'выбрано' : 'не выбрано') : 'Открыть ссылку ' + (link.title || displayHost(link.url))}
            onPointerDown={event => holdStart(link, event)}
            onPointerMove={holdMove}
            onPointerUp={cancelHold}
            onPointerCancel={cancelHold}
            onPointerLeave={event => { if (event.pointerType === 'mouse') cancelHold() }}
            onContextMenu={event => {
              event.preventDefault()
              if (deleting || (event.target as HTMLElement).closest('button, a')) return
              cancelHold()
              // Touch long-press fires a native contextmenu event *after* our
              // 480ms timer. Never toggle off the item that was just selected.
              if (suppressCardClickRef.current?.id === link.id &&
                  Date.now() < suppressCardClickRef.current.until) return
              cancelDelete()
              if (!selectedIds.length) {
                suppressCardClickRef.current = { id: link.id, until: Date.now() + 1600 }
                setSelectedIds([link.id])
              }
            }}
            onClick={event => cardClick(link, event)}
            onKeyDown={event => cardKeyDown(link, event)}
            initial={reduceMotion ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: .24, delay: Math.min(index, 7) * .04 }}
          >
            <div className="saved-link-card__body">
              <div className="saved-link-card__thumbnail" aria-hidden="true">
                <Icon name="link" size={23} />
                <img className="saved-link-card__preview-image"
                  src={'/api/saved-links/' + link.id + '/thumbnail'} alt=""
                  loading="lazy" referrerPolicy="no-referrer"
                  onError={event => { event.currentTarget.style.display = 'none' }} />
              </div>
              <div className="saved-link-card__copy">
                <h3>{previews[link.id]?.title || link.title || displayHost(link.url)}</h3>
                <p className="saved-link-card__host">{previews[link.id]?.description || displayHost(link.url)}</p>
                <time dateTime={link.createdAt}>{readableDate(link.createdAt)}</time>
              </div>
              <div className="saved-link-card__actions">
                {selectedIds.length ? (
                  <button type="button" className={'saved-link-card__selector' + (selectedIds.includes(link.id) ? ' saved-link-card__selector--checked' : '')}
                    aria-label={selectedIds.includes(link.id) ? 'Снять выбор ссылки' : 'Выбрать ссылку'}
                    aria-pressed={selectedIds.includes(link.id)}
                    onClick={event => { event.stopPropagation(); toggleSelection(link.id) }}
                    disabled={deleting}>
                    {selectedIds.includes(link.id) && <Icon name="checkmark" size={17} />}
                  </button>
                ) : (
                  <button type="button"
                    className={'saved-link-card__delete' + (pendingDeleteId === link.id ? ' saved-link-card__delete--pending' : '')}
                    aria-label={(pendingDeleteId === link.id ? 'Отменить удаление ссылки ' : 'Удалить ссылку ') + (link.title || displayHost(link.url))}
                    title={pendingDeleteId === link.id ? 'Отменить удаление' : 'Удалить ссылку'}
                    onClick={event => { event.stopPropagation(); armDelete(link.id) }}
                    disabled={deleting || saving}>
                    {pendingDeleteId === link.id && (
                      <span className="saved-link-card__radial-timer" aria-hidden="true" />
                    )}
                    <Icon name="trash" size={18} />
                  </button>
                )}
              </div>
            </div>
          </motion.article>
        ))}
      </div>

      {!loading && nextBefore != null && (
        <button type="button" className="saved-links-more" disabled={loadingMore || deleting}
          onClick={() => void fetchLinks(nextBefore)}>
          {loadingMore ? 'Загружаем…' : 'Показать ещё'}
        </button>
      )}

      {bulkConfirmOpen && createPortal((
        <div className="saved-links-dialog-backdrop"
          onMouseDown={event => {
            if (!deleting && event.target === event.currentTarget) setBulkConfirmOpen(false)
          }}>
          <section className="saved-links-dialog" role="alertdialog" aria-modal="true"
            aria-labelledby="saved-links-delete-title" aria-describedby="saved-links-delete-description">
            <span className="saved-links-dialog__brand">RateApp</span>
            <h2 id="saved-links-delete-title">Удалить выбранные ссылки ({selectedIds.length})?</h2>
            <p id="saved-links-delete-description">Ссылки будут удалены без возможности восстановления.</p>
            <div className="saved-links-dialog__actions">
              <button ref={cancelDialogRef} type="button" disabled={deleting}
                onClick={() => setBulkConfirmOpen(false)}>Отмена</button>
              <button type="button" className="saved-links-dialog__delete" disabled={deleting}
                onClick={() => void bulkDelete()}>{deleting ? 'Удаляем…' : 'Удалить'}</button>
            </div>
          </section>
        </div>
      ), document.body)}
    </section>
  )
}
