import { sessionFetch } from './sessionFetch'
import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'

type PushConfig = { enabled: boolean; publicKey: string; devices: number }
type PushState = { config: PushConfig; subscribed: boolean; permission: NotificationPermission }
const PUSH_CHANGED_EVENT = 'rateapp:push-changed'
type PushPhase = 'permission' | 'worker' | 'service' | 'server'
const PUSH_PHASE_LABELS: Record<PushPhase, string> = {
  permission: 'Ожидаем разрешение браузера…',
  worker: 'Подготавливаем уведомления…',
  service: 'Подключаем Push-службу устройства…',
  server: 'Сохраняем подписку…',
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

function supportsWebPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function rememberChoice(user: string): void {
  try { window.localStorage.setItem(`rateapp:push-invite:v1:${user}`, 'seen') } catch { /* Private browsing. */ }
}

function hasSeenInvite(user: string): boolean {
  try { return window.localStorage.getItem(`rateapp:push-invite:v1:${user}`) === 'seen' } catch { return false }
}

function decodeVapidKey(encoded: string): Uint8Array<ArrayBuffer> {
  const padded = (encoded + '='.repeat((4 - encoded.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/')
  const bytes = atob(padded)
  const output = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) output[i] = bytes.charCodeAt(i)
  return output
}

function requestBody(subscription: PushSubscription): string {
  const json = subscription.toJSON()
  return JSON.stringify({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh || '',
      auth: json.keys?.auth || '',
    },
  })
}

async function readPushState(): Promise<PushState> {
  const response = await sessionFetch('/api/push/config')
  if (!response.ok) throw new Error('Не удалось проверить настройки уведомлений.')
  const config = await response.json() as PushConfig
  const permission = supportsWebPush() ? Notification.permission : 'default'
  const registration = supportsWebPush() ? await navigator.serviceWorker.ready : null
  const subscription = await registration?.pushManager.getSubscription()
  return { config, permission, subscribed: Boolean(subscription && config.devices > 0) }
}

const pushStateCache = new Map<string, PushState>()
const pushStateRequests = new Map<string, Promise<PushState>>()

export function cachedPushState(user: string): PushState | null {
  return pushStateCache.get(user) ?? null
}

export function preloadPushState(user: string, refresh = false): Promise<PushState> {
  if (refresh) {
    pushStateCache.delete(user)
    pushStateRequests.delete(user)
  }
  const cached = pushStateCache.get(user)
  if (cached) return Promise.resolve(cached)
  const active = pushStateRequests.get(user)
  if (active) return active
  const task = readPushState().then((state) => {
    if (pushStateRequests.get(user) === task) pushStateCache.set(user, state)
    return state
  }).catch((error: unknown) => {
    if (pushStateRequests.get(user) === task) pushStateRequests.delete(user)
    throw error
  })
  pushStateRequests.set(user, task)
  return task
}

export function clearPushStateCache(user: string): void {
  pushStateCache.delete(user)
  pushStateRequests.delete(user)
}

/** Must be called directly from a click handler before any other await. */
async function enablePush(publicKey: string, onPhase?: (phase: PushPhase) => void): Promise<void> {
  if (!supportsWebPush()) throw new Error('Браузер не поддерживает push-уведомления.')
  // The permission request needs the original user activation.
  onPhase?.('permission')
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Разреши уведомления для RateApp в настройках браузера и телефона.')
  }

  onPhase?.('worker')
  const registration = await withTimeout(
    navigator.serviceWorker.ready,
    8000,
    'Служба уведомлений приложения не запустилась. Перезапусти RateApp и повтори попытку.',
  )
  onPhase?.('service')
  // PushManager talks to the browser/OS push provider, not to the RateApp API.
  // Some devices leave subscribe() unresolved when the provider is unreachable.
  // If it resolves late, the next attempt can reuse getSubscription().
  const subscription = await withTimeout((async () => {
    const current = await registration.pushManager.getSubscription()
    return current ?? registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(publicKey),
    })
  })(), 20000, 'Push-служба устройства не ответила за 20 секунд. Проверь подключение и попробуй снова.')

  onPhase?.('server')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 10000)
  let response: Response
  try {
    response = await sessionFetch('/api/push/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(subscription),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Сервер не ответил за 10 секунд. Повтори подключение уведомлений.')
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.detail || 'Не удалось подключить уведомления.')
  }
  window.dispatchEvent(new Event(PUSH_CHANGED_EVENT))
}

export async function disconnectPushForLogout(): Promise<void> {
  if (!supportsWebPush()) return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  const response = await sessionFetch('/api/push/subscription', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody(subscription),
  })
  if (!response.ok) throw new Error('Не удалось отключить подписку.')
  await subscription.unsubscribe()
  window.dispatchEvent(new Event(PUSH_CHANGED_EVENT))
}

export default function PushSettings({ user, onOpenWishlist }: { user: string; onOpenWishlist: () => void }) {
  const supported = supportsWebPush()
  const [state, setState] = useState<PushState | null>(() => cachedPushState(user))
  const [busy, setBusy] = useState(false)
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null)
  const [phase, setPhase] = useState<PushPhase | null>(null)
  const pendingRef = useRef(false)
  const shouldReduceMotion = useReducedMotion()
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    const refresh = () => {
      void preloadPushState(user, true).then(next => {
        if (active) setState(next)
      }).catch(() => {
        if (active) setMessage('Не удалось проверить уведомления.')
      })
    }
    void preloadPushState(user).then(next => {
      if (active) setState(next)
    }).catch(() => {
      if (active) setMessage('Не удалось проверить уведомления.')
    })
    window.addEventListener(PUSH_CHANGED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener(PUSH_CHANGED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [user])

  const confirmedEnabled = state?.subscribed === true && state.permission === 'granted'
  const enabled = optimisticEnabled ?? confirmedEnabled

  const toggle = () => {
    if (!state?.config.enabled || !supported || pendingRef.current) return
    const next = !enabled

    // The user action updates the visual state before the network/OS flow.
    // The browser push permission dialog must still be requested on this click.
    pendingRef.current = true
    setBusy(true)
    setOptimisticEnabled(next)
    setMessage('')

    void (async () => {
      try {
        if (next) await enablePush(state.config.publicKey, setPhase)
        else await disconnectPushForLogout()

        rememberChoice(user)
        // Keep the success state even if a later configuration refresh fails.
        setState((previous) => previous && ({
          ...previous,
          subscribed: next,
          permission: supported ? Notification.permission : 'default',
        }))
        // enablePush / disconnectPushForLogout already dispatch PUSH_CHANGED_EVENT.
        // That refresh runs in the background; don't keep the toggle busy for it.
      } catch (error) {
        // Drop the optimistic state immediately; reconciliation should not block UI.
        void preloadPushState(user, true).then(setState).catch(() => {})
        setMessage(error instanceof Error ? error.message : 'Не удалось изменить настройки.')
      } finally {
        setOptimisticEnabled(null)
        setPhase(null)
        pendingRef.current = false
        setBusy(false)
      }
    })()
  }

  const iosHelp = /iPad|iPhone|iPod/.test(navigator.userAgent)
    ? 'На iPhone уведомления доступны для приложения, добавленного на экран «Домой».'
    : 'Включить уведомления можно в установленном RateApp.'

  return (
    <section className="info-card push-settings" aria-label="Настройки уведомлений">
      <span className="eyebrow">УВЕДОМЛЕНИЯ</span>
      <div className="push-settings__row">
        <div className="push-settings__text">
          <h2>Релизы игр</h2>
          <p>Уведомим о релизе игры из коллекции{' '}
            <button type="button" className="push-settings__collection-link" onClick={onOpenWishlist}>Хочу пройти</button>
          </p>
        </div>
        {state ? <button
          type="button"
          className="push-switch"
          role="switch"
          aria-label="Уведомления о выходе игр"
          aria-checked={enabled}
          aria-busy={busy}
          data-pending={busy}
          disabled={!supported || !state?.config.enabled || busy}
          onClick={toggle}
        >
          <motion.span
            className="push-switch__track"
            initial={false}
            animate={{
              backgroundColor: enabled ? '#8cf27d' : '#424753',
              borderColor: enabled ? '#8cf27d' : 'rgba(255,255,255,.22)',
            }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: .2, ease: 'easeOut' }}
          >
            <motion.span
              className="push-switch__thumb"
              initial={false}
              animate={{
                x: enabled ? 20 : 0,
                backgroundColor: enabled ? '#121816' : '#ffffff',
              }}
              transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 31 }}
            />
          </motion.span>
        </button> : <span className="push-switch__loading" role="status" aria-label="Загружаем настройки уведомлений" />}
      </div>
      {!supported && <p className="push-settings__note">{iosHelp}</p>}
      {supported && state && !state.config.enabled && <p className="push-settings__note">Уведомления временно недоступны.</p>}
      {supported && state?.permission === 'denied' && !enabled &&
        <p className="push-settings__note">Разреши уведомления в настройках браузера или телефона.</p>}
      {busy && optimisticEnabled && phase && <p className="push-settings__note" role="status">{PUSH_PHASE_LABELS[phase]}</p>}
      {message && <p className="push-settings__note" role="status">{message}</p>}
    </section>
  )
}

export function PushOnboarding({ user }: { user: string }) {
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [phase, setPhase] = useState<PushPhase | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let active = true
    setVisible(false)
    if (!supportsWebPush() || hasSeenInvite(user) || Notification.permission === 'denied') return
    void preloadPushState(user).then(state => {
      if (!active) return
      if (state.config.enabled && !state.subscribed) {
        setConfig(state.config)
        setVisible(true)
      }
    }).catch(() => { /* Do not interrupt entry if push settings cannot be loaded. */ })
    return () => { active = false }
  }, [user])

  useEffect(() => {
    if (!visible) return
    buttonRef.current?.focus()
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [visible, user])

  const dismiss = () => {
    rememberChoice(user)
    setVisible(false)
  }

  const accept = async () => {
    if (!config || busy) return
    setBusy(true)
    setMessage('')
    try {
      await enablePush(config.publicKey, setPhase)
      dismiss()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось подключить уведомления.')
      if (supportsWebPush() && Notification.permission === 'denied') rememberChoice(user)
    } finally {
      setPhase(null)
      setBusy(false)
    }
  }

  if (!visible) return null
  return (
    <div className="push-invite__backdrop">
      <section className="push-invite" role="dialog" aria-modal="true"
        aria-labelledby="push-invite-title" aria-describedby="push-invite-description">
        <div className="push-invite__icon" aria-hidden="true">
          <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </svg>
        </div>
        <h2 id="push-invite-title">Не пропусти выход игры</h2>
        <p id="push-invite-description">Напомним, когда выйдет игра из твоего списка «Хочу пройти».</p>
        <button ref={buttonRef} type="button" className="push-invite__allow" disabled={busy}
          onClick={() => { void accept() }}>
          {busy ? 'Подключаем…' : 'Включить уведомления'}
        </button>
        <button type="button" className="push-invite__later" disabled={busy} onClick={dismiss}>
          Не сейчас
        </button>
        {busy && phase && <p className="push-settings__note" role="status">{PUSH_PHASE_LABELS[phase]}</p>}
        {message && <p className="push-settings__note" role="status">{message}</p>}
      </section>
    </div>
  )
}
