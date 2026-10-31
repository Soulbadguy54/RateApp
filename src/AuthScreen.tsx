import { useState } from 'react'
import './auth.css'

export type AuthUser = {
  id: number
  email: string
  nickname: string
  profileTint?: string
  avatarVersion?: number
  createdAt: string
  public: boolean
}

type Mode = 'login' | 'register'
const registrationDisabled = import.meta.env.VITE_DISABLE_REGISTRATION === '1'

const apiErrorDetail = (data: unknown): string | null => {
  if (!data || typeof data !== 'object' || !('detail' in data)) return null

  const detail = (data as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail

  if (Array.isArray(detail)) {
    const firstMessage = detail.find(
      (item) => item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string',
    )
    if (firstMessage && typeof firstMessage === 'object' && 'msg' in firstMessage) {
      return String(firstMessage.msg)
    }
  }

  return null
}

export default function AuthScreen({
  onAuthenticated,
  sessionExpired = false,
}: {
  onAuthenticated: (user: AuthUser) => void
  sessionExpired?: boolean
}) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [nickname, setNickname] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const switchMode = (next: Mode) => {
    setMode(next)
    setError('')
    setPin('')
    setPinConfirm('')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (mode === 'register' && pin !== pinConfirm) {
      setError('PIN-коды не совпадают.')
      return
    }

    setBusy(true)
    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login'
      const response = await fetch(new URL(endpoint, window.location.origin), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(
          mode === 'register'
            ? { email, nickname, pin }
            : { identifier, pin },
        ),
      })

      const raw = await response.text()
      let data: unknown = null
      if (raw) {
        try {
          data = JSON.parse(raw)
        } catch {
          data = null
        }
      }

      if (!response.ok) {
        setError(apiErrorDetail(data) ?? `Ошибка сервера (${response.status}). Попробуйте ещё раз.`)
        return
      }

      if (!data || typeof data !== 'object' || !('id' in data)) {
        setError('Сервер вернул некорректный ответ. Попробуйте ещё раз.')
        return
      }

      onAuthenticated(data as AuthUser)
    } catch {
      let healthAvailable = false
      try {
        const healthResponse = await fetch('/api/health', {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        healthAvailable = healthResponse.ok
      } catch {
        healthAvailable = false
      }

      setError(
        healthAvailable
          ? 'Сервер доступен, но запрос входа блокируется браузером или PWA. Полностью закрой приложение и открой снова.'
          : 'Не удалось связаться с сервером. Проверь соединение и попробуй ещё раз.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand__mark">R</span>
          <div>
            <strong>RateApp</strong>
            <span>твоя игровая библиотека</span>
          </div>
        </div>

        <div className="auth-copy">
          <span>{mode === 'login' ? 'С возвращением' : 'Новый профиль'}</span>
          <h1>{mode === 'login' ? 'Войти' : 'Создать аккаунт'}</h1>
          <p>
            {mode === 'login'
              ? 'Используй email или ник и свой PIN.'
              : 'Профиль и игровые коллекции будут публичными. Email останется приватным.'}
          </p>
        </div>

        {sessionExpired && <p className="auth-error" role="alert">Сессия закончилась. Войди снова, чтобы продолжить. Твои игры и оценки сохранены.</p>}

        <div className="auth-tabs">
          <button
            className={mode === 'login' ? 'auth-tab auth-tab--active' : 'auth-tab'}
            onClick={() => switchMode('login')}
            type="button"
          >
            Вход
          </button>
          {!registrationDisabled && <button
            className={mode === 'register' ? 'auth-tab auth-tab--active' : 'auth-tab'}
            onClick={() => switchMode('register')}
            type="button"
          >
            Регистрация
          </button>}
        </div>

        {registrationDisabled && <p className="auth-security">Тестовая версия. Регистрация отключена — войди под существующим аккаунтом.</p>}

        <form className="auth-form" onSubmit={submit}>
          {mode === 'register' ? (
            <>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  maxLength={320}
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </label>
              <label>
                <span>Никнейм</span>
                <input
                  type="text"
                  autoComplete="username"
                  value={nickname}
                  maxLength={16}
                  onChange={(event) => setNickname(event.target.value.toLowerCase().slice(0, 16))}
                  placeholder="nickname"
                  pattern="[a-z0-9_]{3,16}"
                  required
                />
                <small>3–16 символов: латиница, цифры и _</small>
              </label>
            </>
          ) : (
            <label>
              <span>Email или ник</span>
              <input
                type="text"
                autoComplete="username"
                value={identifier}
                maxLength={320}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="you@example.com или nickname"
                required
              />
            </label>
          )}

          <label>
            <span>PIN-код</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="••••••"
              minLength={mode === "register" ? 6 : 4}
              maxLength={8}
              required
            />
            <small>{mode === 'register' ? 'Для новых аккаунтов: 6–8 цифр.' : 'PIN: 4–8 цифр.'} На этом устройстве повторно вводить PIN обычно не понадобится.</small>
          </label>

          {mode === 'register' && (
            <label>
              <span>Повтори PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={pinConfirm}
                onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="••••••"
                minLength={6}
                maxLength={8}
                required
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button className="auth-submit" disabled={busy}>
            {busy
              ? 'Подождите…'
              : mode === 'login'
                ? 'Войти'
                : 'Создать аккаунт'}
          </button>
        </form>

        <p className="auth-security">
          PIN хранится только в виде защищённого хэша. После входа браузер получает защищённую сессию.
        </p>
      </section>
    </main>
  )
}
