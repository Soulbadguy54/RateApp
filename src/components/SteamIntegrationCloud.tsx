import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { sessionFetch } from '../sessionFetch'
import Icon from './Icon'
import './SteamIntegrationCloud.css'

type SteamConnection = { connected: boolean; steamId64: string | null }
type Origin = { x: number; y: number }
type Overview = {
  steamId64: string
  configured: boolean
  profile: { name: string; avatarUrl: string | null; profileUrl: string; profilePublic: boolean | null }
  gameCount: number
  canSync: boolean
  redFlags: string[]
  lastSyncedAt: string | null
}
type NewGame = { igdbId: number; title: string; coverUrl: string | null; status: 'playing' | 'wishlist'; apps: { appid: number; minutes: number | null }[] }
type Unresolved = { appid: number; name: string; reason?: string }
type Preview = { token: string; items: NewGame[]; unresolved: Unresolved[] }
type SyncResult = { created: { igdbId: number; title: string; status: 'playing' | 'wishlist' }[]; unresolved: Unresolved[] }

const STEAM_PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'
const messages: Record<string, string> = {
  connected: 'Steam успешно подключён.',
  cancelled: 'Подтверждение Steam отменено.',
  invalid: 'Steam вернул некорректное подтверждение. Попробуйте снова.',
  expired: 'Время подтверждения истекло. Подключите Steam повторно.',
  session: 'Сессия Rate APP изменилась. Войдите в приложение и попробуйте снова.',
  unavailable: 'Не удалось проверить ответ Steam. Попробуйте ещё раз.',
  taken: 'Этот Steam-аккаунт уже привязан к другому пользователю Rate APP.',
}

const displayStatus = (status: 'playing' | 'wishlist') => status === 'playing' ? 'Прохожу' : 'Хочу пройти'

export default function SteamIntegrationCloud({
  onFindUnmatched,
  onSynced,
}: {
  onFindUnmatched?: (name: string, appid: number) => void
  onSynced?: () => void
}) {
  const [connection, setConnection] = useState<SteamConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [origin, setOrigin] = useState<Origin>({ x: 0, y: 0 })
  const [overview, setOverview] = useState<Overview | null>(null)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<SyncResult | null>(null)
  const cloudRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()

  const refresh = async () => {
    try {
      const response = await sessionFetch('/api/steam/connection', { cache: 'no-store' })
      if (!response.ok) throw new Error('Состояние Steam недоступно.')
      const data = await response.json() as SteamConnection
      setConnection({ connected: Boolean(data.connected), steamId64: data.steamId64 ?? null })
    } catch {
      setError('Не удалось проверить подключение Steam.')
    } finally {
      setLoading(false)
    }
  }

  const refreshOverview = async () => {
    setChecking(true)
    try {
      const response = await sessionFetch('/api/steam/overview', { cache: 'no-store' })
      if (!response.ok) throw new Error('Не удалось проверить библиотеку Steam.')
      setOverview(await response.json() as Overview)
    } catch {
      setError('Не удалось проверить библиотеку Steam. Попробуйте снова.')
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void refresh()
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('steam')
    if (outcome) {
      setError(messages[outcome] ?? 'Не удалось завершить подключение Steam.')
      setOpen(true)
      const url = new URL(window.location.href)
      url.searchParams.delete('steam')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (connection?.connected) void refreshOverview()
  }, [open, connection?.connected])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('keydown', onEscape)
      cloudRef.current?.focus()
    }
  }, [open])

  const onOpen = () => {
    const bounds = cloudRef.current?.getBoundingClientRect()
    if (bounds) setOrigin({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
    setPreview(null)
    setResult(null)
    setError('')
    setOpen(true)
  }

  const sync = async () => {
    if (syncing || !overview?.canSync) return
    setSyncing(true)
    setError('')
    try {
      const action = preview ? '/api/steam/commit' : '/api/steam/preview'
      const response = await sessionFetch(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preview ? { token: preview.token } : {}),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null
        throw new Error(body?.detail || 'Не удалось синхронизировать Steam.')
      }
      if (preview) {
        setResult(await response.json() as SyncResult)
        setPreview(null)
        onSynced?.()
        await refreshOverview()
      } else {
        setPreview(await response.json() as Preview)
        setResult(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка Steam синхронизации.')
    } finally {
      setSyncing(false)
    }
  }

  const unlink = async () => {
    setUnlinking(true)
    try {
      const response = await sessionFetch('/api/steam/connection', { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось отвязать Steam.')
      setConnection({ connected: false, steamId64: null })
      setOverview(null)
      setPreview(null)
      setResult(null)
      setError('Steam отключён. Ваши игры и оценки в Rate APP не затронуты.')
    } catch {
      setError('Не удалось отвязать Steam. Повторите попытку.')
    } finally {
      setUnlinking(false)
    }
  }

  const connected = connection?.connected === true
  const x = origin.x ? origin.x - window.innerWidth / 2 : 0
  const y = origin.y ? origin.y - window.innerHeight / 2 : 0
  const items = preview?.items ?? result?.created ?? []
  const unresolved = preview?.unresolved ?? result?.unresolved ?? []

  return (
    <>
      <button type="button" ref={cloudRef}
        className={'profile-steam-cloud' + (connected ? ' profile-steam-cloud--connected' : '')}
        onClick={onOpen}
        aria-label={loading ? 'Steam — проверяем подключение' : connected ? 'Steam подключён, открыть настройки' : 'Подключить Steam'}
        title={connected ? 'Steam подключён' : 'Подключить Steam'}>
        <img src="/brand/steam.svg" alt="" aria-hidden="true" draggable={false} />
        <span className={'profile-steam-cloud__status' +
          (connected ? ' profile-steam-cloud__status--connected' : '') +
          (loading ? ' profile-steam-cloud__status--pending' : '')} aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div key="steam-modal" className="steam-integration__backdrop"
              role="presentation"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : .22 }}
              onPointerDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
              <motion.section role="dialog" aria-modal="true"
                aria-label={connected ? 'Подключённый аккаунт Steam' : 'Подключение Steam'}
                className="steam-integration__panel"
                initial={reducedMotion ? false : { opacity: .65, scale: .16, x, y, borderRadius: 32 }}
                animate={{ opacity: 1, scale: 1, x: 0, y: 0, borderRadius: 21 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: .6, scale: .16, x, y, borderRadius: 32 }}
                transition={reducedMotion ? { duration: 0 } : {
                  type: 'spring', stiffness: 300, damping: 32, mass: .86,
                }}>
                <div className="steam-integration__heading">
                  <span className="steam-integration__brand"><img src="/brand/steam.svg" alt="" /> Steam</span>
                  <button ref={closeRef} type="button" aria-label="Закрыть подключение Steam"
                    className="steam-integration__close" onClick={() => setOpen(false)}>
                    <Icon name="x" size={19} />
                  </button>
                </div>
                <h2>{connected ? 'Steam подключён' : 'Подключить Steam'}</h2>
                <p className="steam-integration__intro">
                  {connected
                    ? 'Игры загружаются только по вашему запросу. Существующие оценки, статусы и коллекции не изменяются.'
                    : 'Привяжите Steam, чтобы импортировать библиотеку и время игры в Rate APP.'}
                </p>
                {error && <p className="steam-integration__notice" role="status">{error}</p>}
                {connected ? (
                  <>
                    {overview?.profile && (
                      <div className="steam-integration__profile">
                        {overview.profile.avatarUrl
                          ? <img src={overview.profile.avatarUrl} alt="" />
                          : <Icon name="user" size={28} />}
                        <div>
                          <strong>{overview.profile.name}</strong>
                          <a href={overview.profile.profileUrl} target="_blank" rel="noopener noreferrer">Открыть профиль Steam</a>
                        </div>
                      </div>
                    )}
                    <p className="steam-integration__account">SteamID: <strong>{connection?.steamId64}</strong></p>
                    {checking && <p className="steam-integration__muted" role="status">Проверяем доступность библиотеки Steam…</p>}
                    {overview && (
                      <p className="steam-integration__muted">
                        Игр доступно: {overview.gameCount} · Последняя синхронизация: {overview.lastSyncedAt
                          ? new Date(overview.lastSyncedAt).toLocaleString('ru-RU')
                          : 'ещё не проводилась'}
                      </p>
                    )}
                    {overview?.redFlags.map(flag => (
                      <p className="steam-integration__warning" role="alert" key={flag}>{flag}</p>
                    ))}
                    <a className="steam-integration__privacy-link" href={STEAM_PRIVACY_URL}
                      target="_blank" rel="noopener noreferrer">Настройки приватности Steam <Icon name="arrow" size={16}/></a>
                    {(preview || result) && (
                      <div className="steam-integration__results" aria-label={preview ? 'Предпросмотр Steam' : 'Результат синхронизации'}>
                        <h3>{preview ? 'Будут добавлены' : 'Добавлены'} · {items.length}</h3>
                        {items.length === 0 && <p>Новых игр для добавления нет.</p>}
                        {items.map(item => (
                          <div className="steam-integration__game" key={item.igdbId}>
                            {'coverUrl' in item && typeof item.coverUrl === 'string' && <img src={item.coverUrl} alt="" />}
                            <div><strong>{item.title}</strong><span>{displayStatus(item.status)}</span></div>
                          </div>
                        ))}
                        <h3>Не удалось найти · {unresolved.length}</h3>
                        {unresolved.length === 0 && <p>Все доступные игры сопоставлены.</p>}
                        {unresolved.map(item => (
                          <button type="button" key={item.appid} className="steam-integration__unresolved"
                            title="Найти игру в базе Rate APP"
                            onClick={() => { onFindUnmatched?.(item.name, item.appid); setOpen(false) }}>
                            {item.name} <small>{item.reason === 'playtime_unavailable' ? 'Часы недоступны' : 'Steam #' + item.appid}</small> <Icon name="arrow" size={14} />
                          </button>
                        ))}
                      </div>
                    )}
                    {preview && <p className="steam-integration__muted">Это предпросмотр. Пока ничего не записано. Нажмите «Синхронизировать» ещё раз, чтобы подтвердить.</p>}
                    {result && <p className="steam-integration__notice" role="status">Синхронизировано новых игр: {result.created.length}. Сохранённые прохождения не менялись.</p>}
                    <button type="button" className="steam-integration__connect"
                      disabled={checking || syncing || !overview?.canSync}
                      onClick={() => void sync()}>
                      {syncing ? 'Синхронизируем…' : 'Синхронизировать'}
                    </button>
                    <button type="button" className="steam-integration__disconnect"
                      disabled={unlinking} onClick={() => void unlink()}>
                      {unlinking ? 'Отключаем…' : 'Отвязать Steam'}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="steam-integration__requirements">
                      <strong>Перед подключением</strong>
                      <p>В Steam откройте настройки приватности и установите:</p>
                      <ul>
                        <li>«Мой профиль» — <strong>Открытый</strong>.</li>
                        <li>«Сведения об играх» — <strong>Открытые</strong>.</li>
                        <li>Отключите «Всегда скрывать общее время игры», если включено.</li>
                      </ul>
                      <a href={STEAM_PRIVACY_URL} target="_blank" rel="noopener noreferrer"
                        className="steam-integration__privacy-link">Открыть настройки приватности Steam <Icon name="arrow" size={16} /></a>
                    </div>
                    <p className="steam-integration__safety">
                      Вход проходит на сайте Steam. Rate APP не получает пароль или код Steam Guard и не имеет доступа к закрытым играм.
                    </p>
                    <a className="steam-integration__connect" href="/api/steam/connect">
                      <img src="/brand/steam.svg" alt="" />
                      Войти в Steam
                    </a>
                  </>
                )}
                <p className="steam-integration__footnote">
                  Синхронизация запускается только вручную и никогда не перезаписывает ваши оценки, даты или статусы.
                </p>
              </motion.section>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
