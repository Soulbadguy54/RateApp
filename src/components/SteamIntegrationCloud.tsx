import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { sessionFetch } from '../sessionFetch'
import Icon from './Icon'
import { profileTintOption, type ProfileTint } from '../profilePalette'
import './SteamIntegrationCloud.css'

type SteamConnection = { connected: boolean; steamId64: string | null }
type Overview = {
  steamId64: string
  configured: boolean
  privacyIssue?: boolean
  profile: { name: string; avatarUrl: string | null; profileUrl: string; profilePublic: boolean | null }
  gameCount: number
  canSync: boolean
  redFlags: string[]
  lastSyncedAt: string | null
  alreadyAddedCount?: number
  nextSyncAt?: string | null
}
type NewGame = { igdbId: number; title: string; coverUrl: string | null; status: 'playing' | 'wishlist'; apps: { appid: number; minutes: number | null }[] }
type Unresolved = { appid: number; name: string; reason?: string }
type Preview = { token: string; items: NewGame[]; unresolved: Unresolved[]; nextSyncAt?: string }
type SyncResult = { created: { igdbId: number; title: string; status: 'playing' | 'wishlist' }[]; unresolved: Unresolved[] }

const STEAM_PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'
const messages: Record<string, string> = {
  connected: '',
  cancelled: 'Подтверждение Steam отменено.',
  invalid: 'Steam вернул некорректное подтверждение. Попробуйте снова.',
  expired: 'Время подтверждения истекло. Подключите Steam повторно.',
  session: 'Сессия Rate APP изменилась. Войдите в приложение и попробуйте снова.',
  unavailable: 'Не удалось проверить ответ Steam. Попробуйте еще раз.',
  taken: 'Этот Steam-аккаунт уже привязан к другому пользователю Rate APP.',
}

const displayStatus = (status: 'playing' | 'wishlist') => status === 'playing' ? 'Прохожу' : 'Хочу пройти'

function relativeSyncTime(iso: string, now: number): string {
  const elapsed = Math.max(1, Math.floor((now - Date.parse(iso)) / 60000))
  const unit = elapsed < 60 ? 'минут' : elapsed < 1440 ? 'часов' : elapsed < 43200 ? 'дней' : elapsed < 525600 ? 'месяцев' : 'лет'
  const count = elapsed < 60 ? elapsed : elapsed < 1440 ? Math.floor(elapsed / 60) : elapsed < 43200 ? Math.floor(elapsed / 1440) : elapsed < 525600 ? Math.floor(elapsed / 43200) : Math.floor(elapsed / 525600)
  const forms: Record<string, [string, string, string]> = {
    минут: ['минуту', 'минуты', 'минут'],
    часов: ['час', 'часа', 'часов'],
    дней: ['день', 'дня', 'дней'],
    месяцев: ['месяц', 'месяца', 'месяцев'],
    лет: ['год', 'года', 'лет'],
  }
  const [single, few, many] = forms[unit]
  const form = count % 10 === 1 && count % 100 !== 11 ? single : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? few : many
  return count + ' ' + form + ' назад'
}

function PrivacyChecklist({ compact = false }: { compact?: boolean }) {
  return (
    <div className={'steam-integration__requirements' + (compact ? ' steam-integration__requirements--compact' : '')}>
      <p>Откройте <a href={STEAM_PRIVACY_URL} target="_blank" rel="noopener noreferrer"
        className="steam-integration__privacy-link">настройки приватности Steam</a> и установите:</p>
      <ul>
        <li>Мой профиль — <strong>Открытый</strong></li>
        <li>Доступ к игровой информации — <strong>Открытый</strong></li>
        <li>Скрывать общее время в играх, даже если видны другие данные о них — <strong>снимите галочку</strong></li>
      </ul>
    </div>
  )
}

export default function SteamIntegrationCloud({
  onFindUnmatched,
  onSynced,
  tint = 'default',
}: {
  onFindUnmatched?: (name: string, appid: number) => void
  onSynced?: () => void
  tint?: ProfileTint
}) {
  const [connection, setConnection] = useState<SteamConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [unlinking, setUnlinking] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [overviewError, setOverviewError] = useState(false)
  const [checking, setChecking] = useState(false)
  const [dismissBusy, setDismissBusy] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<number[]>([])
  const [syncing, setSyncing] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [secondsNow, setSecondsNow] = useState(() => Date.now())
  const [nextSyncAt, setNextSyncAt] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const checkingGeneration = useRef(0)
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
    const generation = ++checkingGeneration.current
    const began = Date.now()
    setChecking(true)
    setOverviewError(false)
    try {
      const response = await sessionFetch('/api/steam/overview', { cache: 'no-store' })
      if (!response.ok) throw new Error('Не удалось проверить библиотеку Steam.')
      const data = await response.json() as Overview
      if (generation !== checkingGeneration.current) return
      setOverview(data)
      setNextSyncAt(data.nextSyncAt ?? null)
      setAvatarFailed(false)
    } catch {
      if (generation === checkingGeneration.current) setOverviewError(true)
    } finally {
      // Complete at least one full logo animation. Avoid a mid-keyframe snap
      // even when Steam answers much faster than the motion cycle.
      const remaining = Math.max(0, 1150 - (Date.now() - began))
      await new Promise(resolve => window.setTimeout(resolve, remaining))
      if (generation === checkingGeneration.current) setChecking(false)
    }
  }

  const dismissApp = async (appid: number) => {
    if (dismissBusy !== null) return
    setDismissBusy(appid)
    setError('')
    try {
      const response = await sessionFetch('/api/steam/ignored', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid }),
      })
      if (!response.ok) throw new Error()
      setDismissed(previous => previous.includes(appid) ? previous : [...previous, appid])
    } catch {
      setError('Не удалось скрыть игру. Повторите попытку.')
    } finally {
      setDismissBusy(null)
    }
  }

  useEffect(() => {
    void refresh()
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('steam')
    if (outcome) {
      setError(outcome === 'connected' ? '' : messages[outcome] ?? 'Не удалось завершить подключение Steam.')
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
    setSecondsNow(Date.now())
    const timer = window.setInterval(() => setSecondsNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onBack = (event: Event) => {
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('keydown', onEscape)
    window.addEventListener('rateapp:cancel-transient', onBack)
    return () => {
      window.removeEventListener('rateapp:cancel-transient', onBack)
      document.removeEventListener('keydown', onEscape)
      cloudRef.current?.focus()
    }
  }, [open])

  const onOpen = () => {
    setPreview(null)
    setResult(null)
    setOverview(null)
    setExpandedHeight(null)
    setDismissed([])
    setError('')
    setOpen(true)
  }

  const sync = async () => {
    if (pendingRef.current || !overview?.canSync || (!preview && nextSyncAt && Date.parse(nextSyncAt) > Date.now())) return
    pendingRef.current = true
    setSyncing(true)
    setError('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 90000)
    try {
      const action = preview ? '/api/steam/commit' : '/api/steam/preview'
      const response = await sessionFetch(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preview ? { token: preview.token } : {}),
        signal: controller.signal,
      })
      if (!response.ok) {
        // API details are diagnostic, not display copy (may contain internals).
        if (response.status === 429) {
          const seconds = Math.max(1, Number(response.headers.get('Retry-After') || '30'))
          setNextSyncAt(new Date(Date.now() + seconds * 1000).toISOString())
          throw new Error('Повторная проверка будет доступна через несколько минут.')
        }
        throw new Error(response.status === 409
          ? 'Доступ к библиотеке Steam изменился. Проверьте настройки приватности и повторите попытку.'
          : 'Не получилось синхронизировать игры. Попробуйте еще раз.')
      }
      if (preview) {
        setResult(await response.json() as SyncResult)
        setPreview(null)
        onSynced?.()
        void refreshOverview()
      } else {
        const data = await response.json() as Preview
        setPreview(data)
        setNextSyncAt(data.nextSyncAt ?? new Date(Date.now() + 30000).toISOString())
        setResult(null)
      }
    } catch (cause) {
      setError(controller.signal.aborted
        ? 'Проверка занимает слишком много времени. Попробуйте позже.'
        : cause instanceof Error ? cause.message : 'Не удалось синхронизировать игры.')
    } finally {
      window.clearTimeout(timeout)
      pendingRef.current = false
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
      setError('Steam отключен. Ваши игры и оценки в Rate APP не затронуты.')
    } catch {
      setError('Не удалось отвязать Steam. Повторите попытку.')
    } finally {
      setUnlinking(false)
    }
  }

  const connected = connection?.connected === true
  const selectedTint = profileTintOption(tint)
  // Portaled panel cannot inherit the profile header's custom properties.
  const panelStyle = {
    '--steam-accent': selectedTint.color,
    '--steam-accent-rgb': selectedTint.accentRgb,
    '--steam-tint-rgb': selectedTint.rgb,
    '--steam-tint-strength': tint === 'default' ? '.08' : '.26',
  } as CSSProperties
  const privacyBlocked = Boolean(overview?.privacyIssue)
  const showAccessHelp = connected && (privacyBlocked || overviewError || Boolean(overview?.redFlags?.length))
  // Intentionally avoid translating a 28px blurred glass surface across the
  // whole viewport: large scale/position springs caused costly re-rasterization
  // on high-refresh mobile screens. Entrance/exit move just a few pixels.
  const items = preview?.items ?? result?.created ?? []
  const unresolved = (preview?.unresolved ?? result?.unresolved ?? []).filter(item => !dismissed.includes(item.appid))
  const newCount = items.length
  const hasVisibleGames = newCount > 0 || unresolved.length > 0
  // Only actual games can expand the dialog. An empty preview/commit retains
  // the fixed compact footprint; a short list grows just enough to fit.
  useLayoutEffect(() => {
    if (!open || !connected || !hasVisibleGames) {
      setExpandedHeight(null)
      return
    }
    const content = contentRef.current
    const panel = panelRef.current
    if (!content || !panel) return
    const measure = () => {
      const computed = window.getComputedStyle(panel)
      const verticalPadding = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom)
      const screenHeight = window.visualViewport?.height ?? window.innerHeight
      const compact = Math.min(380, Math.max(0, screenHeight - 24))
      // Safety gap to the viewport: longer lists scroll inside the same glass.
      const available = Math.max(compact, screenHeight - 12)
      const natural = content.scrollHeight + verticalPadding
      const target = Math.min(available, Math.max(compact, Math.ceil(natural)))
      setExpandedHeight(previous => previous !== null && Math.abs(previous - target) < 2 ? previous : target)
    }
    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(content)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [open, connected, hasVisibleGames, preview, result, overview, dismissed, error, checking])
  const cooldownLeft = nextSyncAt ? Math.max(0, Math.ceil((Date.parse(nextSyncAt) - secondsNow) / 1000)) : 0
  const cooldownLabel = cooldownLeft > 0 ? Math.floor(cooldownLeft / 60) + ':' + String(cooldownLeft % 60).padStart(2, '0') : null

  return (
    <>
      <button type="button" ref={cloudRef}
        className={'profile-steam-cloud' + (connected ? ' profile-steam-cloud--connected' : '')}
        onClick={event => { event.stopPropagation(); onOpen() }}
        onPointerDown={event => event.stopPropagation()}
        aria-label={loading ? 'Steam — проверяем подключение' : connected ? 'Steam подключен, открыть настройки' : 'Подключить Steam'}
        title={connected ? 'Steam подключен' : 'Подключить Steam'}>
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
                aria-label={connected ? 'Подключенный аккаунт Steam' : 'Подключение Steam'}
                ref={panelRef}
                className={'steam-integration__panel' + (connected ? ' steam-integration__panel--connected' : '') + (hasVisibleGames ? ' steam-integration__panel--expanded' : '')}
                style={{ ...panelStyle, ...(hasVisibleGames && expandedHeight !== null ? { height: expandedHeight + 'px' } : {}) }}
                data-mode={hasVisibleGames ? 'results' : 'compact'}
                initial={reducedMotion ? false : { opacity: 0, scale: .975, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: .985, y: 6 }}
                transition={reducedMotion ? { duration: 0 } : {
                  duration: .28, ease: [0.22, 1, 0.36, 1],
                }}>
                <div ref={contentRef} className="steam-integration__content">
                <div className="steam-integration__heading">
                  <div className="steam-integration__brand">
                    <img src="/brand/steam.svg" alt="" className={checking ? 'steam-integration__logo--checking' : ''} />
                    <h2 aria-live="polite">{connected ? checking ? 'Проверка соединения' : 'Steam подключен' : 'Подключить Steam'}</h2>
                  </div>
                  <button ref={closeRef} type="button" aria-label="Закрыть подключение Steam"
                    className="steam-integration__close" onClick={() => setOpen(false)}>
                    <Icon name="x" size={19} />
                  </button>
                </div>
                <p className="steam-integration__intro">
                  {connected
                    ? 'Игры синхронизируются только по вашему запросу.'
                    : 'Привяжите Steam, чтобы импортировать библиотеку в Rate APP.'}
                </p>
                {!connected && error && <p className="steam-integration__notice" role="status">{error}</p>}
                {connected ? (
                  <>
                    {overview ? (
                    <a className="steam-integration__profile"
                      href={overview?.profile?.profileUrl || 'https://steamcommunity.com/profiles/' + connection?.steamId64 + '/'}
                      target="_blank" rel="noopener noreferrer"
                      aria-label="Открыть профиль Steam" title="Открыть профиль Steam">
                      {overview?.profile?.avatarUrl && !avatarFailed
                        ? <img src={overview.profile.avatarUrl} alt="" onError={() => setAvatarFailed(true)} />
                        : <span className="steam-integration__avatar-fallback"><img src="/brand/steam.svg" alt="" /></span>}
                      <span className="steam-integration__profile-info">
                        <strong>{overview?.profile?.name || 'Профиль Steam'}</strong>
                        <small>Steam ID: {connection?.steamId64}</small>
                      </span>
                      <Icon name="external-link" size={17} />
                    </a>
                    ) : (
                      <div className="steam-integration__profile steam-integration__profile--loading"
                        aria-label="Профиль Steam загружается">
                        <span className="steam-integration__avatar-placeholder"><Icon name="user" size={24} /></span>
                        <span className="steam-integration__profile-info steam-integration__profile-info--placeholder"
                          aria-hidden="true" />
                        <Icon name="external-link" size={17} />
                      </div>
                    )}
                    {(preview || result) && overview && (overview.alreadyAddedCount ?? 0) > 0 && (
                      <div className="steam-integration__already-added" aria-label={'Уже добавлено: ' + overview.alreadyAddedCount}>
                        Уже добавлено: <strong>{overview.alreadyAddedCount}</strong>
                      </div>
                    )}
                    <p className="steam-integration__last-sync">
                      Последняя синхронизация: {overview?.lastSyncedAt
                        ? relativeSyncTime(overview.lastSyncedAt, secondsNow)
                        : '—'}
                    </p>
                    {error && <p className="steam-integration__notice" role="status">{error}</p>}
                    {showAccessHelp && (
                      <div className="steam-integration__access-warning" role="alert">
                        <div className="steam-integration__warning-title">
                          <Icon name="alert-triangle" size={19} />
                          <strong>{privacyBlocked
                            ? 'Проверьте настройки приватности Steam'
                            : 'Пока не удается проверить доступ к библиотеке Steam'}</strong>
                        </div>
                        <PrivacyChecklist compact />
                        <button type="button" className="steam-integration__recheck"
                          onClick={() => void refreshOverview()} disabled={checking}>
                          {checking ? 'Проверяем…' : 'Проверить доступ снова'}
                        </button>
                      </div>
                    )}
                    {(preview || result) && (
                      <div className="steam-integration__results" aria-label={preview ? 'Предпросмотр Steam' : 'Результат синхронизации'}>
                        {items.length > 0 && <h3>{preview ? 'Будут добавлены' : 'Добавлены'}: {items.length}</h3>}
                        {items.map(item => (
                          <div className="steam-integration__game" key={item.igdbId}>
                            {'coverUrl' in item && typeof item.coverUrl === 'string' && <img src={item.coverUrl} alt="" />}
                            <div><strong>{item.title}</strong><span>{displayStatus(item.status)}</span></div>
                          </div>
                        ))}
                        <h3>Нужно найти в Rate APP: {unresolved.length}</h3>
                        {unresolved.length > 0 && <p>Попробуйте добавить игру вручную.</p>}
                        <AnimatePresence initial={false}>
                        {unresolved.map(item => (
                          <motion.div key={item.appid} layout
                            className="steam-integration__unresolved"
                            initial={reducedMotion ? false : { opacity: 0, height: 0, x: 12 }}
                            animate={{ opacity: 1, height: 'auto', x: 0 }}
                            exit={reducedMotion ? { opacity: 0, height: 0 } : { opacity: 0, height: 0, x: 22, scale: .97 }}
                            transition={{ duration: reducedMotion ? 0 : .28, ease: 'easeOut' }}>
                            <a className="steam-integration__unresolved-title"
                              href={'https://store.steampowered.com/app/' + item.appid + '/'}
                              target="_blank" rel="noopener noreferrer" title="Открыть страницу игры в Steam">
                              {item.name}
                            </a>
                            <div className="steam-integration__unresolved-actions">
                              <button type="button" className="steam-integration__unresolved-search" aria-label={'Найти в базе Rate APP: ' + item.name}
                                title="Найти в Rate APP" onClick={() => { onFindUnmatched?.(item.name, item.appid); setOpen(false) }}>
                                <Icon name="search" size={17} />
                              </button>
                              <button type="button" className="steam-integration__unresolved-dismiss" aria-label={'Больше не показывать: ' + item.name}
                                title="Не показывать при будущих синхронизациях"
                                disabled={dismissBusy !== null} onClick={() => void dismissApp(item.appid)}>
                                <Icon name="x" size={17} />
                              </button>
                            </div>
                          </motion.div>
                        ))}
                        </AnimatePresence>
                      </div>
                    )}
                    {preview && <p className="steam-integration__muted">Это предпросмотр, игры еще не синхронизированы</p>}
                    {result && result.created.length > 0 && <p className="steam-integration__notice" role="status">Синхронизировано новых игр: {result.created.length}. Сохраненные прохождения не менялись.</p>}
                    <button type="button" className={'steam-integration__connect steam-integration__connect--sync' + (syncing ? ' steam-integration__connect--busy' : '')}
                      disabled={checking || syncing || !overview?.canSync || (!preview && cooldownLeft > 0)}
                      aria-busy={syncing} onClick={() => void sync()}>
                      <span className="steam-integration__sync-icon" aria-hidden="true"><Icon name="refresh" size={19} /></span>
                      {syncing ? (preview ? 'Сохраняем игры…' : 'Проверяем библиотеку…')
                        : !preview && cooldownLabel ? 'Повторить через ' + cooldownLabel : 'Синхронизировать'}
                    </button>
                    <button type="button" className="steam-integration__disconnect"
                      disabled={unlinking} onClick={() => void unlink()}>
                      {unlinking ? 'Отключаем…' : 'Отвязать Steam'}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="steam-integration__requirements-wrap">
                      <p className="steam-integration__lead">Перед подключением к Steam:</p>
                      <PrivacyChecklist />
                    </div>
                    <p className="steam-integration__safety">
                      Вход проходит на сайте Steam. Rate APP не получает пароль или код Steam Guard.
                    </p>
                    <a className={'steam-integration__connect' + (signingIn ? ' steam-integration__connect--busy' : '')}
                      href="/api/steam/connect" onClick={() => setSigningIn(true)} aria-busy={signingIn}>
                      <img src="/brand/steam.svg" alt="" />
                      {signingIn ? 'Открываем Steam…' : 'Войти в Steam'}
                    </a>
                    <p className="steam-integration__footnote">Синхронизация запускается только вручную.</p>
                  </>
                )}
                </div>
              </motion.section>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
