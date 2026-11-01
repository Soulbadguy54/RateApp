import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { sessionFetch } from '../sessionFetch'
import Icon from './Icon'
import './SteamIntegrationCloud.css'

type SteamConnection = { connected: boolean; steamId64: string | null }
type Origin = { x: number; y: number }

const STEAM_PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'

const messages: Record<string, string> = {
  connected: 'Steam успешно подключён. Импорт игр пока не включён.',
  cancelled: 'Подтверждение Steam отменено.',
  invalid: 'Steam вернул некорректное подтверждение. Попробуйте снова.',
  expired: 'Время подтверждения истекло. Подключите Steam повторно.',
  session: 'Сессия Rate APP изменилась. Войдите в приложение и попробуйте снова.',
  unavailable: 'Не удалось проверить ответ Steam. Попробуйте ещё раз.',
  taken: 'Этот Steam-аккаунт уже привязан к другому пользователю Rate APP.',
}

export default function SteamIntegrationCloud() {
  const [connection, setConnection] = useState<SteamConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [origin, setOrigin] = useState<Origin>({ x: 0, y: 0 })
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

  useEffect(() => {
    void refresh()
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('steam')
    if (outcome) {
      setError(messages[outcome] ?? 'Не удалось завершить подключение Steam.')
      setOpen(true)
      // Preserve App navigation history state; discard only our one-time result.
      const url = new URL(window.location.href)
      url.searchParams.delete('steam')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  }, [])

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
    setOpen(true)
  }

  const unlink = async () => {
    setUnlinking(true)
    try {
      const response = await sessionFetch('/api/steam/connection', { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось отвязать Steam.')
      setConnection({ connected: false, steamId64: null })
      setError('Steam отключён. Ваши игры и оценки в Rate APP не затронуты.')
    } catch {
      setError('Не удалось отвязать Steam. Повторите попытку.')
    } finally { setUnlinking(false) }
  }

  const connected = connection?.connected === true
  const x = origin.x ? origin.x - window.innerWidth / 2 : 0
  const y = origin.y ? origin.y - window.innerHeight / 2 : 0

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
                initial={reducedMotion ? false : {
                  opacity: .65, scale: .16, x, y, borderRadius: 32,
                }}
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
                    ? 'Аккаунт привязан. Синхронизация библиотеки появится отдельно — сейчас игры не импортируются.'
                    : 'Привяжите Steam, чтобы в дальнейшем перенести библиотеку и время, проведённое в играх, в Rate APP.'}
                </p>
                {error && <p className="steam-integration__notice" role="status">{error}</p>}
                {connected ? (
                  <>
                    <p className="steam-integration__account">SteamID: <strong>{connection?.steamId64}</strong></p>
                    <a className="steam-integration__privacy-link" href={STEAM_PRIVACY_URL}
                      target="_blank" rel="noopener noreferrer">Настройки приватности Steam <Icon name="arrow" size={16}/></a>
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
                      Вход проходит на сайте Steam. Rate APP не получает пароль или код Steam Guard и не имеет доступа к закрытым играм. Позже по вашему подтверждению мы сможем получать общедоступную библиотеку и суммарные часы игры.
                    </p>
                    <a className="steam-integration__connect" href="/api/steam/connect">
                      <img src="/brand/steam.svg" alt="" />
                      Войти через Steam
                    </a>
                  </>
                )}
                <p className="steam-integration__footnote">
                  Уже добавленные игры, оценки и коллекции остаются вашими. Привязка Steam ничего в них не меняет.
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
