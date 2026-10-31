import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import Icon from '../components/Icon'
import { sessionFetch } from '../sessionFetch'
import './SavedLinksView.css'

type SavedGame = { id: number; igdbId: number; title: string; coverUrl?: string | null }
type SavedLink = {
  id: number
  url: string
  title: string | null
  status: 'pending' | 'processing' | 'ready' | 'failed'
  gptNames: string[] | null
  createdAt: string
  error: string | null
  games: SavedGame[]
  gamesCount: number
}
type LinksPage = { items: SavedLink[]; nextBefore: number | null }

const stateMeta: Record<SavedLink['status'], { label: string; tip: string }> = {
  pending: { label: 'В очереди', tip: 'Ссылка ожидает обработки.' },
  processing: { label: 'Обрабатываем', tip: 'Ищем упомянутые игры.' },
  ready: { label: 'Обработано', tip: 'Результат последней проверки.' },
  failed: { label: 'Ошибка', tip: 'Ссылку не удалось обработать.' },
}

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
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const requestRef = useRef<AbortController | null>(null)

  const fetchLinks = useCallback(async (before: number | null = null) => {
    if (!before) requestRef.current?.abort()
    const controller = new AbortController()
    if (!before) requestRef.current = controller
    if (before) setLoadingMore(true)
    else setLoading(true)
    try {
      const result = await sessionFetch('/api/saved-links?limit=50' + (before ? '&before=' + before : ''), {
        signal: controller.signal,
      })
      if (!result.ok) throw new Error(await responseError(result, 'Не удалось загрузить ссылки.'))
      const page = await result.json() as LinksPage
      if (controller.signal.aborted) return
      setItems(current => before ? [...current.filter(item => !page.items.some(next => next.id === item.id)), ...page.items] : page.items)
      setNextBefore(page.nextBefore)
      setError('')
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Нет соединения с сервером.')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    void fetchLinks()
    return () => requestRef.current?.abort()
  }, [fetchLinks])

  const addLink = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const value = url.trim()
    try {
      const parsed = new URL(value)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
    } catch {
      setError('Вставь ссылку, которая начинается с https:// или http://.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await sessionFetch('/api/saved-links', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      })
      if (!response.ok) throw new Error(await responseError(response, 'Не удалось сохранить ссылку.'))
      setUrl('')
      setNotice('Ссылка сохранена. Обработка запустится отдельно.')
      await fetchLinks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить ссылку.')
    } finally {
      setBusy(false)
    }
  }

  const act = async (id: number, action: 'delete' | 'retry' | 'refresh') => {
    if (busyId !== null) return
    setBusyId(id)
    setError('')
    setNotice('')
    try {
      const response = await sessionFetch('/api/saved-links/' + id + (action === 'delete' ? '' : '/' + action), {
        method: action === 'delete' ? 'DELETE' : 'POST',
      })
      if (!response.ok) throw new Error(await responseError(response, 'Не удалось выполнить действие.'))
      setDeleteTarget(null)
      setNotice(action === 'delete' ? 'Ссылка удалена.' : 'Ссылка поставлена в очередь на повторную обработку.')
      await fetchLinks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="saved-links-page" aria-label="Мои ссылки">
      <header className="saved-links-header">
        <div>
          <span className="saved-links-eyebrow">Личная подборка</span>
          <h1>Мои ссылки</h1>
          <p>Статьи и подборки игр в одном месте</p>
        </div>
        <span className="saved-links-header__symbol"><Icon name="link" size={24} /></span>
      </header>

      <form className="saved-links-add" onSubmit={event => void addLink(event)}>
        <label htmlFor="saved-links-url">Добавить ссылку</label>
        <div className="saved-links-add__row">
          <input id="saved-links-url" type="url" inputMode="url" autoComplete="url"
            value={url} onChange={event => setUrl(event.target.value)}
            placeholder="https://example.com/подборка" maxLength={2048} required />
          <motion.button type="submit" disabled={busy || !url.trim()}
            whileTap={reduceMotion ? undefined : { scale: .94 }}
            aria-label="Сохранить ссылку">
            <Icon name={busy ? 'clock' : 'plus'} size={21} />
          </motion.button>
        </div>
        <span className="saved-links-add__hint">Сохраняем URL сейчас; игры определяются позже. Исходный материал не загружается при добавлении.</span>
      </form>

      {error && <div className="saved-links-message saved-links-message--error" role="alert">{error}</div>}
      {notice && <div className="saved-links-message" role="status">{notice}</div>}

      <div className="saved-links-subheading">
        <h2>Сохранённое <span>{items.length}{nextBefore ? '+' : ''}</span></h2>
        <button type="button" onClick={() => void fetchLinks()} disabled={loading || loadingMore || busy || busyId !== null}
          aria-label="Обновить список ссылок">Обновить</button>
      </div>

      {loading && <div className="saved-links-empty" role="status">Загружаем ссылки…</div>}
      {!loading && !items.length && (
        <div className="saved-links-empty">
          <Icon name="bookmark" size={34} />
          <strong>Пока нет ссылок</strong>
          <p>Добавь статью, обзор или подборку. Когда обработка завершится, здесь появятся найденные игры.</p>
        </div>
      )}

      <div className="saved-links-list">
        {!loading && items.map((link, index) => (
          <motion.article key={link.id} className="saved-link-card"
            initial={reduceMotion ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: .24, delay: Math.min(index, 7) * .04 }}>
            <div className="saved-link-card__top">
              <span className={'saved-link-card__status saved-link-card__status--' + link.status}>
                {stateMeta[link.status].label}
              </span>
              <time dateTime={link.createdAt}>{readableDate(link.createdAt)}</time>
            </div>
            <h3>{link.title || displayHost(link.url)}</h3>
            <p className="saved-link-card__host">{displayHost(link.url)}</p>
            <div className="saved-link-card__games">
              {link.games.length > 0 ? (
                <>
                  <span className="saved-link-card__section-name">Найденные игры · {link.gamesCount}</span>
                  <div className="saved-link-card__game-list">
                    {link.games.map(game => (
                      <button type="button" key={game.id} className="saved-link-card__game"
                        onClick={() => onOpenGame(game.id)} aria-label={'Открыть игру ' + game.title}>
                        {game.coverUrl ? <img src={game.coverUrl} alt="" loading="lazy" /> : <Icon name="gamepad" size={16} />}
                        <span>{game.title}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="saved-link-card__progress">
                  {link.status === 'ready'
                    ? (link.gptNames?.length ? 'Игры в каталоге пока не найдены.' : 'В материале не найдено игр.')
                    : link.status === 'failed' ? (link.error || stateMeta.failed.tip) : stateMeta[link.status].tip}
                </p>
              )}
              {link.gptNames && link.gptNames.length > 0 && link.games.length === 0 && link.status === 'ready' && (
                <p className="saved-link-card__names">{link.gptNames.slice(0, 6).join(' · ')}</p>
              )}
            </div>
            {deleteTarget === link.id ? (
              <div className="saved-link-card__delete-confirm">
                <p>Удалить ссылку и найденные для неё игры? Сами игры и оценки в Rate APP останутся.</p>
                <button type="button" onClick={() => setDeleteTarget(null)} disabled={busyId === link.id}>Отмена</button>
                <button type="button" onClick={() => void act(link.id, 'delete')} disabled={busyId === link.id}>Удалить</button>
              </div>
            ) : (
              <div className="saved-link-card__actions">
                <a href={link.url} target="_blank" rel="noopener noreferrer" title="Открыть исходную ссылку">
                  <Icon name="globe" size={17} /> Открыть
                </a>
                <button type="button" disabled={busyId !== null}
                  onClick={() => void act(link.id, link.status === 'failed' ? 'retry' : 'refresh')}>
                  <Icon name="arrow" size={16} /> {link.status === 'failed' ? 'Повторить' : 'Обновить'}
                </button>
                <button type="button" className="saved-link-card__delete" aria-label={'Удалить ссылку ' + (link.title || displayHost(link.url))}
                  onClick={() => setDeleteTarget(link.id)} disabled={busyId !== null}>
                  <Icon name="trash" size={18} />
                </button>
              </div>
            )}
          </motion.article>
        ))}
      </div>
      {!loading && nextBefore != null && (
        <button type="button" className="saved-links-more" disabled={loadingMore}
          onClick={() => void fetchLinks(nextBefore)}>
          {loadingMore ? 'Загружаем…' : 'Показать ещё'}
        </button>
      )}
    </section>
  )
}
