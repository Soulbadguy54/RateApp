import { lazy, Suspense, useState } from 'react'
import type { GameCollection } from '../data'
import { WISHLIST_COLLECTION_ID, COLLECTION_THEMES, collectionThemeStyle } from '../collectionModel'
import Icon from './Icon'

const AsyncEmojiDisplay = lazy(() => import('../EmojiDisplay'))

function RenderEmoji({ unified, size }: { unified: string; size: number }) {
  return (
    <Suspense fallback={<span aria-hidden="true" style={{ display: 'inline-block', width: size, height: size }} />}>
      <AsyncEmojiDisplay unified={unified} size={size} />
    </Suspense>
  )
}

function emojiUnified(emoji: string): string {
  return Array.from(emoji).map((character) => character.codePointAt(0)!.toString(16)).join('-')
}

/** Same red ❤️ used by the protected wishlist icon across every screen. */
export function WishlistHeart({ size = 19 }: { size?: number }) {
  return <RenderEmoji unified="2764-fe0f" size={size} />
}

export function CollectionIcon({ collection, size = 19 }: { collection: GameCollection; size?: number }) {
  // Protected system collection always uses the same red emoji, including
  // for clients that still have the old outlined heart in their cached data.
  if (collection.id === WISHLIST_COLLECTION_ID) {
    return <WishlistHeart size={size} />
  }
  if (collection.emoji) {
    return <RenderEmoji unified={emojiUnified(collection.emoji)} size={size} />
  }
  if (collection.iconData) {
    return <img className="collection-icon__image" src={collection.iconData} width={size} height={size} alt="" aria-hidden="true" />
  }
  // Default symbols match the layered Collections icon in the bottom navigation.
  return <Icon name={collection.id === WISHLIST_COLLECTION_ID ? 'heart' : 'layers'} size={size} />
}

const CollectionEmojiPicker = lazy(() => import('../EmojiPickerPanel'))

const POPULAR_COLLECTION_EMOJIS = ['🎮', '🏆', '💎', '🔥', '⭐', '🎯', '🎁', '💜', '🕹️', '👑', '🚀', '🌌']

export function CollectionAppearanceEditor({
  colorScheme, emoji, onColorChange, onEmojiChange, fallbackIcon = 'layers',
}: {
  colorScheme: string
  emoji: string
  onColorChange: (value: string) => void
  onEmojiChange: (value: string) => void
  fallbackIcon?: 'layers' | 'heart'
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <div className="collection-appearance-editor">
      <div className="collection-create-field">
        <span>Цветовая схема</span>
        <div className="collection-color-grid" role="radiogroup" aria-label="Цветовая схема коллекции">
          {COLLECTION_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={colorScheme === theme.id}
              aria-label={theme.name}
              title={theme.name}
              className={colorScheme === theme.id ? 'collection-color-swatch collection-color-swatch--selected' : 'collection-color-swatch'}
              style={{ background: `linear-gradient(135deg, ${theme.accent}, ${theme.shade})` }}
              onClick={() => onColorChange(theme.id)}
            >
              {colorScheme === theme.id && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
      </div>
      <div className="collection-create-field">
        <span>Иконка коллекции</span>
        <div className="collection-emoji-preview-row">
          <div
            className="collection-icon-preview"
            style={collectionThemeStyle({ id: 'preview', title: '', description: '', mark: '', colorScheme })}
          >
            {emoji
              ? <RenderEmoji unified={emojiUnified(emoji)} size={36} />
              : <Icon name={fallbackIcon} size={36} />}
          </div>
          <button type="button" className="collection-emoji-open" aria-expanded={pickerOpen} onClick={() => setPickerOpen(!pickerOpen)}>
            <Icon name="sparkles" size={17} />
            {pickerOpen ? 'Закрыть выбор' : 'Выбрать эмодзи'}
          </button>
        </div>
        <div className="collection-emoji-quick" aria-label="Популярные эмодзи">
          {POPULAR_COLLECTION_EMOJIS.map((item) => (
            <button
              type="button"
              key={item}
              className={emoji === item ? 'collection-emoji-quick__item collection-emoji-quick__item--selected' : 'collection-emoji-quick__item'}
              onClick={() => onEmojiChange(item)}
              aria-label={`Выбрать ${item}`}
              aria-pressed={emoji === item}
            >
              <RenderEmoji unified={emojiUnified(item)} size={25} />
            </button>
          ))}
        </div>
        {pickerOpen && (
          <div className="collection-emoji-full-picker">
            <Suspense fallback={<p className="collection-picker-loading">Загружаем эмодзи…</p>}>
              <CollectionEmojiPicker onSelect={(value) => {
                onEmojiChange(value)
                setPickerOpen(false)
              }} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}

