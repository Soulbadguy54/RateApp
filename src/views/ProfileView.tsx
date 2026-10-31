import type { AuthUser } from '../AuthScreen'
import PushSettings from '../PushSettings'
import Icon from '../components/Icon'
import { useState } from 'react'

/** Profile contains no library state; logout and navigation belong to App. */
export default function ProfileView({
  user, onOpenWishlist, onLogout,
}: {
  user: AuthUser
  onOpenWishlist: () => void
  onLogout: () => Promise<void>
}) {
  const [loggingOut, setLoggingOut] = useState(false)
  const exit = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try { await onLogout() } finally { setLoggingOut(false) }
  }
  return (
    <>
      <header className="topbar profile-topbar"><h1>Профиль</h1></header>
      <section className="profile-hero profile-hero--compact">
        <div className="profile-avatar">{user.nickname.slice(0, 1).toUpperCase()}</div>
        <h2>@{user.nickname}</h2>
      </section>
      <PushSettings user={user.nickname} onOpenWishlist={onOpenWishlist} />
      <section className="info-card account-card">
        <h2>Резервное копирование</h2>
        <p className="privacy-note">Сохрани свои прохождения, оценки, отзывы и коллекции в одном JSON-файле. Только твои данные.</p>
        <a className="account-export-link" href="/api/export" download="rateapp-export.json">
          <Icon name="download" size={17} /> Скачать данные
        </a>
      </section>
      <section className="info-card account-card">
        <span className="eyebrow">АККАУНТ</span>
        <h2>Вход и восстановление</h2>
        <div className="account-row">
          <span><Icon name="mail" size={18} /><span><small>Email</small>{user.email}</span></span>
          <button type="button" disabled title="Изменение email пока недоступно">Изменить</button>
        </div>
        <div className="account-row">
          <span><Icon name="lock" size={18} /><span><small>PIN-код</small>••••••</span></span>
          <button type="button" disabled title="Изменение PIN пока недоступно">Изменить</button>
        </div>
        <p className="privacy-note">Email и настройки входа видны только вам. Данные аккаунта защищены настройками входа.</p>
        <button className="logout-button" disabled={loggingOut} onClick={() => { void exit() }}>
          {loggingOut ? 'Выходим…' : 'Выйти из аккаунта'}
        </button>
      </section>
      <p className="app-build-version">Версия приложения: {__RATEAPP_BUILD__}</p>
    </>
  )
}
