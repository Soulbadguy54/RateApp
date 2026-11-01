import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AuthUser } from '../AuthScreen'
import PushSettings from '../PushSettings'
import SteamIntegrationCloud from '../components/SteamIntegrationCloud'
import Icon from '../components/Icon'
import { Cover } from '../components/GameCard'
import type { ProfileCloud } from '../profileTopGames'
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
export default function ProfileView({
  user, savedClouds, editClouds, cloudDraftIds,
  onStartCloudEditing, onChooseCloud, onOpenGame, onOpenWishlist, onSaved,
}: {
  user: AuthUser
  savedClouds: ProfileCloud[]
  editClouds: ProfileCloud[]
  cloudDraftIds: (number | null)[]
  onStartCloudEditing: () => void
  onChooseCloud: (slot: number) => void
  onOpenGame: (gameId: number) => void
  onOpenWishlist: () => void
  onSaved: (user: AuthUser) => void
}) {
  const [settingsTab, setSettingsTab] = useState<'notifications' | 'security'>('notifications')
  const notificationsTabRef = useRef<HTMLButtonElement>(null)
  const securityTabRef = useRef<HTMLButtonElement>(null)
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
  const cropRef = useRef<HTMLDivElement>(null)
  const [viewSize, setViewSize] = useState(VIEW_SIZE)
  const previousViewSizeRef = useRef(VIEW_SIZE)
  const pointsRef = useRef(new Map<number, Point>())
  const gestureRef = useRef<{ start: Point; moved: boolean; pinched: boolean } | null>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    return () => { if (photo) URL.revokeObjectURL(photo) }
  }, [photo])
  useEffect(() => { if (!editing) setTint(profileTintOption(user.profileTint).id) }, [user.profileTint, editing])

  // Cropping coordinates must follow the actual CSS diameter; otherwise a
  // responsive avatar previews one crop but saves a different 256px image.
  useEffect(() => {
    const node = cropRef.current
    if (!node) return
    const measure = () => setViewSize(node.getBoundingClientRect().width || VIEW_SIZE)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [editing, photo])

  const cover = natural.x && natural.y ? Math.max(viewSize / natural.x, viewSize / natural.y) : 1
  const clampOffset = (value: Point, nextZoom: number): Point => ({
    x: Math.max(-Math.max(0, (natural.x * cover * nextZoom - viewSize) / 2),
      Math.min(Math.max(0, (natural.x * cover * nextZoom - viewSize) / 2), value.x)),
    y: Math.max(-Math.max(0, (natural.y * cover * nextZoom - viewSize) / 2),
      Math.min(Math.max(0, (natural.y * cover * nextZoom - viewSize) / 2), value.y)),
  })
  // Preserve the same relative focal point across viewport rotation/resizing.
  // Clamp after scaling, so a previously dragged image never exposes blank crop.
  useEffect(() => {
    const scale = viewSize / previousViewSizeRef.current
    previousViewSizeRef.current = viewSize
    if (!natural.x || !natural.y || scale === 1) return
    setOffset(current => clampOffset({ x: current.x * scale, y: current.y * scale }, zoom))
  }, [viewSize, natural.x, natural.y, zoom])

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
    const ratio = 256 / viewSize
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
        body: JSON.stringify({ tint, cloudGameIds: cloudDraftIds,
          updateAvatar: Boolean(photo), ...(photo ? { avatarData: baked } : {}) }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null
        if (body?.detail === 'INVALID_CLOUD_GAME') return
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
  const chosenTint = profileTintOption(tint)
  const clouds = editing ? editClouds : savedClouds

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
            onClick={() => editing ? void save() : (onStartCloudEditing(), setEditing(true), setError(''))}
            whileTap={reducedMotion ? undefined : { scale: .94 }}>
            <Icon name={editing ? 'checkmark' : 'edit'} size={21} />
          </motion.button>
        </div>
        <div className="profile-glass-header__hero">
          {(editing || clouds.some(Boolean)) && (
            <ol className="profile-top-games" aria-label="Игры в облаках профиля">
              {clouds.map((cloud, index) => (
                (editing || cloud) && <li className="profile-top-games__item" data-slot={index} key={index}>
                  <button type="button"
                    className={'profile-top-game' + (editing ? ' profile-top-game--editing' : '')}
                    title={cloud?.game.title ?? 'Выбрать игру'}
                    aria-label={editing
                      ? 'Изменить игру в облаке ' + (index + 1)
                      : cloud!.game.title + (cloud!.score != null ? ', личная оценка ' + cloud!.score.toFixed(1) + ' из 10' : '')}
                    onClick={() => editing ? onChooseCloud(index) : cloud && onOpenGame(cloud.game.id)}
                    style={{ '--cloud-delay': (index * .13) + 's' } as CSSProperties}>
                    <span className="profile-top-game__cover">
                      {cloud ? <Cover game={cloud.game} thumbnail /> : <Icon name="gamepad" size={20} />}
                    </span>
                    {cloud?.score != null && (
                      <span className="profile-top-game__score" aria-hidden="true">{cloud.score.toFixed(1)}</span>
                    )}
                    {editing && <span className="profile-top-game__edit" aria-hidden="true"><Icon name="edit" size={15} /></span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="profile-steam-cloud-launch">
            <SteamIntegrationCloud />
          </div>
          <div className="profile-glass-header__avatar-row">
            {editing && photo ? (
              <div ref={cropRef} className="profile-avatar-crop" role="button" tabIndex={0}
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

      <section className="profile-settings" aria-label="Настройки профиля"
        style={{ '--profile-accent-color': chosenTint.color, '--profile-tint-rgb': chosenTint.rgb } as CSSProperties}>
        <div className="profile-settings__tabs" data-active={settingsTab} role="tablist" aria-label="Разделы настроек">
          {([
            { id: 'notifications' as const, label: 'Уведомления', icon: 'bell' as const, ref: notificationsTabRef },
            { id: 'security' as const, label: 'Безопасность', icon: 'shield' as const, ref: securityTabRef },
          ]).map(tab => (
            <button key={tab.id} ref={tab.ref} type="button" role="tab"
              id={'profile-settings-tab-' + tab.id}
              aria-controls={'profile-settings-panel-' + tab.id}
              aria-selected={settingsTab === tab.id}
              tabIndex={settingsTab === tab.id ? 0 : -1}
              className={'profile-settings__tab' + (settingsTab === tab.id ? ' profile-settings__tab--active' : '')}
              onClick={() => setSettingsTab(tab.id)}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
                    event.key !== 'Home' && event.key !== 'End') return
                event.preventDefault()
                const next = event.key === 'Home' ? 'notifications'
                  : event.key === 'End' ? 'security'
                  : settingsTab === 'notifications' ? 'security' : 'notifications'
                setSettingsTab(next)
                const targetTab = next === 'notifications' ? notificationsTabRef : securityTabRef
                targetTab.current?.focus()
              }}>
              {settingsTab === tab.id && (
                <motion.span className="profile-settings__tab-active" layoutId="profile-settings-active"
                  transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 330, damping: 31 }}
                  aria-hidden="true" />
              )}
              <span className="profile-settings__tab-label">
                <Icon name={tab.icon} size={18} />
                <span>{tab.label}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="profile-settings__folder">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={settingsTab}
              id={'profile-settings-panel-' + settingsTab}
              role="tabpanel"
              tabIndex={0}
              aria-labelledby={'profile-settings-tab-' + settingsTab}
              className="profile-settings__panel"
              initial={reducedMotion ? false : { opacity: 0, x: settingsTab === 'security' ? 12 : -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, x: settingsTab === 'security' ? -12 : 12 }}
              transition={{ duration: reducedMotion ? 0 : .22, ease: [0.22, 1, 0.36, 1] }}>
              {settingsTab === 'notifications' ? (
                <PushSettings user={user.nickname} onOpenWishlist={onOpenWishlist} accentColor={chosenTint.color} />
              ) : (
                <div className="profile-security">
                  <div className="profile-security__row">
                    <div className="profile-security__identity">
                      <Icon name="mail" size={18} />
                      <span className="profile-security__details">
                        <strong>Email</strong>
                        <span className="profile-security__value" title={user.email}>{user.email}</span>
                      </span>
                    </div>
                    <button type="button" className="profile-security__disabled-action" disabled
                      title="Изменение email пока недоступно">Изменить</button>
                  </div>
                  <div className="profile-security__row">
                    <div className="profile-security__identity">
                      <Icon name="lock" size={18} />
                      <span className="profile-security__details">
                        <strong>PIN-код</strong>
                        <span className="profile-security__value">••••••</span>
                      </span>
                    </div>
                    <button type="button" className="profile-security__disabled-action" disabled
                      title="Изменение PIN-кода пока недоступно">Изменить</button>
                  </div>
                  <div className="profile-security__row profile-security__row--backup">
                    <div className="profile-security__identity">
                      <Icon name="download" size={18} />
                      <span className="profile-security__details"><strong>Резервное копирование</strong></span>
                    </div>
                    <div className="profile-security__backup-actions">
                      <button type="button" disabled title="Импорт пока не реализован" aria-label="Импорт">
                        <Icon name="upload" size={18} />
                      </button>
                      <a href="/api/export" download="rateapp-export.json"
                        title="Экспорт текущего JSON-файла аккаунта" aria-label="Экспорт">
                        <Icon name="download" size={18} />
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
      <p className="app-build-version">Версия приложения: {__RATEAPP_BUILD__}</p>
    </>
  )
}
