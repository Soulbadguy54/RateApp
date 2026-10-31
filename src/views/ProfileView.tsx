import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AuthUser } from '../AuthScreen'
import PushSettings from '../PushSettings'
import Icon from '../components/Icon'
import { Cover } from '../components/GameCard'
import type { ProfileTopGame } from '../profileTopGames'
import { sessionFetch } from '../sessionFetch'
import { PROFILE_TINTS, profileTintOption, type ProfileTint } from '../profilePalette'
import './ProfileView.css'

const VIEW_SIZE = 142
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Authenticated image is cached only under a versioned, owner-scoped URL. */
export function profileAvatarUrl(user: AuthUser): string | null {
  return (user.avatarVersion ?? 0) > 0
    ? '/api/profile/avatar?u=' + user.id + '&v=' + user.avatarVersion
    : null
}

export function ProfileAvatar({ user, className = '' }: { user: AuthUser; className?: string }) {
  const src = profileAvatarUrl(user)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <span className={'profile-picture ' + className} aria-label="Аватар пользователя">
      {src && !failed
        ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
        : <span>{user.nickname.slice(0, 1).toUpperCase()}</span>}
    </span>
  )
}

type Point = { x: number; y: number }

/** A mobile-first gesture cropper: one finger pans, two fingers pinch.
    The same transformation is baked into a small 256px PNG on Save. */
export default function ProfileView({ user, topGames, onOpenGame, onOpenWishlist, onLogout, onSaved }: {
  user: AuthUser
  topGames: ProfileTopGame[]
  onOpenGame: (gameId: number) => void
  onOpenWishlist: () => void
  onLogout: () => Promise<void>
  onSaved: (user: AuthUser) => void
}) {
  const [loggingOut, setLoggingOut] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tint, setTint] = useState<ProfileTint>(() => profileTintOption(user.profileTint).id)
  const [photo, setPhoto] = useState<string | null>(null)
  const [natural, setNatural] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointsRef = useRef(new Map<number, Point>())
  const gestureRef = useRef<{ start: Point; moved: boolean; pinched: boolean } | null>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    return () => { if (photo) URL.revokeObjectURL(photo) }
  }, [photo])
  useEffect(() => { if (!editing) setTint(profileTintOption(user.profileTint).id) }, [user.profileTint, editing])

  const cover = natural.x && natural.y ? Math.max(VIEW_SIZE / natural.x, VIEW_SIZE / natural.y) : 1
  const clampOffset = (value: Point, nextZoom: number): Point => ({
    x: Math.max(-Math.max(0, (natural.x * cover * nextZoom - VIEW_SIZE) / 2),
      Math.min(Math.max(0, (natural.x * cover * nextZoom - VIEW_SIZE) / 2), value.x)),
    y: Math.max(-Math.max(0, (natural.y * cover * nextZoom - VIEW_SIZE) / 2),
      Math.min(Math.max(0, (natural.y * cover * nextZoom - VIEW_SIZE) / 2), value.y)),
  })
  const changeZoom = (value: number) => {
    const next = Math.max(1, Math.min(3.2, value))
    setZoom(next)
    setOffset(current => clampOffset(current, next))
  }
  const onChoosePhoto = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) {
      setError('Выберите изображение размером до 10 МБ.')
      return
    }
    setPhoto(URL.createObjectURL(file))
    setNatural({ x: 0, y: 0 })
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setError('')
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!photo) return
    const start = { x: event.clientX, y: event.clientY }
    if (pointsRef.current.size === 0) gestureRef.current = { start, moved: false, pinched: false }
    pointsRef.current.set(event.pointerId, start)
    if (pointsRef.current.size > 1 && gestureRef.current) gestureRef.current.pinched = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const old = pointsRef.current.get(event.pointerId)
    if (!old || !photo) return
    const p = { x: event.clientX, y: event.clientY }
    if (gestureRef.current &&
      Math.hypot(p.x - gestureRef.current.start.x, p.y - gestureRef.current.start.y) > 8) {
      gestureRef.current.moved = true
    }
    if (!natural.x) { pointsRef.current.set(event.pointerId, p); return }
    const others = [...pointsRef.current.entries()].filter(([key]) => key !== event.pointerId)
    if (others.length) {
      const other = others[0][1]
      const oldDistance = Math.hypot(old.x - other.x, old.y - other.y)
      const nextDistance = Math.hypot(p.x - other.x, p.y - other.y)
      const next = Math.max(1, Math.min(3.2, zoom * nextDistance / Math.max(1, oldDistance)))
      setZoom(next)
      setOffset(current => clampOffset(current, next))
    } else {
      setOffset(current => clampOffset({ x: current.x + p.x - old.x, y: current.y + p.y - old.y }, zoom))
    }
    pointsRef.current.set(event.pointerId, p)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointsRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (pointsRef.current.size > 0) return
    const isTap = event.type === 'pointerup' && !gestureRef.current?.moved && !gestureRef.current?.pinched
    gestureRef.current = null
    if (isTap) inputRef.current?.click()
  }
  const bakeAvatar = (): string | null => {
    const image = imageRef.current
    if (!photo || !image || !natural.x || !image.complete) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const ratio = 256 / VIEW_SIZE
    const width = natural.x * cover * zoom * ratio
    const height = natural.y * cover * zoom * ratio
    ctx.drawImage(image, 128 - width / 2 + offset.x * ratio,
      128 - height / 2 + offset.y * ratio, width, height)
    return canvas.toDataURL('image/png').split(',')[1]
  }
  const save = async () => {
    if (saving) return
    const baked = photo ? bakeAvatar() : null
    if (photo && !baked) { setError('Изображение ещё не готово.'); return }
    setSaving(true)
    setError('')
    try {
      const response = await sessionFetch('/api/profile/appearance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tint, updateAvatar: Boolean(photo), ...(photo ? { avatarData: baked } : {}) }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null
        throw new Error(body?.detail || 'Не удалось сохранить оформление.')
      }
      const saved = await response.json() as AuthUser
      onSaved(saved)
      setPhoto(null)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка сохранения оформления.')
    } finally { setSaving(false) }
  }
  const exit = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try { await onLogout() } finally { setLoggingOut(false) }
  }
  const chosenTint = profileTintOption(tint)

  return (
    <>
      <header className={'topbar profile-glass-header' + (editing ? ' profile-glass-header--editing' : '')}
        style={{ '--profile-tint-rgb': chosenTint.rgb, '--profile-tint-alpha': tint === 'default' ? '0' : '.23',
          '--profile-accent-color': chosenTint.color } as CSSProperties}>
        <div className="profile-glass-header__title-row">
          <h1>@{user.nickname}</h1>
          <motion.button type="button" className="round-add profile-glass-header__edit"
            aria-label={editing ? 'Сохранить оформление профиля' : 'Редактировать оформление профиля'}
            disabled={saving}
            onClick={() => editing ? void save() : (setEditing(true), setError(''))}
            whileTap={reducedMotion ? undefined : { scale: .94 }}>
            <Icon name={editing ? 'checkmark' : 'edit'} size={21} />
          </motion.button>
        </div>
        <div className={'profile-glass-header__hero' + (topGames.length ? ' profile-glass-header__hero--ranked' : '')}>
          {topGames.length > 0 && (
            <ol className={'profile-top-games profile-top-games--count-' + topGames.length}
              aria-label="Три игры с самыми высокими личными оценками">
              {topGames.map(({ game, score }, index) => (
                <li className="profile-top-games__item" key={game.id}>
                  <button type="button" className="profile-top-game"
                    title={game.title}
                    aria-label={game.title + ', личная оценка ' + score.toFixed(1) + ' из 10'}
                    onClick={() => onOpenGame(game.id)}
                    style={{ '--cloud-delay': (-index * 2.13) + 's' } as CSSProperties}>
                    <span className="profile-top-game__cover"><Cover game={game} thumbnail /></span>
                    <span className="profile-top-game__score" aria-hidden="true">
                      <Icon name="star" size={10} />{score.toFixed(1)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="profile-glass-header__avatar-row">
            {editing && photo ? (
              <div className="profile-avatar-crop" role="button" tabIndex={0}
                aria-label="Кадрировать аватар или нажать для выбора другой фотографии"
                onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    inputRef.current?.click()
                  }
                }}
                onWheel={event => { if (photo) changeZoom(zoom - event.deltaY / 440) }}>
                <img ref={imageRef} src={photo} alt="Предпросмотр аватара" draggable={false}
                  onLoad={event => setNatural({ x: event.currentTarget.naturalWidth, y: event.currentTarget.naturalHeight })}
                  style={{ width: natural.x * cover * zoom, height: natural.y * cover * zoom,
                    transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }} />
              </div>
            ) : <ProfileAvatar user={user} className="profile-glass-header__avatar" />}
            {editing && (
              <>
                {photo ? (
                  <span className="profile-glass-header__avatar-edit profile-glass-header__avatar-edit--cropping" aria-hidden="true">
                    <Icon name="edit" size={72} />
                  </span>
                ) : (
                  <button type="button" className="profile-glass-header__avatar-edit" aria-label="Выбрать аватар"
                    onClick={() => inputRef.current?.click()}>
                    <Icon name="edit" size={72} />
                  </button>
                )}
                <input ref={inputRef} type="file" accept="image/*" className="profile-file-input"
                  onChange={event => { onChoosePhoto(event.target.files?.[0]); event.currentTarget.value = '' }} />
              </>
            )}
          </div>
        </div>
        <AnimatePresence initial={false}>
          {editing && (
            <motion.div className="profile-appearance-panel" key="appearance"
              initial={reducedMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reducedMotion ? undefined : { height: 0, opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : .25, ease: 'easeOut' }}>
              <div className="profile-color-picker" role="radiogroup" aria-label="Оттенок стекла профиля">
                {PROFILE_TINTS.map(color => (
                  <button key={color.id} type="button" role="radio"
                    aria-label={color.label} aria-checked={tint === color.id}
                    className={'profile-color-picker__swatch' + (tint === color.id ? ' profile-color-picker__swatch--active' : '')}
                    style={{ '--swatch': color.id === 'default' ? 'transparent' : color.color } as CSSProperties}
                    onClick={() => setTint(color.id)}>
                    {tint === color.id ? <Icon name="checkmark" size={16} /> : color.id === 'default' ? <Icon name="x" size={14} /> : null}
                  </button>
                ))}
              </div>
              {error && <p className="profile-appearance-error" role="alert">{error}</p>}
            </motion.div>
          )}
        </AnimatePresence>
      </header>
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
