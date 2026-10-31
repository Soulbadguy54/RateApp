import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import GameCard, { Cover } from './components/GameCard'
import CarouselArrows from './components/CarouselArrows'
import { ratedStatuses, statusIcons, statusMeta } from './statusPresentation'
import Icon, { type IconName } from './components/Icon'
import BottomNavGameSlot from './components/BottomNavGameSlot'
import RatingWheel, { closestHalfPoint } from './components/RatingWheel'
import { CollectionIcon, CollectionAppearanceEditor } from './components/CollectionAppearance'
import {
  WISHLIST_COLLECTION_ID, collectionThemeStyle,
  sortCollections, sortCollectionsForGame, isPlaythrough, withCollectionMembership,
} from './collectionModel'
import {
  AnimatePresence,
  LayoutGroup,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from 'motion/react'
import AuthScreen, { type AuthUser } from './AuthScreen'
import { sessionFetch, subscribeSessionExpiry, getSessionExpiredSnapshot, resetSessionExpired } from './sessionFetch'
import './views/DiscoverView.css'
import LoadingScreen from './LoadingScreen'
import { PushOnboarding, clearPushStateCache, disconnectPushForLogout, preloadPushState } from './PushSettings'
import {
  games,
  type Game,
  type GameCollection,
  type LibraryEntry,
  type LibraryStatus,
} from './data'

const ProfileView = lazy(() => import('./views/ProfileView'))
const DiscoverView = lazy(() => import('./views/DiscoverView'))
const SavedLinksView = lazy(() => import('./views/SavedLinksView'))

type Tab = 'library' | 'add' | 'collections' | 'profile' | 'discovery' | 'links'

type AppView = {
  tab: Tab
  gameId: number | null
  collectionId: string | null
  formGameId: number | null
}

type AppHistoryEntry = {
  rateAppView: true
  view: AppView
  scrollY: number
  fromApp: boolean
  /** Entry depth within this SPA session, used to bypass app routes on exit. */
  appDepth?: number
  /** Browser-history safety entry: the first Back stays in the app. */
  exitGate?: boolean
  collectionPickerOpen?: boolean
  controls?: {
    progress: number
    anchor: number
    forcedCollapsed: boolean
    topLatch: boolean
    entryAnchorActive: boolean
  }
}

const validTabs: Tab[] = ['library', 'add', 'collections', 'profile', 'discovery', 'links']
const EXIT_CONFIRM_WINDOW_MS = 1800

function isRootScreen(view: AppView): boolean {
  return view.gameId == null && view.formGameId == null && !view.collectionId
}

function readAppHistoryEntry(value: unknown): AppHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<AppHistoryEntry>
  if (entry.rateAppView !== true || !entry.view || !validTabs.includes(entry.view.tab)) return null
  return entry as AppHistoryEntry
}

function readAppViewFromUrl(): AppView {
  const params = new URLSearchParams(window.location.search)
  const tabName = params.get('tab') as Tab | null
  const tab: Tab = tabName && validTabs.includes(tabName) ? tabName : 'library'
  const gameId = Number(params.get('game'))
  const formGameId = Number(params.get('edit'))
  return {
    tab,
    gameId: Number.isSafeInteger(gameId) && gameId > 0 ? gameId : null,
    collectionId: tab === 'collections' ? params.get('collection') : null,
    formGameId: tab === 'add' && Number.isSafeInteger(formGameId) && formGameId > 0 ? formGameId : null,
  }
}

function urlForAppView(view: AppView): string {
  const url = new URL(window.location.href)
  for (const param of ['tab', 'game', 'collection', 'edit']) url.searchParams.delete(param)
  if (view.tab !== 'library') url.searchParams.set('tab', view.tab)
  if (view.gameId != null) url.searchParams.set('game', String(view.gameId))
  if (view.tab === 'collections' && view.collectionId) url.searchParams.set('collection', view.collectionId)
  if (view.tab === 'add' && view.formGameId != null) url.searchParams.set('edit', String(view.formGameId))
  return url.pathname + url.search + url.hash
}

function keyForAppView(view: AppView): string {
  if (view.gameId != null) return `detail-${view.gameId}`
  if (view.tab === 'collections' && view.collectionId) return `collection-${view.collectionId}`
  if (view.tab === 'add' && view.formGameId != null) return `add-game-${view.formGameId}`
  return view.tab
}

const COLLECTION_TITLE_LIMIT = 32

function collectionValidationMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object' || !('detail' in data)) return fallback
  const detail = (data as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const first = detail.find((item) => item && typeof item === 'object' && 'loc' in item)
    const loc = first && typeof first === 'object' && 'loc' in first
      ? (first as { loc?: unknown }).loc : null
    if (Array.isArray(loc) && loc.includes('title')) return 'Название коллекции: максимум 32 символа.'
    if (Array.isArray(loc) && loc.includes('description')) return 'Описание коллекции: максимум 500 символов.'
    const message = detail.find((item) => item && typeof item === 'object' && 'msg' in item)
    if (message && typeof message === 'object' && 'msg' in message) return String(message.msg)
  }
  return fallback
}

type SortMode = 'activity' | 'score-desc' | 'score-asc' | 'title'
type CollectionSortMode = 'added-desc' | 'added-asc' | 'release-desc' | 'release-asc' | 'title-asc' | 'title-desc' | 'igdb-desc' | 'igdb-asc'

type ApiLibraryEntry = Omit<
  LibraryEntry,
  'platform' | 'completedAt' | 'startedAt' | 'score' |
  'atmosphereScore' | 'storyScore' | 'technologyScore' | 'gameplayScore' | 'review'
> & {
  platform: string | null
  completedAt: string | null
  startedAt: string | null
  score: number | null
  atmosphereScore: number | null
  storyScore: number | null
  technologyScore: number | null
  gameplayScore: number | null
  review: string | null
  game?: Game
}

type BootstrapPayload = {
  user: AuthUser
  library: ApiLibraryEntry[]
  collections: GameCollection[]
}

type GameSearchPage = {
  items: Game[]
  hasMore: boolean
  nextOffset: number | null
}

type SearchSource = 'local' | 'igdb'

type CollectionUpdate = {
  desired: Map<string, boolean>
  persisted: Map<string, boolean>
  syncing: boolean
}

type GameStoreLink = {
  provider: string
  label: string
  url: string
}

type GameDetailExtras = {
  storyHours: number | null
  completionHours: number | null
  storeLinks: GameStoreLink[]
  trailerUrl: string | null
  game?: Game
}

const STORE_ICONS: Record<string, string> = {
  steam: '/brand/steam.svg',
  epic: '/brand/epicgames.svg',
  gog: '/brand/gogdotcom.svg',
  itch: '/brand/itchdotio.svg',
  playstation: '/brand/playstation.svg',
  xbox: '/brand/xbox.svg',
  nintendo: '/brand/nintendoswitch.svg',
  youtube: '/brand/youtube.svg',
}

function BrandIcon({ provider }: { provider: string }) {
  const iconUrl = STORE_ICONS[provider]
  return iconUrl
    ? <img className="detail-external-link__icon" src={iconUrl} alt="" aria-hidden="true" width={20} height={20} />
    : <Icon name="globe" size={20} />
}

function formatPlaytime(details?: GameDetailExtras, loading = false): string {
  if (loading && !details) return 'Загружаем…'
  const story = details?.storyHours
  const complete = details?.completionHours
  if (story != null && complete != null) {
    return story === complete ? `${story} ч` : `${story}–${complete} ч`
  }
  if (story != null) return `от ${story} ч`
  if (complete != null) return `до ${complete} ч`
  return '—'
}

const normalizeEntry = (entry: ApiLibraryEntry | LibraryEntry): LibraryEntry => ({
  ...entry,
  platform: entry.platform ?? undefined,
  completedAt: entry.completedAt ?? undefined,
  startedAt: entry.startedAt ?? undefined,
  score: entry.score ?? undefined,
  atmosphereScore: entry.atmosphereScore ?? undefined,
  storyScore: entry.storyScore ?? undefined,
  technologyScore: entry.technologyScore ?? undefined,
  gameplayScore: entry.gameplayScore ?? undefined,
  review: entry.review ?? undefined,
})

const preferredPlatform = (platforms: string[]) => {
  const priorities = [
    /^(pc|pc \(microsoft windows\))$/i,
    /windows/i,
    /(playstation 5|\bps5\b)/i,
    /xbox series/i,
    /(playstation 4|\bps4\b)/i,
    /xbox one/i,
    /(nintendo )?switch/i,
  ]

  for (const pattern of priorities) {
    const match = platforms.find((platform) => pattern.test(platform))
    if (match) return match
  }

  return platforms[0] ?? ''
}

function formatDate(value?: string) {
  if (!value) return ''
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

function App() {
  const shouldReduceMotion = useReducedMotion()
  const firstViewRef = useRef<AppView | null>(null)
  if (!firstViewRef.current) {
    firstViewRef.current = readAppHistoryEntry(window.history.state)?.view ?? readAppViewFromUrl()
  }
  const [activeTab, setActiveTab] = useState<Tab>(firstViewRef.current.tab)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  // useSyncExternalStore also reads a 401 that arrived before subscription:
  // a bare window Event can be lost during child-first passive effects on WebKit.
  const sessionExpired = useSyncExternalStore(subscribeSessionExpiry, getSessionExpiredSnapshot)
  useEffect(() => {
    if (!sessionExpired || !authUser) return
    // Server-side data remain untouched; clear only this browser session state.
    clearPushStateCache(authUser.nickname)
    setAuthUser(null)
    setEntries([])
    setCollections([])
  }, [sessionExpired, authUser])

  const [authReady, setAuthReady] = useState(false)
  const [bootstrapError, setBootstrapError] = useState(false)
  const [bootstrapRetry, setBootstrapRetry] = useState(0)
  const [loadingProgress, setLoadingProgress] = useState(12)
  const [loadingPhase, setLoadingPhase] = useState<'loading' | 'preparing' | 'complete'>('loading')
  const [screenRevision, setScreenRevision] = useState(0)
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [collections, setCollections] = useState<GameCollection[]>([])
  const [catalogGames, setCatalogGames] = useState<Game[]>(games)
  const [addResults, setAddResults] = useState<Game[]>([])
  const [addSearchLoading, setAddSearchLoading] = useState(false)
  const [addSearchError, setAddSearchError] = useState('')
  const [addSearchSource, setAddSearchSource] = useState<SearchSource>('local')
  const [localSearchMissQuery, setLocalSearchMissQuery] = useState<string | null>(null)
  const [addSearchHasMore, setAddSearchHasMore] = useState(false)
  const [addSearchNextOffset, setAddSearchNextOffset] = useState(0)
  const addSearchGenerationRef = useRef(0)
  const addSearchAbortRef = useRef<AbortController | null>(null)
  const addSearchBusyRef = useRef(false)
  const addSearchSentinelRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [statusFilters, setStatusFilters] = useState<LibraryStatus[]>([])
  const [genreFilter, setGenreFilter] = useState('all')
  const [genreCatalog, setGenreCatalog] = useState<string[]>([])
  const [collectionSortMode, setCollectionSortMode] = useState<CollectionSortMode>('added-desc')
  const [platformFilter, setPlatformFilter] = useState('all')
  const [sortMode, setSortMode] = useState<SortMode>('activity')
  const [filtersOpen, setFiltersOpen] = useState(false)

  const resetLibraryFilters = () => {
    setStatusFilters([])
    setGenreFilter('all')
    setPlatformFilter('all')
    setFiltersOpen(false)
  }

  useEffect(() => {
    // Mobile browsers often keep the PWA mounted in the background. A fresh
    // launch already gets empty useState defaults, but reopening that same
    // document must not revive its old My Games filters.
    let wasHidden = document.visibilityState === 'hidden'
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true
      } else if (wasHidden && document.visibilityState === 'visible') {
        wasHidden = false
        resetLibraryFilters()
      }
    }
    const onPageShow = (event: PageTransitionEvent) => {
      // Safari may restore the previous document from its back-forward cache
      // instead of doing a fresh React mount.
      if (event.persisted) {
        wasHidden = false
        resetLibraryFilters()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])
  const [librarySearchOpen, setLibrarySearchOpen] = useState(false)
  const librarySearchInputRef = useRef<HTMLInputElement>(null)
  const focusLibrarySearchOnOpen = useRef(false)
  const [libraryControlsCollapsed, setLibraryControlsCollapsed] = useState(false)
  const [libraryControlsMeasured, setLibraryControlsMeasured] = useState(false)
  const libraryControlsObserverRef = useRef<ResizeObserver | null>(null)
  const libraryControlsMeasureFrameRef = useRef<number | null>(null)
  const libraryToggleAnimationRef = useRef<{ stop: () => void } | null>(null)
  const libraryToggleGenerationRef = useRef(0)
  const libraryEntryAnchorActiveRef = useRef(false)
  const libraryHasOpenedRef = useRef(false)
  const libraryCollapseProgress = useMotionValue(0)
  const libraryMeasuredControlsHeight = useMotionValue(0)
  const libraryControlClipHeight = useTransform(
    () => libraryMeasuredControlsHeight.get() * (1 - libraryCollapseProgress.get()),
  )
  const libraryControlClipOpacity = useTransform(
    () => Math.max(0, 1 - libraryCollapseProgress.get() * 1.18),
  )
  const libraryScrollAnchorRef = useRef(0)
  const libraryForceCollapsedRef = useRef(false)
  const libraryScrollSyncPausedRef = useRef(false)
  const libraryLastScrollYRef = useRef(0)
  const libraryTopLatchRef = useRef(false)
  const libraryForcedRevealStartRef = useRef<number | null>(null)
  const [selectedGameId, setSelectedGameId] = useState<number | null>(firstViewRef.current.gameId)
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(
    () => Boolean(readAppHistoryEntry(window.history.state)?.collectionPickerOpen && firstViewRef.current?.gameId),
  )
  const [deleteCollectionPrompt, setDeleteCollectionPrompt] = useState<GameCollection | null>(null)
  const [deleteGamePrompt, setDeleteGamePrompt] = useState<Game | null>(null)
  const [bulkDeleteCollectionPrompt, setBulkDeleteCollectionPrompt] = useState<string[] | null>(null)
  const [bulkRemoveGamesPrompt, setBulkRemoveGamesPrompt] = useState<{ collectionId: string; gameIds: number[] } | null>(null)
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([])
  const [selectedCollectionGameIds, setSelectedCollectionGameIds] = useState<number[]>([])
  const collectionGameHoldRef = useRef<{ pointerId: number; gameId: number; x: number; y: number; timer: number } | null>(null)
  const suppressCollectionGameClickRef = useRef<{ gameId: number; time: number } | null>(null)
  const cancelCollectionGameHold = () => {
    if (collectionGameHoldRef.current) window.clearTimeout(collectionGameHoldRef.current.timer)
    collectionGameHoldRef.current = null
  }
  const collectionHoldRef = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null)
  const suppressCollectionClickRef = useRef<{ id: string; time: number } | null>(null)
  const cancelCollectionHold = () => {
    if (collectionHoldRef.current) window.clearTimeout(collectionHoldRef.current.timer)
    collectionHoldRef.current = null
  }
  const [deleteCollectionBusy, setDeleteCollectionBusy] = useState(false)
  const [deleteCollectionError, setDeleteCollectionError] = useState('')
  const deleteCollectionCancelRef = useRef<HTMLButtonElement>(null)
  const viewportPageRef = useRef<HTMLElement | null>(null)
  const collectionUpdatesRef = useRef(new Map<number, CollectionUpdate>())
  const [gameDetailsById, setGameDetailsById] = useState<Record<number, GameDetailExtras>>({})
  const [similarGamesById, setSimilarGamesById] = useState<Record<number, Game[]>>({})
  const [similarCoversReadyById, setSimilarCoversReadyById] = useState<Record<number, boolean>>({})
  const similarLoadingRef = useRef(new Set<number>())
  const [wishlistToastGameId, setWishlistToastGameId] = useState<number | null>(null)
  const wishlistToastTimerRef = useRef<number | null>(null)
  const wishlistHoldRef = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null)
  const suppressWishlistClickRef = useRef<number>(0)
  const cancelWishlistHold = () => {
    if (wishlistHoldRef.current) window.clearTimeout(wishlistHoldRef.current.timer)
    wishlistHoldRef.current = null
  }
  useEffect(() => () => {
    if (wishlistHoldRef.current) window.clearTimeout(wishlistHoldRef.current.timer)
    if (wishlistToastTimerRef.current) window.clearTimeout(wishlistToastTimerRef.current)
  }, [])
  const [loadingGameDetailsId, setLoadingGameDetailsId] = useState<number | null>(null)
  const [failedGameDetailsId, setFailedGameDetailsId] = useState<number | null>(null)
  const dismissDeletePrompt = () => {
    if (deleteCollectionBusy) return
    setDeleteCollectionPrompt(null)
    setDeleteGamePrompt(null)
    setBulkDeleteCollectionPrompt(null)
    setBulkRemoveGamesPrompt(null)
    setDeleteCollectionError('')
  }
  useEffect(() => {
    if (!deleteCollectionPrompt && !deleteGamePrompt && !bulkDeleteCollectionPrompt && !bulkRemoveGamesPrompt) return
    deleteCollectionCancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleteCollectionBusy) {
        event.preventDefault()
        setDeleteCollectionPrompt(null)
        setDeleteGamePrompt(null)
        setBulkDeleteCollectionPrompt(null)
        setBulkRemoveGamesPrompt(null)
        setDeleteCollectionError('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteCollectionPrompt, deleteGamePrompt, bulkDeleteCollectionPrompt, bulkRemoveGamesPrompt, deleteCollectionBusy])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(firstViewRef.current.collectionId)
  useEffect(() => {
    setSelectedCollectionIds([])
    setSelectedCollectionGameIds([])
    setBulkRemoveGamesPrompt(null)
    cancelCollectionHold()
    cancelCollectionGameHold()
    suppressCollectionGameClickRef.current = null
    setCollectionSortMode('added-desc')
  }, [activeTab, selectedCollectionId])
  useEffect(() => () => {
    if (collectionHoldRef.current) window.clearTimeout(collectionHoldRef.current.timer)
    if (collectionGameHoldRef.current) window.clearTimeout(collectionGameHoldRef.current.timer)
  }, [])
  useEffect(() => {
    const onKeyboardEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing) return
      const element = event.target
      if (element instanceof HTMLInputElement &&
          ['text', 'search', 'email', 'password', 'tel', 'number', 'url'].includes(element.type)) {
        element.blur()
      }
    }
    document.addEventListener('keydown', onKeyboardEnter)
    return () => document.removeEventListener('keydown', onKeyboardEnter)
  }, [])
  const transientBackRef = useRef(false)
  transientBackRef.current = Boolean(
    selectedCollectionIds.length || selectedCollectionGameIds.length ||
    bulkRemoveGamesPrompt || bulkDeleteCollectionPrompt || deleteCollectionPrompt ||
    deleteGamePrompt || collectionPickerOpen || filtersOpen || librarySearchOpen
  )
  const currentViewRef = useRef<AppView>(firstViewRef.current)
  const [exitPromptVisible, setExitPromptVisible] = useState(false)
  const exitArmedUntilRef = useRef(0)
  const exitPromptTimerRef = useRef<number | null>(null)
  const exitGateDepthRef = useRef<number | null>(null)
  const clearExitPrompt = () => {
    exitArmedUntilRef.current = 0
    setExitPromptVisible(false)
    if (exitPromptTimerRef.current !== null) window.clearTimeout(exitPromptTimerRef.current)
    exitPromptTimerRef.current = null
  }
  useEffect(() => () => {
    if (exitPromptTimerRef.current !== null) window.clearTimeout(exitPromptTimerRef.current)
  }, [])
  const pendingScreenRestoreRef = useRef<AppHistoryEntry | null>(null)
  const libraryLastSnapshotRef = useRef<AppHistoryEntry | null>(null)
  const [collectionTitle, setCollectionTitle] = useState('')
  const [collectionDescription, setCollectionDescription] = useState('')
  const [collectionColorScheme, setCollectionColorScheme] = useState('violet')
  const [collectionEmoji, setCollectionEmoji] = useState('')
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null)
  const [editCollectionTitle, setEditCollectionTitle] = useState('')
  const [editCollectionDescription, setEditCollectionDescription] = useState('')
  const [editCollectionColor, setEditCollectionColor] = useState('violet')
  const [editCollectionEmoji, setEditCollectionEmoji] = useState('')
  const [removedCollectionGameIds, setRemovedCollectionGameIds] = useState<number[]>([])
  const [collectionEditBusy, setCollectionEditBusy] = useState(false)
  const [collectionEditError, setCollectionEditError] = useState('')

  // Navigating away always discards any uncommitted collection draft.
  useEffect(() => {
    setEditingCollectionId(null)
    setRemovedCollectionGameIds([])
    setCollectionEditError('')
  }, [selectedCollectionId])
  const [collectionSaving, setCollectionSaving] = useState(false)
  const [collectionError, setCollectionError] = useState('')

  const [addQuery, setAddQuery] = useState('')
  const addSearchInputRef = useRef<HTMLInputElement>(null)
  const [addGameId, setAddGameId] = useState<number | null>(firstViewRef.current.formGameId)
  const [addStatus, setAddStatus] = useState<LibraryStatus>('completed')
  const [addPlatform, setAddPlatform] = useState('')
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [addAtmosphereScore, setAddAtmosphereScore] = useState(8)
  const [addStoryScore, setAddStoryScore] = useState(8)
  const [addTechnologyScore, setAddTechnologyScore] = useState(8)
  const [addGameplayScore, setAddGameplayScore] = useState(8)
  const [addReview, setAddReview] = useState('')
  const [addReviewOpen, setAddReviewOpen] = useState(false)
  const [addCollectionIds, setAddCollectionIds] = useState<string[]>([])

  useMotionValueEvent(libraryCollapseProgress, 'change', (latest) => {
    const collapsed = latest >= 0.84
    setLibraryControlsCollapsed((current) => current === collapsed ? current : collapsed)
  })

  const calculatedAddScore = Number((
    (addAtmosphereScore + addStoryScore + addTechnologyScore + addGameplayScore) / 4
  ).toFixed(1))

  const applyBootstrap = (payload: BootstrapPayload) => {
    void preloadPushState(payload.user.nickname).catch(() => { /* Push is optional. */ })
    setAuthUser(payload.user)
    setEntries(payload.library.map(normalizeEntry))
    setCollections(sortCollections(payload.collections))

    const libraryMetadata = payload.library.flatMap((entry) => entry.game ? [entry.game] : [])
    setCatalogGames((current) => {
      const merged = new Map(current.map((game) => [game.id, game]))
      libraryMetadata.forEach((game) => merged.set(game.id, game))
      return Array.from(merged.values())
    })
  }

  const hydrateAfterLogin = async (fallbackUser: AuthUser) => {
    resetLibraryFilters()
    void preloadPushState(fallbackUser.nickname).catch(() => { /* Push is optional. */ })
    setAuthUser(fallbackUser)
    setAuthReady(true)

    try {
      const response = await sessionFetch('/api/bootstrap')
      if (response.status === 401) {
        setAuthUser(null)
        return
      }
      if (!response.ok) throw new Error('Bootstrap unavailable')
      applyBootstrap(await response.json() as BootstrapPayload)
      setBootstrapError(false)
    } catch {
      // Authentication succeeded but loading user data failed; don't show empty UI.
      setBootstrapError(true)
    }
  }

  const captureCurrentView = () => {
    const view = currentViewRef.current
    const existing = readAppHistoryEntry(window.history.state)
    const snapshot: AppHistoryEntry = {
      rateAppView: true,
      view,
      fromApp: existing?.fromApp ?? false,
      appDepth: existing?.appDepth ?? 0,
      exitGate: existing?.exitGate,
      collectionPickerOpen: view.gameId != null ? collectionPickerOpen : false,
      scrollY: Math.max(0,
        viewportPageRef.current?.classList.contains('page--viewport')
          ? viewportPageRef.current.scrollTop
          : window.scrollY,
      ),
    }

    if (view.tab === 'library' && view.gameId == null) {
      snapshot.controls = {
        progress: libraryCollapseProgress.get(),
        anchor: libraryScrollAnchorRef.current,
        forcedCollapsed: libraryForceCollapsedRef.current,
        topLatch: libraryTopLatchRef.current,
        entryAnchorActive: libraryEntryAnchorActiveRef.current,
      }
      libraryLastSnapshotRef.current = snapshot
    }

    window.history.replaceState(snapshot, '', urlForAppView(view))
  }

  const showAppView = (view: AppView, restoredEntry: AppHistoryEntry) => {
    if (keyForAppView(currentViewRef.current) !== keyForAppView(view)) clearExitPrompt()
    currentViewRef.current = view
    exitGateDepthRef.current = restoredEntry.exitGate && isRootScreen(view)
      ? (restoredEntry.appDepth ?? 0) : null
    pendingScreenRestoreRef.current = restoredEntry
    if (view.tab === 'library' && view.gameId == null) {
      // Do not let scroll callbacks overwrite the saved collapsed state
      // before the library's animated screen has actually remounted.
      libraryScrollSyncPausedRef.current = true
      libraryCollapseProgress.set(restoredEntry.controls?.progress ?? 0)
    }
    setActiveTab(view.tab)
    setSelectedGameId(view.gameId)
    setCollectionPickerOpen(view.gameId != null && Boolean(restoredEntry.collectionPickerOpen))
    setSelectedCollectionId(view.collectionId)
    setAddGameId(view.formGameId)
  }

  const pushRootExitGate = (view: AppView, current: AppHistoryEntry) => {
    // A standalone PWA loaded directly at its root has no prior app state to
    // pop to. Add ONE same-URL entry so Android Back triggers popstate first.
    if (!isRootScreen(view)) return
    const gate: AppHistoryEntry = {
      ...current, exitGate: true, appDepth: (current.appDepth ?? 0) + 1,
    }
    window.history.pushState(gate, '', urlForAppView(view))
    exitGateDepthRef.current = gate.appDepth!
  }

  const navigateTo = (view: AppView, options?: { replace?: boolean; restoreLibrary?: boolean }) => {
    if (keyForAppView(currentViewRef.current) === keyForAppView(view)) return

    captureCurrentView()
    const savedLibrary = options?.restoreLibrary ? libraryLastSnapshotRef.current : null
    const entry: AppHistoryEntry = {
      rateAppView: true,
      view,
      scrollY: savedLibrary?.scrollY ?? 0,
      fromApp: options?.replace
        ? (readAppHistoryEntry(window.history.state)?.fromApp ?? false)
        : true,
      appDepth: (readAppHistoryEntry(window.history.state)?.appDepth ?? 0) + (options?.replace ? 0 : 1),
      collectionPickerOpen: false,
      controls: savedLibrary?.controls,
    }
    if (options?.replace) window.history.replaceState(entry, '', urlForAppView(view))
    else window.history.pushState(entry, '', urlForAppView(view))
    showAppView(view, entry)
    // Every root screen is an exit boundary, not just Discovery. On a new
    // bottom-nav selection this gate prevents Back from reopening another tab.
    if (isRootScreen(view)) pushRootExitGate(view, entry)
  }

  const goBackOr = (fallback: AppView) => {
    if (readAppHistoryEntry(window.history.state)?.fromApp) {
      captureCurrentView()
      window.history.back()
    } else {
      navigateTo(fallback, { replace: true, restoreLibrary: fallback.tab === 'library' && fallback.gameId == null })
    }
  }

  // Browser history is the source of truth for Android's system Back action
  // and Safari's native edge-swipe navigation, including browser Forward.
  useEffect(() => {
    const previousRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    const previous = readAppHistoryEntry(window.history.state)
    const initial = currentViewRef.current
    const base: AppHistoryEntry = previous ?? {
      rateAppView: true, view: initial, scrollY: 0, fromApp: false, appDepth: 0,
    }
    window.history.replaceState(base, '', urlForAppView(initial))
    if (isRootScreen(initial)) {
      // Rehydrating a PWA/tab must reuse its guard, not stack a new copy.
      // Entering Discovery from another tab is handled in navigateTo.
      if (base.exitGate) exitGateDepthRef.current = base.appDepth ?? 0
      else pushRootExitGate(initial, base)
    }

    const onPopState = (event: PopStateEvent) => {
      const entry: AppHistoryEntry = readAppHistoryEntry(event.state) ?? {
        rateAppView: true, view: readAppViewFromUrl(),
        scrollY: 0, fromApp: false, appDepth: 0,
      }
      const active = currentViewRef.current
      // Native Back (including Safari's edge gesture) first closes selection,
      // dialogs, and overlays. Restore the consumed history step silently;
      // only the next Back may reach the root exit confirmation.
      const dismiss = new Event('rateapp:cancel-transient', { cancelable: true })
      window.dispatchEvent(dismiss)
      if (transientBackRef.current || dismiss.defaultPrevented) {
        if (transientBackRef.current) {
          setSelectedCollectionIds([])
          setSelectedCollectionGameIds([])
          setBulkRemoveGamesPrompt(null)
          setBulkDeleteCollectionPrompt(null)
          setDeleteCollectionPrompt(null)
          setDeleteGamePrompt(null)
          setCollectionPickerOpen(false)
          setFiltersOpen(false)
          setLibrarySearchOpen(false)
          cancelCollectionHold()
          cancelCollectionGameHold()
        }
        clearExitPrompt()
        const root = isRootScreen(active)
        const restored: AppHistoryEntry = {
          rateAppView: true, view: active, scrollY: window.scrollY,
          fromApp: true, appDepth: (entry.appDepth ?? 0) + 1,
          exitGate: root,
        }
        window.history.pushState(restored, '', urlForAppView(active))
        exitGateDepthRef.current = root ? restored.appDepth! : null
        return
      }
      // Only root-level app exits are guarded. Nested screens (including the
      // playthrough form) still use native history and ordinary Back.
      if (exitGateDepthRef.current !== null && isRootScreen(active) &&
          (entry.appDepth ?? 0) < exitGateDepthRef.current) {
        if (Date.now() <= exitArmedUntilRef.current) {
          clearExitPrompt()
          exitGateDepthRef.current = null
          // Only the host browser/Android can close a standalone PWA reliably.
          // Request closure if supported and skip all internal SPA entries;
          // an ordinary browser tab falls back to its prior external page.
          const standalone = window.matchMedia('(display-mode: standalone)').matches ||
            ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
          if (standalone) window.close()
          window.history.go(-((entry.appDepth ?? 0) + 1))
          return
        }
        exitArmedUntilRef.current = Date.now() + EXIT_CONFIRM_WINDOW_MS
        setExitPromptVisible(true)
        if (exitPromptTimerRef.current !== null) window.clearTimeout(exitPromptTimerRef.current)
        exitPromptTimerRef.current = window.setTimeout(() => {
          clearExitPrompt()
        }, EXIT_CONFIRM_WINDOW_MS)
        // Restore an equivalent same-URL guard without remounting the root.
        // No flash of the old tab while Android navigates back.
        const gate: AppHistoryEntry = {
          rateAppView: true, view: active, scrollY: 0, fromApp: true,
          appDepth: (entry.appDepth ?? 0) + 1, exitGate: true,
        }
        window.history.pushState(gate, '', urlForAppView(active))
        exitGateDepthRef.current = gate.appDepth!
        return
      }
      showAppView(entry.view, entry)
    }

    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.history.scrollRestoration = previousRestoration
    }
  }, [])

  const restoreScreenPosition = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const saved = pendingScreenRestoreRef.current
    if (!saved || keyForAppView(saved.view) !== keyForAppView(currentViewRef.current)) return

    // AnimatePresence(mode="wait") delays mounting the destination page.
    // Restore only after it exists and its list has laid out.
    window.requestAnimationFrame(() => {
      if (pendingScreenRestoreRef.current !== saved) return
      if (saved.view.tab === 'library' && saved.view.gameId == null) {
        libraryCollapseProgress.set(saved.controls?.progress ?? 0)
      }
      const restoreScroll = () => {
        if (viewportPageRef.current?.classList.contains('page--viewport')) {
          viewportPageRef.current.scrollTop = saved.scrollY
          window.scrollTo(0, 0)
        } else {
          window.scrollTo(0, saved.scrollY)
        }
      }
      restoreScroll()
      window.requestAnimationFrame(() => {
        if (pendingScreenRestoreRef.current !== saved) return
        restoreScroll()
        libraryLastScrollYRef.current = Math.max(0, window.scrollY)
        pendingScreenRestoreRef.current = null
        libraryScrollSyncPausedRef.current = false
      })
    })
  }, [libraryCollapseProgress])

  useEffect(() => {
    let cancelled = false
    let bootstrapFinished = false
    let progressFrame: number | undefined
    let progressTimer: number | undefined
    let displayedProgress = 12
    const startedAt = performance.now()

    // The backend doesn't provide download byte counts. Instead of freezing
    // at 22%, show smoothly estimated progress that never claims completion
    // while /api/bootstrap is pending. The true completion gate remains the
    // successful (or failed) bootstrap response.
    progressTimer = window.setInterval(() => {
      if (cancelled || bootstrapFinished) return
      const elapsed = performance.now() - startedAt
      const estimate = 12 + 80 * (1 - Math.exp(-elapsed / 5700))
      displayedProgress = Math.max(displayedProgress, Math.min(92, estimate))
      setLoadingProgress(Math.round(displayedProgress))
    }, 90)

    const finishProgress = () => {
      bootstrapFinished = true
      if (progressTimer !== undefined) window.clearInterval(progressTimer)
      if (cancelled) return

      setLoadingPhase('complete')
      const from = displayedProgress
      const finishStart = performance.now()
      const finishDuration = 680
      const advance = (now: number) => {
        if (cancelled) return
        const t = Math.min(1, (now - finishStart) / finishDuration)
        const eased = t * t * (3 - 2 * t)
        setLoadingProgress(Math.round(from + (100 - from) * eased))
        if (t < 1) progressFrame = window.requestAnimationFrame(advance)
        else setAuthReady(true)
      }
      progressFrame = window.requestAnimationFrame(advance)
    }

    const restoreSession = async () => {
      try {
        const response = await sessionFetch('/api/bootstrap')
        if (cancelled) return
        if (response.status === 401) {
          setAuthUser(null)
          setBootstrapError(false)
          return
        }
        if (!response.ok) throw new Error('Bootstrap unavailable')

        const payload = await response.json() as BootstrapPayload
        if (cancelled) return
        setLoadingPhase('preparing')
        applyBootstrap(payload)
        setBootstrapError(false)
      } catch {
        // A 5xx response, network failure or invalid JSON is NOT a logout.
        if (!cancelled) setBootstrapError(true)
      } finally {
        finishProgress()
      }
    }

    void restoreSession()

    return () => {
      cancelled = true
      if (progressTimer !== undefined) window.clearInterval(progressTimer)
      if (progressFrame !== undefined) window.cancelAnimationFrame(progressFrame)
    }
  }, [bootstrapRetry])

  useEffect(() => {
    if (
      activeTab !== 'library' ||
      !librarySearchOpen ||
      !focusLibrarySearchOnOpen.current
    ) return

    focusLibrarySearchOnOpen.current = false
    const frame = window.requestAnimationFrame(() => {
      librarySearchInputRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeTab, librarySearchOpen])

  useEffect(() => {
    // The App renders a loading/auth shell before the library mounts.
    // Never read or apply its scroll position as library collapse progress.
    if (!authReady || !authUser || activeTab !== 'library' || selectedGameId != null) return

    const collapseDistance = 210
    const topStart = 4
    let scrollFrame: number | null = null

    const pending = pendingScreenRestoreRef.current
    const restoringLibrary = pending?.view.tab === 'library' && pending.view.gameId == null
    const savedControls = restoringLibrary ? pending.controls : undefined

    // Only the very first, non-restored library visit starts at scroll zero.
    // A Back navigation instead restores the snapshot from browser history.
    if (!libraryHasOpenedRef.current) {
      libraryHasOpenedRef.current = true
      if (!restoringLibrary && window.scrollY !== 0) window.scrollTo(0, 0)
    }

    libraryToggleGenerationRef.current += 1
    libraryToggleAnimationRef.current?.stop()
    libraryToggleAnimationRef.current = null
    libraryScrollSyncPausedRef.current = Boolean(restoringLibrary)
    const progress = savedControls?.progress ?? 0
    libraryCollapseProgress.set(progress)
    setLibraryControlsCollapsed(progress >= .84)

    const initialY = restoringLibrary && pending
      ? Math.max(0, pending.scrollY)
      : Math.max(0, window.scrollY)
    libraryScrollAnchorRef.current = savedControls?.anchor ?? Math.max(topStart, initialY)
    libraryEntryAnchorActiveRef.current = savedControls?.entryAnchorActive ?? initialY > topStart
    libraryForceCollapsedRef.current = savedControls?.forcedCollapsed ?? false
    libraryForcedRevealStartRef.current = null
    libraryTopLatchRef.current = savedControls?.topLatch ?? initialY <= topStart
    libraryLastScrollYRef.current = initialY

    const syncControlsToScroll = () => {
      if (libraryScrollSyncPausedRef.current) return

      const currentY = Math.max(0, window.scrollY)
      const previousY = libraryLastScrollYRef.current
      const scrollingDown = currentY > previousY + .5
      libraryLastScrollYRef.current = currentY

      // Manual chevron collapse must win over scroll anchoring even at y=0.
      if (libraryForceCollapsedRef.current) {
        libraryCollapseProgress.set(1)
        return
      }

      // Keep the library open through the native top-of-page rubber band.
      if (currentY <= topStart) {
        libraryTopLatchRef.current = true
        libraryEntryAnchorActiveRef.current = false
        libraryScrollAnchorRef.current = topStart
        libraryForceCollapsedRef.current = false
        libraryCollapseProgress.set(0)
        return
      }

      if (libraryTopLatchRef.current) {
        if (!scrollingDown || currentY < topStart + 18) {
          libraryCollapseProgress.set(0)
          return
        }
        libraryTopLatchRef.current = false
      }

      // When returning from details, the browser may restore a nonzero
      // scroll offset. Start expanded and animate from that entry offset,
      // instead of instantly jumping to the global top-zone progress.
      if (libraryEntryAnchorActiveRef.current) {
        const progress = Math.min(1, Math.max(
          0,
          (currentY - libraryScrollAnchorRef.current) / collapseDistance,
        ))
        libraryCollapseProgress.set(progress)
        return
      }

      // The top 210px is a symmetric collapse/reveal zone.
      if (currentY <= topStart + collapseDistance) {
        libraryCollapseProgress.set(Math.min(1, Math.max(0, (currentY - topStart) / collapseDistance)))
        return
      }

      const anchor = libraryScrollAnchorRef.current || topStart
      libraryCollapseProgress.set(Math.min(1, Math.max(0, (currentY - anchor) / collapseDistance)))
    }

    const queueScrollSync = () => {
      if (scrollFrame != null) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null
        syncControlsToScroll()
      })
    }

    // Do not sync immediately: the incoming library hasn't measured or
    // mounted during the AnimatePresence route transition.
    window.addEventListener('scroll', queueScrollSync, { passive: true })
    return () => {
      window.removeEventListener('scroll', queueScrollSync)
      if (scrollFrame != null) window.cancelAnimationFrame(scrollFrame)
      libraryToggleGenerationRef.current += 1
      libraryToggleAnimationRef.current?.stop()
      libraryToggleAnimationRef.current = null
      libraryScrollSyncPausedRef.current = false
    }
  }, [authReady, authUser, activeTab, selectedGameId, libraryCollapseProgress])

  // The library page is unmounted while a game detail is visible. Measuring
  // only in an App-level effect misses its delayed remount (AnimatePresence
  // mode="wait"), leaving the animated clip with a height of zero.
  const measureLibraryControls = useCallback((node: HTMLDivElement | null) => {
    libraryControlsObserverRef.current?.disconnect()
    libraryControlsObserverRef.current = null

    if (libraryControlsMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(libraryControlsMeasureFrameRef.current)
      libraryControlsMeasureFrameRef.current = null
    }

    if (!node) return

    const updateHeight = () => {
      if (!node.isConnected) return
      const height = node.getBoundingClientRect().height
      if (height <= 0 || !Number.isFinite(height)) return

      libraryMeasuredControlsHeight.set(height)
      setLibraryControlsMeasured(true)
    }

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)
    libraryControlsObserverRef.current = observer

    // Measure once more after Motion attaches its subscriptions and the
    // library entrance transition has committed.
    libraryControlsMeasureFrameRef.current = window.requestAnimationFrame(() => {
      libraryControlsMeasureFrameRef.current = null
      updateHeight()
    })
  }, [libraryMeasuredControlsHeight])

  const catalogGameById = useMemo(() => new Map(catalogGames.map((game) => [game.id, game])), [catalogGames])
  // Build all memberships in one pass instead of filtering the library once
  // for every cover on the collections overview.
  const collectionGamesById = useMemo(() => {
    const byCollection = new Map<string, Game[]>()
    for (const entry of entries) {
      const game = catalogGameById.get(entry.gameId)
      if (!game) continue
      for (const collectionId of entry.collectionIds) {
        const games = byCollection.get(collectionId)
        if (games) games.push(game)
        else byCollection.set(collectionId, [game])
      }
    }
    return byCollection
  }, [entries, catalogGameById])

  const sortedCollections = useMemo(() => sortCollections(collections), [collections])

  const entryMap = useMemo(
    () => new Map(entries.map((entry) => [entry.gameId, entry])),
    [entries],
  )

  // A wishlist-only record belongs to «Хочу пройти», not to «Мои игры».
  // Keep it in entries so collection membership, detail actions and release
  // notifications continue to work as before.
  const personalLibraryEntries = useMemo(
    () => entries.filter(isPlaythrough),
    [entries],
  )

  useEffect(() => {
    if (!authUser) return
    const controller = new AbortController()
    void sessionFetch('/api/genres', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Genres unavailable')
        return response.json() as Promise<{ id: number; name: string }[]>
      })
      .then((rows) => {
        if (!controller.signal.aborted && Array.isArray(rows)) {
          setGenreCatalog(rows.map((row) => row.name).filter(Boolean))
        }
      })
      .catch(() => { /* Cached game metadata provides an offline fallback. */ })
    return () => controller.abort()
  }, [authUser?.id])

  const availableGenres = useMemo(() => Array.from(new Set([
    ...genreCatalog,
    ...personalLibraryEntries.flatMap((entry) =>
      catalogGameById.get(entry.gameId)?.genres ?? [],
    ),
  ])).sort((a, b) => a.localeCompare(b, 'ru')), [genreCatalog, personalLibraryEntries, catalogGames])

  const availablePlatforms = useMemo(() => {
    return Array.from(
      new Set(personalLibraryEntries.map((entry) => entry.platform).filter((platform): platform is string => Boolean(platform))),
    ).sort((a, b) => a.localeCompare(b, 'ru'))
  }, [personalLibraryEntries])

  const libraryGames = useMemo(() => {
    const normalized = query.trim().toLowerCase()

    const result = personalLibraryEntries
      .filter((entry) => statusFilters.length === 0 || statusFilters.includes(entry.status))
      .map((entry) => ({ entry, game: catalogGameById.get(entry.gameId)! }))
      .filter(({ game, entry }) => {
        const queryMatch =
          !normalized ||
          game.title.toLowerCase().includes(normalized) ||
          game.genres.some((genre) => genre.toLowerCase().includes(normalized)) ||
          game.developer.toLowerCase().includes(normalized)
        const genreMatch = genreFilter === 'all' || game.genres.includes(genreFilter)
        const platformMatch = platformFilter === 'all' || entry.platform === platformFilter

        return queryMatch && genreMatch && platformMatch
      })

    return result.sort((a, b) => {
      if (sortMode === 'score-desc') {
        return (b.entry.score ?? -1) - (a.entry.score ?? -1)
      }

      if (sortMode === 'score-asc') {
        const scoreA = a.entry.score ?? Number.POSITIVE_INFINITY
        const scoreB = b.entry.score ?? Number.POSITIVE_INFINITY
        return scoreA - scoreB
      }

      if (sortMode === 'title') {
        return a.game.title.localeCompare(b.game.title, 'ru')
      }

      // True user activity is a status assignment/transition, not a
      // completion date, collection addition, or reordering of entries.
      // Tie-break independently of array order so optimistic collection
      // updates cannot unexpectedly move games with the same timestamp.
      const activityA = Date.parse(a.entry.statusChangedAt ?? '') || 0
      const activityB = Date.parse(b.entry.statusChangedAt ?? '') || 0
      return activityB - activityA
        || a.game.title.localeCompare(b.game.title, 'ru', { sensitivity: 'base' })
        || a.game.id - b.game.id
    })
  }, [personalLibraryEntries, query, statusFilters, genreFilter, platformFilter, sortMode, catalogGameById])

  const activeExtraFilters =
    (genreFilter !== 'all' ? 1 : 0) +
    (platformFilter !== 'all' ? 1 : 0)

  const resetExtraFilters = () => {
    setGenreFilter('all')
    setPlatformFilter('all')
  }

  const rememberCatalogResults = useCallback((results: Game[], preserveCommunityRating = false) => {
    if (results.length === 0) return
    setCatalogGames((current) => {
      const merged = new Map(current.map((game) => [game.id, game]))
      results.forEach((game) => {
        const existing = merged.get(game.id)
        // Slower IGDB detail responses must not roll back a newer aggregate
        // received from a completed save or the fresh rating endpoint.
        merged.set(game.id, preserveCommunityRating && existing
          ? { ...game, communityRating: existing.communityRating, communityRatings: existing.communityRatings }
          : game)
      })
      return Array.from(merged.values())
    })
  }, [])

  const loadSearchPage = useCallback(async ({
    query,
    source,
    offset,
    append,
    generation,
  }: {
    query: string
    source: SearchSource
    offset: number
    append: boolean
    generation: number
  }) => {
    if (addSearchBusyRef.current || generation !== addSearchGenerationRef.current) return

    const controller = new AbortController()
    addSearchAbortRef.current = controller
    addSearchBusyRef.current = true
    setAddSearchLoading(true)
    setAddSearchError('')

    try {
      const params = new URLSearchParams({
        q: query,
        source,
        offset: String(offset),
      })
      const response = await sessionFetch(`/api/games/search?${params}`, {
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null) as GameSearchPage | { detail?: string } | null
      if (controller.signal.aborted || generation !== addSearchGenerationRef.current) return

      if (!response.ok || !payload || !('items' in payload) || !Array.isArray(payload.items)) {
        const detail = payload && 'detail' in payload ? payload.detail : undefined
        throw new Error(detail || (source === 'igdb'
          ? 'Не удалось загрузить игры из IGDB.'
          : 'Не удалось выполнить поиск в базе игр.'))
      }

      const page = payload as GameSearchPage
      setAddResults((current) => {
        if (!append) return page.items
        const known = new Set(current.map((game) => game.id))
        return [...current, ...page.items.filter((game) => {
          if (known.has(game.id)) return false
          known.add(game.id)
          return true
        })]
      })
      setAddSearchHasMore(Boolean(page.hasMore))
      setAddSearchNextOffset(page.nextOffset ?? offset + page.items.length)
      if (source === 'local' && !append && page.items.length === 0) {
        // IGDB includes uncached games, including announced future releases.
        setLocalSearchMissQuery(query)
      }
      rememberCatalogResults(page.items)
    } catch (error) {
      if (!controller.signal.aborted && generation === addSearchGenerationRef.current) {
        setAddSearchError(
          error instanceof Error ? error.message : 'Не удалось загрузить игры. Попробуй снова.',
        )
      }
    } finally {
      if (generation === addSearchGenerationRef.current) {
        addSearchBusyRef.current = false
        if (addSearchAbortRef.current === controller) addSearchAbortRef.current = null
        setAddSearchLoading(false)
      }
    }
  }, [rememberCatalogResults])

  useEffect(() => {
    const query = addQuery.trim()
    const generation = ++addSearchGenerationRef.current
    addSearchAbortRef.current?.abort()
    addSearchAbortRef.current = null
    addSearchBusyRef.current = false

    setAddSearchSource('local')
    setLocalSearchMissQuery(null)
    setAddResults([])
    setAddSearchError('')
    setAddSearchHasMore(false)
    setAddSearchNextOffset(0)
    setAddSearchLoading(query.length >= 3)

    if (query.length < 3) return

    const timer = window.setTimeout(() => {
      void loadSearchPage({ query, source: 'local', offset: 0, append: false, generation })
    }, 350)

    return () => {
      window.clearTimeout(timer)
      addSearchAbortRef.current?.abort()
      addSearchBusyRef.current = false
    }
  }, [addQuery, loadSearchPage])

  useEffect(() => {
    if (
      activeTab !== 'add' ||
      addGameId != null ||
      selectedGameId != null ||
      !addSearchHasMore ||
      addSearchLoading ||
      addSearchError ||
      addQuery.trim().length < 3
    ) return

    const sentinel = addSearchSentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || addSearchBusyRef.current) return
      void loadSearchPage({
        query: addQuery.trim(),
        source: addSearchSource,
        offset: addSearchNextOffset,
        append: true,
        generation: addSearchGenerationRef.current,
      })
    }, { rootMargin: '600px 0px', threshold: 0 })

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    activeTab, addGameId, selectedGameId, addSearchHasMore,
    addSearchLoading, addSearchError, addSearchSource,
    addSearchNextOffset, addQuery, addResults.length, loadSearchPage,
  ])

  const searchIgdb = () => {
    const query = addQuery.trim()
    if (
      query.length < 3 ||
      addSearchLoading ||
      addSearchBusyRef.current ||
      addSearchSource === 'igdb'
    ) return

    const generation = ++addSearchGenerationRef.current
    setAddSearchSource('igdb')
    setAddResults([])
    setAddSearchHasMore(false)
    setAddSearchNextOffset(0)
    // IGDB is a new result stream: starting at page one avoids repeated
    // local/IGDB matches and an auto-loading loop when both contain the
    // same games. The list is still infinite-scroll in either mode.
    window.scrollTo({ top: 0, behavior: 'instant' })
    void loadSearchPage({ query, source: 'igdb', offset: 0, append: false, generation })
  }

  useEffect(() => {
    const currentQuery = addQuery.trim()
    if (
      !localSearchMissQuery ||
      localSearchMissQuery !== currentQuery ||
      addSearchSource !== 'local' ||
      addSearchLoading ||
      addSearchBusyRef.current
    ) return

    // Empty local results should seamlessly search IGDB without making the
    // user guess that a separate database search is required.
    setLocalSearchMissQuery(null)
    searchIgdb()
  }, [localSearchMissQuery, addQuery, addSearchSource, addSearchLoading])

  const retrySearch = () => {
    if (addSearchBusyRef.current) return
    void loadSearchPage({
      query: addQuery.trim(),
      source: addSearchSource,
      offset: addSearchNextOffset,
      append: addSearchSource === 'igdb' || addSearchNextOffset > 0,
      generation: addSearchGenerationRef.current,
    })
  }

  const counts = useMemo(() => ({
    completed: entries.filter((entry) => entry.status === 'completed').length,
    playing: entries.filter((entry) => entry.status === 'playing').length,
    wishlist: entries.filter((entry) => entry.collectionIds.includes(WISHLIST_COLLECTION_ID)).length,
    dropped: entries.filter((entry) => entry.status === 'dropped').length,
  }), [entries])

  const averageLibraryScore = useMemo(() => {
    const scores = entries
      .map((entry) => entry.score)
      .filter((score): score is number => score != null)

    if (scores.length === 0) return null
    return scores.reduce((sum, score) => sum + score, 0) / scores.length
  }, [entries])

  const toggleStatusFilter = (status: LibraryStatus) => {
    setStatusFilters((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    )
  }

  const openTab = (tab: Tab) => {
    // A bottom-nav selection starts a new navigation chain. Replace the old
    // location instead of adding it as a step in the destination tab's Back.
    navigateTo({ tab, gameId: null, collectionId: null, formGameId: null }, { replace: true })
  }

  // Re-selecting the active bottom tab, or tapping the My Games title,
  // starts that tab from scratch without logging out or reloading the PWA.
  const resetTab = (tab: Tab) => {
    const view: AppView = { tab, gameId: null, collectionId: null, formGameId: null }
    // Resetting an active tab from a nested screen must also establish a root
    // exit boundary. Disarm any earlier exit prompt when reselecting a tab.
    clearExitPrompt()
    setCollectionPickerOpen(false)
    setDeleteCollectionPrompt(null)
    setDeleteGamePrompt(null)
    setBulkDeleteCollectionPrompt(null)
    setSelectedCollectionIds([])
    cancelCollectionHold()
    setDeleteCollectionError('')

    if (tab === 'library') {
      libraryToggleAnimationRef.current?.stop()
      libraryToggleAnimationRef.current = null
      libraryHasOpenedRef.current = false
      libraryScrollAnchorRef.current = 4
      libraryEntryAnchorActiveRef.current = false
      libraryForceCollapsedRef.current = false
      libraryForcedRevealStartRef.current = null
      libraryTopLatchRef.current = true
      libraryLastScrollYRef.current = 0
      libraryCollapseProgress.set(0)
      setLibraryControlsCollapsed(false)
      resetLibraryFilters()
      setSortMode('activity')
      setQuery('')
      setFiltersOpen(false)
      setLibrarySearchOpen(false)
      focusLibrarySearchOnOpen.current = false
      librarySearchInputRef.current?.blur()
      libraryLastSnapshotRef.current = null
    }

    if (tab === 'add') {
      addSearchGenerationRef.current += 1
      addSearchAbortRef.current?.abort()
      addSearchAbortRef.current = null
      addSearchBusyRef.current = false
      setAddQuery('')
      setAddResults([])
      setAddSearchLoading(false)
      setAddSearchError('')
      setAddSearchSource('local')
      setAddSearchHasMore(false)
      setAddSearchNextOffset(0)
      setLocalSearchMissQuery(null)
      setAddStatus('completed')
      setAddPlatform('')
      setAddReview('')
      setAddReviewOpen(false)
      setAddCollectionIds([])
      setAddDate(new Date().toISOString().slice(0, 10))
      setAddAtmosphereScore(8)
      setAddStoryScore(8)
      setAddTechnologyScore(8)
      setAddGameplayScore(8)
      addSearchInputRef.current?.blur()
    }

    if (tab === 'collections') {
      setEditingCollectionId(null)
      setRemovedCollectionGameIds([])
      setCollectionEditError('')
      setCollectionTitle('')
      setCollectionDescription('')
      setCollectionColorScheme('violet')
      setCollectionEmoji('')
      setCollectionError('')
    }

    const previousEntry = readAppHistoryEntry(window.history.state)
    const entry: AppHistoryEntry = {
      rateAppView: true, view, scrollY: 0,
      fromApp: previousEntry?.fromApp ?? false,
      appDepth: previousEntry?.appDepth ?? 0,
      exitGate: previousEntry?.exitGate && isRootScreen(view),
      collectionPickerOpen: false,
      ...(tab === 'library' ? { controls: {
        progress: 0, anchor: 4, forcedCollapsed: false,
        topLatch: true, entryAnchorActive: false,
      } } : {}),
    }
    // Replace the nested location; its old child screen cannot be revisited.
    window.history.replaceState(entry, '', urlForAppView(view))
    showAppView(view, entry)
    if (!entry.exitGate) pushRootExitGate(view, entry)
    viewportPageRef.current?.scrollTo({ top: 0, behavior: 'instant' })
    window.scrollTo({ top: 0, behavior: 'instant' })
    setScreenRevision((revision) => revision + 1)

    // Refresh server-backed membership/status data on a tab reset as well.
    void sessionFetch('/api/bootstrap').then(async (response) => {
      if (!response.ok) return
      const payload = await response.json() as BootstrapPayload
      if (payload.user.nickname === authUser?.nickname) applyBootstrap(payload)
    }).catch(() => { /* Keep the existing local data while offline. */ })
  }

  const openGame = (gameId: number) => {
    navigateTo({
      tab: currentViewRef.current.tab,
      gameId,
      collectionId: currentViewRef.current.collectionId,
      formGameId: null,
    })
  }

  const editingFromDetailRef = useRef(false)

  const startAdding = (game: Game) => {
    editingFromDetailRef.current = currentViewRef.current.gameId === game.id
    setAddStatus('completed')
    setAddPlatform(preferredPlatform(game.platforms))
    setAddDate(new Date().toISOString().slice(0, 10))
    setAddAtmosphereScore(8)
    setAddStoryScore(8)
    setAddTechnologyScore(8)
    setAddGameplayScore(8)
    setAddReview('')
    setAddReviewOpen(false)
    // Preserve memberships when a wishlist-only game gains a playthrough.
    setAddCollectionIds(entryMap.get(game.id)?.collectionIds ?? [])
    navigateTo({ tab: 'add', gameId: null, collectionId: null, formGameId: game.id })
  }

  const startEditing = (game: Game, entry: LibraryEntry) => {
    editingFromDetailRef.current = currentViewRef.current.gameId === game.id
    setAddStatus(entry.status)
    setAddPlatform(entry.platform ?? preferredPlatform(game.platforms))
    setAddDate(entry.completedAt ?? new Date().toISOString().slice(0, 10))
    const fallbackScore = entry.score ?? 8
    setAddAtmosphereScore(closestHalfPoint(entry.atmosphereScore ?? fallbackScore))
    setAddStoryScore(closestHalfPoint(entry.storyScore ?? fallbackScore))
    setAddTechnologyScore(closestHalfPoint(entry.technologyScore ?? fallbackScore))
    setAddGameplayScore(closestHalfPoint(entry.gameplayScore ?? fallbackScore))
    setAddReview(entry.review ?? '')
    setAddReviewOpen(Boolean(entry.review))
    setAddCollectionIds(entry.collectionIds)
    navigateTo({ tab: 'add', gameId: null, collectionId: null, formGameId: game.id })
  }

  const saveGame = async () => {
    const game = catalogGameById.get(addGameId!)
    if (!game) return

    const today = new Date().toISOString().slice(0, 10)
    if (ratedStatuses.has(addStatus) && (!addPlatform.trim() || !addDate)) {
      window.alert('Для прохождения обязательно укажите платформу и дату.')
      return
    }
    const nextEntry: LibraryEntry = {
      gameId: game.id,
      status: addStatus,
      platform: addStatus === 'wishlist' ? undefined : addPlatform,
      completedAt: ratedStatuses.has(addStatus) ? addDate : undefined,
      startedAt: addStatus === 'playing' ? today : undefined,
      score: ratedStatuses.has(addStatus) ? calculatedAddScore : undefined,
      atmosphereScore: ratedStatuses.has(addStatus) ? addAtmosphereScore : undefined,
      storyScore: ratedStatuses.has(addStatus) ? addStoryScore : undefined,
      technologyScore: ratedStatuses.has(addStatus) ? addTechnologyScore : undefined,
      gameplayScore: ratedStatuses.has(addStatus) ? addGameplayScore : undefined,
      review: ratedStatuses.has(addStatus) ? (addReview.trim() || undefined) : undefined,
      collectionIds: addCollectionIds,
      addedAt: entryMap.get(game.id)?.addedAt ?? today,
    }

    try {
      const response = await sessionFetch(`/api/library/${game.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextEntry),
      })

      if (!response.ok) {
        window.alert('Не удалось сохранить игру. Попробуйте ещё раз.')
        return
      }
      const savedPayload = await response.json() as ApiLibraryEntry
      const savedEntry = normalizeEntry(savedPayload)
      setEntries((current) => [...current.filter((entry) => entry.gameId !== game.id), savedEntry])
      if (savedPayload.game) rememberCatalogResults([savedPayload.game])
    } catch {
      window.alert('Не удалось сохранить игру. Проверьте соединение и попробуйте ещё раз.')
      return
    }

    // Keep the search text/results in memory so Back from the saved game
    // returns to the original database results.
    const gameView: AppView = { tab: 'library', gameId: game.id, collectionId: null, formGameId: null }
    if (editingFromDetailRef.current) {
      editingFromDetailRef.current = false
      goBackOr(gameView)
    } else {
      navigateTo(gameView, { replace: true })
    }
  }

  const syncCollectionMemberships = async (gameId: number, update: CollectionUpdate) => {
    if (update.syncing) return
    update.syncing = true
    try {
      // Serialize all membership changes for the game: simultaneous taps must not
      // create duplicate library placeholders or race with one another.
      while (true) {
        const pending = [...update.desired].find(
          ([collectionId, enabled]) => update.persisted.get(collectionId) !== enabled,
        )
        if (!pending) break
        const [collectionId, enabled] = pending
        const url = collectionId === WISHLIST_COLLECTION_ID
          ? `/api/library/${gameId}/wishlist`
          : `/api/library/${gameId}/collections/${encodeURIComponent(collectionId)}`
        const response = await sessionFetch(url, { method: enabled ? 'PUT' : 'DELETE' })
        if (!response.ok) throw new Error('Collection membership update failed')
        update.persisted.set(collectionId, enabled)
      }
    } catch {
      // Only revert unconfirmed changes; preserve other collection memberships.
      setEntries((current) => [...update.desired].reduce(
        (state, [collectionId]) => withCollectionMembership(
          state, gameId, collectionId, update.persisted.get(collectionId) ?? false,
        ),
        current,
      ))
      window.alert('Не удалось обновить коллекции. Попробуйте ещё раз.')
    } finally {
      collectionUpdatesRef.current.delete(gameId)
      update.syncing = false
    }
  }

  const toggleCollectionMembership = (game: Game, collectionId: string) => {
    let update = collectionUpdatesRef.current.get(game.id)
    const included = update?.desired.get(collectionId) ??
      Boolean(entryMap.get(game.id)?.collectionIds.includes(collectionId))
    if (!update) {
      update = { desired: new Map(), persisted: new Map(), syncing: false }
      collectionUpdatesRef.current.set(game.id, update)
    }
    if (!update.persisted.has(collectionId)) update.persisted.set(collectionId, included)
    update.desired.set(collectionId, !included)

    // Change plus/check immediately while the membership request syncs.
    setEntries((current) => withCollectionMembership(current, game.id, collectionId, !included))
    void syncCollectionMemberships(game.id, update)
  }

  const deleteGame = async (game: Game) => {
    if (deleteCollectionBusy) return
    setDeleteCollectionBusy(true)
    setDeleteCollectionError('')
    try {
      const response = await sessionFetch('/api/library/' + game.id, { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось удалить прохождение. Попробуйте ещё раз.')
      setEntries((current) => current.flatMap((entry) => {
        if (entry.gameId !== game.id) return [entry]
        return entry.collectionIds.length > 0
          ? [{ gameId: entry.gameId, status: 'untracked' as const, collectionIds: entry.collectionIds, collectionAddedAt: entry.collectionAddedAt, addedAt: entry.addedAt }]
          : []
      }))
      setDeleteGamePrompt(null)
      if (currentViewRef.current.gameId === game.id) {
        goBackOr({ tab: 'library', gameId: null, collectionId: null, formGameId: null })
      } else {
        navigateTo({ tab: 'library', gameId: null, collectionId: null, formGameId: null }, { replace: true, restoreLibrary: true })
      }
    } catch (error) {
      setDeleteCollectionError(error instanceof Error ? error.message : 'Не удалось удалить прохождение. Проверьте соединение.')
    } finally {
      setDeleteCollectionBusy(false)
    }
  }

  const createCollection = async () => {
    const title = collectionTitle.trim()
    if (!title || collectionSaving) return

    setCollectionSaving(true)
    setCollectionError('')

    try {
      const response = await sessionFetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: collectionDescription.trim() || undefined,
          colorScheme: collectionColorScheme,
          emoji: collectionEmoji,
        }),
      })
      const payload = await response.json().catch(() => null) as GameCollection | { detail?: string } | null

      if (!response.ok || !payload || !('id' in payload)) {
        setCollectionError(collectionValidationMessage(payload, 'Не удалось создать коллекцию.'))
        return
      }

      setCollections((current) => sortCollections([...current, payload]))
      setCollectionTitle('')
      setCollectionDescription('')
      setCollectionColorScheme('violet')
      setCollectionEmoji('')
      // Replace the creation form in browser history so both the toolbar
      // Back button and native mobile Back return to the collections list.
      navigateTo({ tab: 'collections', gameId: null, collectionId: payload.id, formGameId: null }, { replace: true })
    } catch {
      setCollectionError('Не удалось создать коллекцию. Проверьте соединение.')
    } finally {
      setCollectionSaving(false)
    }
  }


  const startCollectionEdit = (collection: GameCollection) => {
    setSelectedCollectionGameIds([])
    cancelCollectionGameHold()
    setEditingCollectionId(collection.id)
    setEditCollectionTitle(collection.title)
    setEditCollectionDescription(collection.description)
    setEditCollectionColor(collection.colorScheme ?? 'violet')
    setEditCollectionEmoji(collection.emoji ?? '')
    setRemovedCollectionGameIds([])
    setCollectionEditError('')
  }

  const cancelCollectionEdit = () => {
    setEditingCollectionId(null)
    setRemovedCollectionGameIds([])
    setCollectionEditError('')
  }

  const saveCollectionEdit = async (collection: GameCollection) => {
    if (collectionEditBusy || (!collection.isSystem && !editCollectionTitle.trim())) return
    setCollectionEditBusy(true)
    setCollectionEditError('')
    try {
      const response = await sessionFetch(`/api/collections/${encodeURIComponent(collection.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collection.isSystem
          ? { removedGameIds: removedCollectionGameIds }
          : {
              ...(editCollectionTitle.trim() !== collection.title
                ? { title: editCollectionTitle.trim() }
                : {}),
              description: editCollectionDescription.trim(),
              colorScheme: editCollectionColor,
              emoji: editCollectionEmoji,
              removedGameIds: removedCollectionGameIds,
            }),
      })
      const payload = await response.json().catch(() => null) as {
        collection?: GameCollection
        library?: ApiLibraryEntry[]
        detail?: unknown
      } | null
      if (!response.ok || !payload?.collection || !payload.library) {
        throw new Error(collectionValidationMessage(payload, 'Не удалось сохранить изменения.'))
      }
      setCollections((current) => sortCollections(current.map((item) =>
        item.id === collection.id ? payload.collection! : item,
      )))
      setEntries(payload.library.map(normalizeEntry))
      cancelCollectionEdit()
    } catch (error) {
      setCollectionEditError(error instanceof Error ? error.message : 'Не удалось сохранить изменения.')
    } finally {
      setCollectionEditBusy(false)
    }
  }

  const deleteCollection = async (collection: GameCollection) => {
    if (collection.isSystem || deleteCollectionBusy) return
    setDeleteCollectionBusy(true)
    setDeleteCollectionError('')
    try {
      const response = await sessionFetch(`/api/collections/${encodeURIComponent(collection.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось удалить коллекцию. Попробуйте ещё раз.')
      setCollections((current) => current.filter((item) => item.id !== collection.id))
      setEntries((current) => current.flatMap((entry) => {
        const ids = entry.collectionIds.filter((id) => id !== collection.id)
        return !isPlaythrough(entry) && ids.length === 0 ? [] : [{ ...entry, collectionIds: ids }]
      }))
      setDeleteCollectionPrompt(null)
      cancelCollectionEdit()
      navigateTo({ tab: 'collections', gameId: null, collectionId: null, formGameId: null }, { replace: true })
    } catch (error) {
      setDeleteCollectionError(error instanceof Error ? error.message : 'Не удалось удалить коллекцию.')
    } finally {
      setDeleteCollectionBusy(false)
    }
  }

  const deleteSelectedCollections = async (ids: string[]) => {
    if (deleteCollectionBusy || !ids.length) return
    setDeleteCollectionBusy(true)
    setDeleteCollectionError('')
    try {
      const response = await sessionFetch('/api/collections/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const payload = await response.json().catch(() => null) as {
        deletedIds?: string[]; library?: ApiLibraryEntry[]; detail?: unknown
      } | null
      if (!response.ok || !Array.isArray(payload?.deletedIds) || !Array.isArray(payload?.library)) {
        throw new Error(collectionValidationMessage(payload, 'Не удалось удалить выбранные коллекции.'))
      }
      const deleted = new Set(payload.deletedIds)
      setCollections((current) => current.filter((item) => !deleted.has(item.id)))
      setEntries(payload.library.map(normalizeEntry))
      setBulkDeleteCollectionPrompt(null)
      setSelectedCollectionIds([])
    } catch (error) {
      setDeleteCollectionError(error instanceof Error ? error.message : 'Не удалось удалить выбранные коллекции.')
    } finally {
      setDeleteCollectionBusy(false)
    }
  }

  const removeSelectedCollectionGames = async (prompt: { collectionId: string; gameIds: number[] }) => {
    if (deleteCollectionBusy || !prompt.gameIds.length) return
    setDeleteCollectionBusy(true)
    setDeleteCollectionError('')
    try {
      const response = await sessionFetch(`/api/collections/${encodeURIComponent(prompt.collectionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removedGameIds: prompt.gameIds }),
      })
      const payload = await response.json().catch(() => null) as {
        collection?: GameCollection; library?: ApiLibraryEntry[]; detail?: unknown
      } | null
      if (!response.ok || !payload?.collection || !Array.isArray(payload.library)) {
        throw new Error(collectionValidationMessage(payload, 'Не удалось убрать выбранные игры.'))
      }
      // The API returns the full library after one atomic change. Completed and
      // dropped playthroughs, as well as memberships in other collections, survive.
      setEntries(payload.library.map(normalizeEntry))
      setBulkRemoveGamesPrompt(null)
      setSelectedCollectionGameIds([])
      suppressCollectionGameClickRef.current = null
    } catch (error) {
      setDeleteCollectionError(error instanceof Error ? error.message : 'Не удалось убрать выбранные игры.')
    } finally {
      setDeleteCollectionBusy(false)
    }
  }

  const toggleCollectionGameSelection = (gameId: number) => {
    setSelectedCollectionGameIds((ids) => ids.includes(gameId)
      ? ids.filter((id) => id !== gameId)
      : [...ids, gameId])
  }

  const holdCollectionGame = (gameId: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (selectedCollectionGameIds.length || editingCollectionId || event.button !== 0) return
    cancelCollectionGameHold()
    const pointerId = event.pointerId
    const timer = window.setTimeout(() => {
      if (collectionGameHoldRef.current?.pointerId !== pointerId) return
      collectionGameHoldRef.current = null
      suppressCollectionGameClickRef.current = { gameId, time: Date.now() }
      setSelectedCollectionGameIds((ids) => ids.includes(gameId) ? ids : [...ids, gameId])
    }, 480)
    collectionGameHoldRef.current = { pointerId, gameId, x: event.clientX, y: event.clientY, timer }
  }

  const moveCollectionGameHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const held = collectionGameHoldRef.current
    if (held?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - held.x, event.clientY - held.y) > 10) cancelCollectionGameHold()
  }

  const toggleCollectionSelection = (collection: GameCollection) => {
    if (collection.isSystem) return
    setSelectedCollectionIds((ids) => ids.includes(collection.id)
      ? ids.filter((id) => id !== collection.id)
      : [...ids, collection.id])
  }
  const holdCollection = (collection: GameCollection, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (collection.isSystem || selectedCollectionIds.length || event.button !== 0) return
    cancelCollectionHold()
    const pointerId = event.pointerId
    const timer = window.setTimeout(() => {
      if (collectionHoldRef.current?.pointerId !== pointerId) return
      collectionHoldRef.current = null
      suppressCollectionClickRef.current = { id: collection.id, time: Date.now() }
      setSelectedCollectionIds((ids) => ids.includes(collection.id) ? ids : [...ids, collection.id])
    }, 480)
    collectionHoldRef.current = { pointerId, x: event.clientX, y: event.clientY, timer }
  }
  const moveCollectionHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const held = collectionHoldRef.current
    if (held?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - held.x, event.clientY - held.y) > 10) cancelCollectionHold()
  }

  const openCollectionCreator = () => {
    setCollectionTitle('')
    setCollectionDescription('')
    setCollectionColorScheme('violet')
    setCollectionEmoji('🎮')
    setCollectionError('')
    cancelCollectionEdit()
    navigateTo({ tab: 'collections', gameId: null, collectionId: 'new', formGameId: null })
  }

  // Refresh the aggregate when a detail page opens, including after saving
  // a playthrough. Other users may have rated the game since search began.
  // Fetch only this small aggregate, not the entire IGDB details payload.
  useEffect(() => {
    if (!authUser || selectedGameId == null) return
    const gameId = selectedGameId
    const controller = new AbortController()
    const refreshRating = async () => {
      try {
        const response = await sessionFetch(`/api/games/${gameId}/community-rating`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) return
        const rating = await response.json() as {
          gameId: number
          communityRating: number
          communityRatings: number
        }
        if (controller.signal.aborted || rating.gameId !== gameId) return
        setCatalogGames((current) => current.map((game) => game.id === gameId
          ? {
            ...game,
            communityRating: rating.communityRating,
            communityRatings: rating.communityRatings,
          }
          : game))
      } catch {
        // Show the last known server aggregate when temporarily offline.
      }
    }
    void refreshRating()
    return () => controller.abort()
  }, [authUser?.id, selectedGameId])

  // IGDB metadata is fetched only when the detail screen opens; search
  // results remain fast. The API caches enriched data for future opens.
  useEffect(() => {
    const gameId = selectedGameId
    if (
      !authUser ||
      gameId == null ||
      gameDetailsById[gameId] ||
      failedGameDetailsId === gameId
    ) return

    const controller = new AbortController()
    setLoadingGameDetailsId(gameId)

    const fetchDetails = async () => {
      try {
        const response = await sessionFetch(`/api/games/${gameId}/details`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Game metadata is not available')
        const payload = await response.json() as GameDetailExtras
        if (controller.signal.aborted) return
        if (payload.game) rememberCatalogResults([payload.game], true)
        setGameDetailsById((previous) => ({ ...previous, [gameId]: {
          storyHours: typeof payload.storyHours === 'number' ? payload.storyHours : null,
          completionHours: typeof payload.completionHours === 'number' ? payload.completionHours : null,
          storeLinks: Array.isArray(payload.storeLinks) ? payload.storeLinks : [],
          trailerUrl: typeof payload.trailerUrl === 'string' ? payload.trailerUrl : null,
        } }))
      } catch (error) {
        if (!controller.signal.aborted) setFailedGameDetailsId(gameId)
      } finally {
        if (!controller.signal.aborted) {
          setLoadingGameDetailsId((current) => current === gameId ? null : current)
        }
      }
    }

    void fetchDetails()
    return () => controller.abort()
  }, [authUser, selectedGameId, gameDetailsById, failedGameDetailsId, rememberCatalogResults])

  useEffect(() => {
    if (!authUser || !selectedGameId || similarGamesById[selectedGameId] ||
        similarLoadingRef.current.has(selectedGameId)) return
    const id = selectedGameId
    similarLoadingRef.current.add(id)
    const controller = new AbortController()
    void sessionFetch('/api/games/' + id + '/similar', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Similar games unavailable')
        const data = await response.json() as { items: Game[] }
        if (controller.signal.aborted) return
        const games = Array.isArray(data.items) ? data.items : []
        rememberCatalogResults(games)
        setSimilarGamesById(previous => ({ ...previous, [id]: games }))
      })
      .catch(() => {
        if (!controller.signal.aborted) setSimilarGamesById(previous => ({ ...previous, [id]: [] }))
      })
      .finally(() => similarLoadingRef.current.delete(id))
    return () => controller.abort()
  }, [authUser, selectedGameId, similarGamesById, rememberCatalogResults])

  // Reserve a stable shelf from the first render, then reveal its covers together
  // once images are warmed (or after a short upper bound if CDN is slow).
  useEffect(() => {
    if (!selectedGameId) return
    const id = selectedGameId
    const cards = similarGamesById[id]
    if (!cards || similarCoversReadyById[id]) return
    let cancelled = false
    const preloads = cards.filter(game => game.coverUrl).map(game => new Promise<void>(resolve => {
      const img = new Image()
      img.onload = () => resolve()
      img.onerror = () => resolve()
      img.src = game.coverUrl!
      if (img.complete) resolve()
    }))
    let timeout: number | undefined
    const deadline = new Promise<void>(resolve => { timeout = window.setTimeout(resolve, 2200) })
    void Promise.race([Promise.all(preloads), deadline]).then(() => {
      if (!cancelled) setSimilarCoversReadyById(current => ({ ...current, [id]: true }))
    })
    return () => { cancelled = true; if (timeout) window.clearTimeout(timeout) }
  }, [selectedGameId, similarGamesById, similarCoversReadyById])

  const selectedEntry = selectedGameId ? entryMap.get(selectedGameId) : undefined
  const selectedGame = selectedGameId ? catalogGameById.get(selectedGameId!) : undefined

  const showWishlistToast = (gameId: number) => {
    if (wishlistToastTimerRef.current) window.clearTimeout(wishlistToastTimerRef.current)
    setWishlistToastGameId(gameId)
    wishlistToastTimerRef.current = window.setTimeout(() => {
      setWishlistToastGameId(null)
      wishlistToastTimerRef.current = null
    }, 2200)
  }

  const wishlistQuickAdd = async (game: Game) => {
    if (entryMap.get(game.id)?.collectionIds.includes(WISHLIST_COLLECTION_ID)) {
      showWishlistToast(game.id)
      return
    }
    try {
      const response = await sessionFetch('/api/library/' + game.id + '/wishlist', { method: 'PUT' })
      if (!response.ok) throw new Error('Wishlist save failed')
      setEntries(current => withCollectionMembership(current, game.id, WISHLIST_COLLECTION_ID, true))
      showWishlistToast(game.id)
    } catch {
      window.alert('Не удалось добавить игру в «Хочу пройти».')
    }
  }

  const renderDetail = () => {
    if (!selectedGame) {
      return (
        <div className="detail-page">
          <div className="detail-toolbar">
            <button
              className="icon-button detail-back"
              onClick={() => goBackOr({ tab: 'library', gameId: null, collectionId: null, formGameId: null })}
              aria-label="Назад"
            >
              <Icon name="back" size={20} />
            </button>
          </div>
          <p className="game-database-loading" role="status">
            {failedGameDetailsId === selectedGameId ? 'Не удалось загрузить игру.' : 'Загружаем игру из базы…'}
          </p>
        </div>
      )
    }
    const hasRateAppRating = selectedGame.communityRatings > 0
    const hasIgdbRating = selectedGame.igdbRating > 0
    const rateAppScore = hasRateAppRating ? selectedGame.communityRating.toFixed(1) : null
    const igdbScore = hasIgdbRating ? String(selectedGame.igdbRating) : null
    const gameDetails = gameDetailsById[selectedGame.id]
    // Saved PostgreSQL metadata accompanies the game record in bootstrap
    // and search results; show links immediately while playtime enriches.
    const storeLinks = gameDetails?.storeLinks ?? selectedGame.storeLinks ?? []
    const trailerUrl = gameDetails?.trailerUrl ?? selectedGame.trailerUrl ?? null
    const loadingDetails = loadingGameDetailsId === selectedGame.id
    // Compare local calendar dates to avoid hiding the action early because of UTC.
    // Without a confirmed date, a future release year also counts as unreleased.
    const today = new Date()
    const todayLocal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const notReleased = selectedGame.releaseDate
      ? selectedGame.releaseDate > todayLocal
      : selectedGame.year > today.getFullYear()

    return (
      <div className="detail-page">
        <div className="detail-toolbar">
          <button
            className="icon-button detail-back"
            onClick={() => goBackOr({
              tab: currentViewRef.current.tab,
              gameId: null,
              collectionId: currentViewRef.current.collectionId,
              formGameId: null,
            })}
            aria-label="Вернуться назад"
            title="Назад"
          >
            <Icon name="back" size={20} />
          </button>
          <div className="detail-toolbar__actions">
            <button
              type="button"
              className="round-add detail-catalog-icon detail-catalog-icon--collections"
              aria-label="Коллекции"
              title="Управление коллекциями"
              aria-expanded={collectionPickerOpen}
              aria-controls="game-collection-picker"
              onPointerDown={event => {
                // On touchscreens use Touch Events instead: native long-press
                // context menus often cancel Pointer Events before our timeout.
                if (event.pointerType === 'touch' || event.button !== 0 || !event.isPrimary) return
                cancelWishlistHold()
                suppressWishlistClickRef.current = 0
                const timer = window.setTimeout(() => {
                  if (wishlistHoldRef.current?.pointerId !== event.pointerId) return
                  wishlistHoldRef.current = null
                  suppressWishlistClickRef.current = Date.now()
                  setCollectionPickerOpen(false)
                  void wishlistQuickAdd(selectedGame)
                }, 470)
                wishlistHoldRef.current = {
                  pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer,
                }
              }}
              onPointerMove={event => {
                const hold = wishlistHoldRef.current
                if (hold?.pointerId === event.pointerId &&
                    Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10) cancelWishlistHold()
              }}
              onPointerUp={event => { if (event.pointerType !== 'touch') cancelWishlistHold() }}
              onPointerCancel={event => { if (event.pointerType !== 'touch') cancelWishlistHold() }}
              onPointerLeave={event => { if (event.pointerType === 'mouse') cancelWishlistHold() }}
              onTouchStart={event => {
                if (event.touches.length !== 1) return
                cancelWishlistHold()
                suppressWishlistClickRef.current = 0
                const touch = event.touches[0]
                const pointerId = touch.identifier + 10000
                const timer = window.setTimeout(() => {
                  if (wishlistHoldRef.current?.pointerId !== pointerId) return
                  wishlistHoldRef.current = null
                  suppressWishlistClickRef.current = Date.now()
                  setCollectionPickerOpen(false)
                  void wishlistQuickAdd(selectedGame)
                }, 470)
                wishlistHoldRef.current = {
                  pointerId, x: touch.clientX, y: touch.clientY, timer,
                }
              }}
              onTouchMove={event => {
                const hold = wishlistHoldRef.current
                if (!hold) return
                const touch = Array.from(event.touches).find(
                  item => item.identifier + 10000 === hold.pointerId)
                if (!touch || Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 10) {
                  cancelWishlistHold()
                }
              }}
              onTouchEnd={cancelWishlistHold}
              onTouchCancel={cancelWishlistHold}
              onContextMenu={event => { event.preventDefault() }}
              onClick={() => {
                if (suppressWishlistClickRef.current &&
                    Date.now() - suppressWishlistClickRef.current < 1300) {
                  suppressWishlistClickRef.current = 0
                  return
                }
                suppressWishlistClickRef.current = 0
                setCollectionPickerOpen(open => !open)
              }}
            >
              <span className="detail-catalog-icon__symbol detail-catalog-icon__symbol--layers" aria-hidden="true">
                <Icon name="layers" size={19} />
              </span>
              <span className="detail-catalog-icon__symbol detail-catalog-icon__symbol--heart" aria-hidden="true">
                <Icon name="heart" size={19} />
              </span>
            </button>
            {isPlaythrough(selectedEntry) ? (
              <>
                <button
                  className="icon-button detail-edit"
                  onClick={() => startEditing(selectedGame, selectedEntry)}
                  aria-label="Редактировать запись об игре"
                  title="Редактировать"
                >
                  <Icon name="edit" size={19} />
                </button>
                <button
                  className="icon-button detail-delete"
                  onClick={() => { setDeleteCollectionError(''); setDeleteGamePrompt(selectedGame) }}
                  aria-label="Удалить игру из моей библиотеки"
                  title="Удалить"
                >
                  <Icon name="trash" size={19} />
                </button>
              </>
            ) : !notReleased ? (
              <button
                type="button"
                className="round-add detail-catalog-icon detail-catalog-icon--add"
                onClick={() => startAdding(selectedGame)}
                aria-label="Добавить прохождение"
                title="Добавить прохождение"
              >
                <Icon name="plus" size={19} />
              </button>
            ) : null}
          </div>
        </div>

        <AnimatePresence initial={false}>
        {collectionPickerOpen && (
          <motion.section className="detail-collection-picker" id="game-collection-picker" aria-label="Управление коллекциями"
            initial={shouldReduceMotion ? false : { opacity: 0, height: 0, y: -9 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, height: 0, y: -9 }}
            transition={{ duration: shouldReduceMotion ? 0 : .28, ease: 'easeOut' }}>
            <div className="detail-collection-picker__heading">
              <h2>Коллекции</h2>
            </div>
            <div className="detail-collection-picker__grid">
              <LayoutGroup id={`collection-picker-${selectedGame.id}`}>
              {sortCollectionsForGame(collections, selectedEntry?.collectionIds ?? []).map((collection) => {
                const included = Boolean(selectedEntry?.collectionIds.includes(collection.id))
                const collectionGames = entries
                  .filter((entry) => entry.collectionIds.includes(collection.id))
                  .flatMap((entry) => {
                    const game = catalogGameById.get(entry.gameId)
                    return game ? [game] : []
                  })
                return (
                  <motion.div
                    layout={shouldReduceMotion ? false : 'position'}
                    transition={{ layout: { type: 'spring', stiffness: 390, damping: 33, mass: .85 } }}
                    className="collection-card detail-collection-option"
                    style={collectionThemeStyle(collection)}
                    key={collection.id}
                  >
                    <button
                      type="button"
                      className="detail-collection-option__open"
                      onClick={() => navigateTo({
                        tab: 'collections', gameId: null, collectionId: collection.id, formGameId: null,
                      })}
                      aria-label={`Открыть коллекцию «${collection.title}»`}
                    >
                      <div className="collection-card__mosaic">
                        {collectionGames.slice(0, 4).map((game) => <Cover game={game} compact smoothLoad key={game.id} />)}
                        {collectionGames.length === 0 && <div className="collection-card__empty">ПУСТО</div>}
                      </div>
                      <div className="collection-card__footer">
                        <div>
                          <strong>{collection.title}</strong>
                          <span>{collectionGames.length} {collectionGames.length === 1 ? 'игра' : 'игр'}</span>
                        </div>
                        <span className="collection-card__mark"><CollectionIcon collection={collection} /></span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={included ? 'detail-collection-option__toggle detail-collection-option__toggle--added' : 'detail-collection-option__toggle'}
                      aria-label={included ? `Убрать «${selectedGame.title}» из «${collection.title}»` : `Добавить «${selectedGame.title}» в «${collection.title}»`}
                      title={included ? 'Убрать из коллекции' : 'Добавить в коллекцию'}
                      aria-pressed={included}
                      onClick={() => toggleCollectionMembership(selectedGame, collection.id)}
                    >
                      <Icon name={included ? 'checkmark' : 'plus'} size={19} />
                    </button>
                  </motion.div>
                )
              })}
              </LayoutGroup>
            </div>
          </motion.section>
        )}
        </AnimatePresence>

        <section className="detail-hero">
          <div className={selectedGame.coverUrl ? 'detail-hero__cover detail-hero__cover--image' : 'detail-hero__cover'}>
            <Cover game={selectedGame} priority />
          </div>
          <div className="detail-hero__info">
            <h1>{selectedGame.title}</h1>
            <div className="detail-hero__metadata">
              <p className="detail-hero__genres">{selectedGame.genres.join(' · ') || 'Жанр не указан'}</p>
            </div>
            <div className="detail-external-links" aria-label="Ссылки на магазины и трейлер">
              {storeLinks.map((store) => (
                <a
                  key={store.provider}
                  className={`detail-external-link detail-external-link--${store.provider}`}
                  href={store.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={store.label}
                  aria-label={`Открыть ${store.label}`}
                >
                  <BrandIcon provider={store.provider} />
                </a>
              ))}
              {trailerUrl && (
                <a
                  className="detail-external-link detail-external-link--trailer"
                  href={trailerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Смотреть трейлер"
                  aria-label="Смотреть трейлер на YouTube"
                >
                  <BrandIcon provider="youtube" />
                </a>
              )}
              {loadingDetails && !gameDetails && storeLinks.length === 0 && !trailerUrl && (
                <span className="detail-external-links__loading" aria-label="Загружаем ссылки" />
              )}
              {!loadingDetails && storeLinks.length === 0 && !trailerUrl && (
                <span className="detail-external-links__empty">Ссылок пока нет</span>
              )}
            </div>
          </div>
        </section>

        <section className="detail-rating-section" aria-label="Рейтинги игры">
          <div className="detail-rating-panel detail-rating-panel--igdb" aria-label={hasIgdbRating ? `IGDB: ${igdbScore} из 100` : 'IGDB: нет рейтинга'}>
            <span className="detail-rating-panel__label">IGDB</span>
            {hasIgdbRating ? (
              <span className="detail-rating-panel__score">
                <strong>{igdbScore}</strong>
                <small>/ 100</small>
              </span>
            ) : (
              <span className="detail-rating-panel__score detail-rating-panel__score--empty">
                <span>Нет</span><span>рейтинга</span>
              </span>
            )}
          </div>
          <div className="detail-rating-panel detail-rating-panel--community" aria-label={hasRateAppRating ? `RateApp: ${rateAppScore} из 10` : 'RateApp: нет рейтинга'}>
            <span className="detail-rating-panel__label">RateApp</span>
            {hasRateAppRating ? (
              <span className="detail-rating-panel__score">
                <strong>{rateAppScore}</strong>
                <small>/ 10</small>
              </span>
            ) : (
              <span className="detail-rating-panel__score detail-rating-panel__score--empty">
                <span>Нет</span><span>рейтинга</span>
              </span>
            )}
          </div>
        </section>

        {selectedEntry && ratedStatuses.has(selectedEntry.status) && (
          <section className="criteria-card">
            <div className="criteria-card__header">
              <span className="eyebrow">МОЯ ОЦЕНКА</span>
              <strong>{selectedEntry.score?.toFixed(1) ?? '—'}</strong>
            </div>
            <div className="criteria-breakdown">
              <div><span><Icon name="sparkles" size={15} />Атмосфера</span><b>{selectedEntry.atmosphereScore?.toFixed(1) ?? '—'}</b></div>
              <div><span><Icon name="book" size={15} />Сюжет</span><b>{selectedEntry.storyScore?.toFixed(1) ?? '—'}</b></div>
              <div><span><Icon name="cpu" size={15} />Технологичность</span><b>{selectedEntry.technologyScore?.toFixed(1) ?? '—'}</b></div>
              <div><span><Icon name="gamepad" size={15} />Геймплей</span><b>{selectedEntry.gameplayScore?.toFixed(1) ?? '—'}</b></div>
            </div>
          </section>
        )}

        {isPlaythrough(selectedEntry) && (
          <section className="info-card">
            <span className="eyebrow detail-section-eyebrow">МОЁ ПРОХОЖДЕНИЕ</span>
            <div className="info-list">
              <div><span><Icon name="gamepad" size={17} />Платформа</span><strong>{selectedEntry.platform ?? 'Не указана'}</strong></div>
              <div>
                <span><Icon name="calendar" size={17} />{selectedEntry.status === 'dropped' ? 'Дата дропа' : selectedEntry.status === 'playing' ? 'Дата начала' : 'Дата прохождения'}</span>
                <strong>{selectedEntry.status === 'playing' ? formatDate(selectedEntry.startedAt) || '—' : formatDate(selectedEntry.completedAt) || '—'}</strong>
              </div>
            </div>
            {selectedEntry.review && (
              <div className="review-box">
                <span>Мой отзыв</span>
                <p>{selectedEntry.review}</p>
              </div>
            )}
          </section>
        )}

        <section className="info-card">
          <span className="eyebrow detail-section-eyebrow">ОБ ИГРЕ</span>
          <div className="info-list">
            <div><span><Icon name="clock" size={17} />Продолжительность</span><strong>{formatPlaytime(gameDetails, loadingDetails)}</strong></div>
            <div><span><Icon name="calendar" size={17} />Дата выхода</span><strong>{formatDate(selectedGame.releaseDate) || selectedGame.year || '—'}</strong></div>
            <div><span><Icon name="gamepad" size={17} />Платформы</span><strong>{selectedGame.platforms.join(', ') || '—'}</strong></div>
            <div><span><Icon name="cpu" size={17} />Разработчик</span><strong>{selectedGame.developer || '—'}</strong></div>
          </div>
        </section>

        <section className="info-card detail-similar" aria-label="Похожие игры">
          <span className="eyebrow detail-section-eyebrow">ПОХОЖИЕ</span>
          {similarGamesById[selectedGame.id] === undefined && (
            <p className="detail-similar__empty">Подбираем похожие игры…</p>
          )}
          {similarGamesById[selectedGame.id]?.length === 0 && (
            <p className="detail-similar__empty">Похожих игр пока нет в каталоге.</p>
          )}
          {(similarGamesById[selectedGame.id]?.length ?? 0) > 0 && (
            <div className="detail-similar__track" role="list" aria-label="Карусель похожих игр">
              {similarGamesById[selectedGame.id].map(game => (
                <div key={game.id} role="listitem" className="detail-similar__item">
                  <button type="button" className="detail-similar__game"
                    aria-label={'Открыть похожую игру ' + game.title}
                    onClick={() => openGame(game.id)}>
                    <div className="detail-similar__cover"><Cover game={game} compact /></div>
                    <span>{game.title}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <AnimatePresence>
          {wishlistToastGameId === selectedGame.id && (
            <motion.div key={selectedGame.id} className="detail-wishlist-toast" role="status"
              initial={{ opacity: 0, y: 35, scale: .87 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -85, scale: .93 }}
              transition={{ duration: .45, ease: 'easeOut' }}>
              <Icon name="heart" size={21} />
              Добавлено в «Хочу пройти»
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  const renderLibrary = () => (
    <LayoutGroup id="library-motion">
      <div
        className={
          libraryControlsCollapsed
            ? 'library-sticky-stack library-sticky-stack--collapsed'
            : 'library-sticky-stack'
        }
      >
      <header className="topbar library-topbar">
        <motion.button
          layout
          className="library-title"
          onClick={() => resetTab('library')}
          aria-label="Обновить страницу «Мои игры»"
          title="Сбросить и обновить страницу"
          whileTap={shouldReduceMotion ? undefined : { scale: .985 }}
          transition={{ type: 'spring', stiffness: 480, damping: 34 }}
        >
          Мои игры
        </motion.button>

        <motion.div className="topbar-actions" layout>
          <motion.button
            className={librarySearchOpen || query ? 'icon-button library-search-trigger library-search-trigger--active' : 'icon-button library-search-trigger'}
            onClick={() => {
              if (librarySearchOpen) {
                focusLibrarySearchOnOpen.current = false
                librarySearchInputRef.current?.blur()
                setLibrarySearchOpen(false)
                setQuery('')
              } else {
                focusLibrarySearchOnOpen.current = true
                setLibrarySearchOpen(true)
              }
            }}
            aria-label={librarySearchOpen ? 'Свернуть поиск' : 'Открыть поиск'}
            aria-expanded={librarySearchOpen}
            whileTap={shouldReduceMotion ? undefined : { scale: .9 }}
            transition={{ type: 'spring', stiffness: 520, damping: 36, mass: .7 }}
          >
            <Icon name="search" size={19} />
          </motion.button>
          <motion.button
            layout
            className="round-add"
            onClick={() => openTab('add')}
            aria-label="Добавить игру"
            whileTap={shouldReduceMotion ? undefined : { scale: .9, rotate: 8 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30 }}
          >
            <Icon name="plus" size={20} />
          </motion.button>
        </motion.div>
      </header>

      <AnimatePresence initial={false}>
        {librarySearchOpen && (
          <motion.div
            key="library-search-panel"
            className="library-search-motion-wrap"
            initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: .2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="search-wrap library-search">
              <Icon name="search" size={19} />
              <input
                ref={librarySearchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={100}
                placeholder="Название, жанр или разработчик..."
                enterKeyHint="search"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                }}
                aria-label="Поиск в библиотеке"
              />
              {query && (
                <motion.button
                  className="library-search__clear"
                  onClick={() => {
                    setQuery('')
                    librarySearchInputRef.current?.focus()
                  }}
                  aria-label="Очистить поиск"
                  whileTap={shouldReduceMotion ? undefined : { scale: .88 }}
                >
                  <Icon name="x" size={15} />
                </motion.button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="library-control-dock">
        <motion.div
          className="library-control-clip"
          style={{
            // Render the real content before its first positive measurement;
            // otherwise the zero-initialised MotionValue hides it at startup.
            height: libraryControlsMeasured ? libraryControlClipHeight : 'auto',
            opacity: shouldReduceMotion || !libraryControlsMeasured ? 1 : libraryControlClipOpacity,
          }}
        >
          <div ref={measureLibraryControls} className="library-control-content">

      <motion.section
        className="library-overview"
        aria-label="Сводка библиотеки"
        initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: .24 }}
      >
        <motion.div
          className="library-overview-card library-overview-card--games"
          initial={shouldReduceMotion ? false : { opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30, delay: .03 }}
        >
          <span className="library-overview-card__icon"><Icon name="gamepad" size={20} /></span>
          <span>
            <small>Всего игр</small>
            <strong>{personalLibraryEntries.length}</strong>
          </span>
        </motion.div>
        <motion.div
          className="library-overview-card library-overview-card--score"
          initial={shouldReduceMotion ? false : { opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30, delay: .07 }}
        >
          <span className="library-overview-card__icon"><Icon name="star" size={19} /></span>
          <span>
            <small>Средняя оценка</small>
            <strong>{averageLibraryScore != null ? averageLibraryScore.toFixed(1) : '—'}</strong>
          </span>
        </motion.div>
      </motion.section>

      <motion.section
        className="library-summary"
        aria-label="Фильтр по статусу"
        initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: .24, delay: .08 }}
      >
        {([
          ['completed', 'Пройдено'],
          ['playing', 'Прохожу'],
          ['dropped', 'Дропнуто'],
        ] as ['completed' | 'playing' | 'dropped', string][]).map(([status, label]) => (
          <motion.button
            layout
            key={status}
            className={
              statusFilters.includes(status)
                ? `library-status-card library-status-card--${status} library-status-card--active`
                : `library-status-card library-status-card--${status}`
            }
            onClick={() => toggleStatusFilter(status)}
            aria-pressed={statusFilters.includes(status)}
            whileHover={shouldReduceMotion ? undefined : { y: -2 }}
            whileTap={shouldReduceMotion ? undefined : { scale: .965 }}
            transition={{ type: 'spring', stiffness: 460, damping: 30 }}
          >
            <span className="library-status-card__label">{label}</span>
            <span className="library-status-card__count">{counts[status]}</span>
          </motion.button>
        ))}
      </motion.section>

      <motion.div
        className="library-controls"
        initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: .22, delay: .12 }}
      >
        <label className="library-sort">
          <Icon name="sort" size={17} />
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Сортировка">
            <option value="activity">Последняя активность</option>
            <option value="score-desc">Оценка: высокая → низкая</option>
            <option value="score-asc">Оценка: низкая → высокая</option>
            <option value="title">По названию</option>
          </select>
        </label>

        <button
          className={filtersOpen || activeExtraFilters > 0 ? 'library-filter-button library-filter-button--active' : 'library-filter-button'}
          aria-label="Фильтры библиотеки"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((current) => !current)}
        >
          <Icon name="filter" size={17} />
          <span>Фильтры</span>
          {activeExtraFilters > 0 && <b>{activeExtraFilters}</b>}
        </button>
      </motion.div>

      {filtersOpen && (
          <div className="library-filter-panel-clip">
            <section className="filter-panel library-filter-panel">
          <div className="filter-panel__header">
            <strong>Фильтры библиотеки</strong>
            <div className="filter-panel__actions">
              {activeExtraFilters > 0 && <button onClick={resetExtraFilters}>Сбросить</button>}
              <button onClick={() => setFiltersOpen(false)} aria-label="Закрыть фильтры">
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>

          <div className="filter-group">
            <span>Жанр</span>
            <div className="filter-options">
              <button
                className={genreFilter === 'all' ? 'filter-option filter-option--active' : 'filter-option'}
                onClick={() => setGenreFilter('all')}
              >
                Все
              </button>
              {availableGenres.map((genre) => (
                <button
                  key={genre}
                  className={genreFilter === genre ? 'filter-option filter-option--active' : 'filter-option'}
                  onClick={() => setGenreFilter(genre)}
                >
                  {genre}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span>Платформа</span>
            <div className="filter-options">
              <button
                className={platformFilter === 'all' ? 'filter-option filter-option--active' : 'filter-option'}
                onClick={() => setPlatformFilter('all')}
              >
                Все
              </button>
              {availablePlatforms.map((platform) => (
                <button
                  key={platform}
                  className={platformFilter === platform ? 'filter-option filter-option--active' : 'filter-option'}
                  onClick={() => setPlatformFilter(platform)}
                >
                  {platform}
                </button>
              ))}
            </div>
          </div>
            </section>
          </div>
        )}

          </div>
        </motion.div>

        <motion.button
          className="library-dock-toggle"
          aria-label={
            libraryControlsCollapsed
              ? 'Развернуть управление библиотекой'
              : 'Свернуть управление библиотекой'
          }
          onClick={() => {
            const currentProgress = libraryCollapseProgress.get()
            const generation = ++libraryToggleGenerationRef.current
            libraryToggleAnimationRef.current?.stop()
            libraryScrollSyncPausedRef.current = true

            const expanding = currentProgress >= .5
            if (expanding) {
              libraryForceCollapsedRef.current = false
              setLibraryControlsCollapsed(false)
            }

            const controls = animate(libraryCollapseProgress, expanding ? 0 : 1, {
              type: 'spring',
              stiffness: 210,
              damping: 30,
              mass: .9,
            })
            libraryToggleAnimationRef.current = controls

            void controls.then(() => {
              if (generation !== libraryToggleGenerationRef.current) return
              libraryToggleAnimationRef.current = null
              // Wait until the changing dock height has settled before
              // resuming scroll-driven updates.
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  if (generation !== libraryToggleGenerationRef.current) return

                  const currentY = Math.max(0, window.scrollY)
                  libraryScrollAnchorRef.current = Math.max(4, currentY)
                  libraryEntryAnchorActiveRef.current = expanding && currentY > 4
                  libraryLastScrollYRef.current = currentY
                  libraryForcedRevealStartRef.current = null
                  libraryTopLatchRef.current = expanding && currentY <= 4
                  libraryForceCollapsedRef.current = !expanding
                  libraryScrollSyncPausedRef.current = false
                })
              })
            })
          }}
          whileTap={shouldReduceMotion ? undefined : { scale: .96 }}
        >
          <motion.span
            className="library-dock-chevron"
            initial={false}
            animate={
              libraryControlsCollapsed
                ? { rotate: 45, y: 0, opacity: 1 }
                : { rotate: -135, y: 0, opacity: 1 }
            }
            transition={{
              rotate: { type: 'spring', stiffness: 320, damping: 28, mass: .65 },
              opacity: { duration: .12 },
              y: { duration: 0 },
            }}
            aria-hidden="true"
          />
        </motion.button>
      </div>
      </div>

      <section className="catalog">
        <AnimatePresence initial={false}>
          {query && (
            <motion.div
              className="section-heading library-section-heading"
              initial={shouldReduceMotion ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, y: -4 }}
            >
              <h2>Найдено: {libraryGames.length}</h2>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="popLayout">
          {libraryGames.length > 0 ? (
            <motion.div
              key="library-game-grid"
              className="game-grid"
              layout
              initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: .2, ease: [0.22, 1, 0.36, 1] }}
            >
              <AnimatePresence mode="popLayout">
                {libraryGames.map(({ game, entry }, index) => (
                  <GameCard
                    key={game.id}
                    game={game}
                    entry={entry}
                    onOpen={() => openGame(game.id)}
                    animationIndex={index}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          ) : (
            <motion.div
              key="library-empty-state"
              className="empty-state"
              initial={shouldReduceMotion ? false : { opacity: 0, y: 8, scale: .98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8, scale: .98 }}
              transition={{ duration: .18 }}
            >
              <strong>Здесь пока пусто</strong>
              <p>Смени фильтр или добавь новую игру в библиотеку.</p>
              <button onClick={() => openTab('add')}>Добавить игру</button>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </LayoutGroup>
  )

  const renderAdd = () => {
    const addGame = addGameId ? catalogGameById.get(addGameId!) : undefined
    const entryForGame = addGame ? entryMap.get(addGame.id) : undefined
    const editingEntry = isPlaythrough(entryForGame) ? entryForGame : undefined

    if (addGame) {
      return (
        <>
          <header className="subpage-header">
            <button className="icon-button" onClick={() => goBackOr({ tab: 'add', gameId: null, collectionId: null, formGameId: null })}><Icon name="back" size={20} /></button>
            <div>
              <h1>Прохождение</h1>
            </div>
          </header>

          <section className="add-selected">
            <div className="add-selected__cover"><Cover game={addGame} compact /></div>
            <div>
              <strong>{addGame.title}</strong>
              <span>{addGame.year} · {addGame.genres.join(' · ')}</span>
            </div>
          </section>

          <section className="form-card">
            <label className="field-label">Статус</label>
            <div className="choice-grid" role="group" aria-label="Статус прохождения">
              {(['completed', 'playing', 'dropped'] as LibraryStatus[]).map((status) => (
                <motion.button
                  type="button"
                  key={status}
                  className={`choice-button choice-button--${status}${addStatus === status ? ' choice-button--active' : ''}`}
                  aria-pressed={addStatus === status}
                  whileTap={shouldReduceMotion ? undefined : { scale: .95 }}
                  transition={{ type: 'spring', stiffness: 440, damping: 28 }}
                  onClick={() => setAddStatus(status)}
                >
                  <Icon name={statusIcons[status]} size={17} />
                  <span>{statusMeta[status].label}</span>
                </motion.button>
              ))}
            </div>

            <label className="form-field">
              <span>Платформа</span>
              {addGame.platforms.length > 0 ? (
                <select value={addPlatform} onChange={(event) => setAddPlatform(event.target.value)}>
                  <option value="" disabled>Выберите платформу</option>
                  {addPlatform && !addGame.platforms.includes(addPlatform) && (
                    <option value={addPlatform}>{addPlatform} (из сохранённого прохождения)</option>
                  )}
                  {addGame.platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  maxLength={80}
                  value={addPlatform}
                  placeholder="Укажите платформу"
                  onChange={(event) => setAddPlatform(event.target.value)}
                />
              )}
            </label>

            {ratedStatuses.has(addStatus) && (
              <label className="form-field">
                <span>{addStatus === 'dropped' ? 'Дата дропа' : 'Дата прохождения'}</span>
                <input type="date" value={addDate} onChange={(event) => setAddDate(event.target.value)} />
                <small>По умолчанию — сегодня. Можно указать любую прошлую дату.</small>
              </label>
            )}

            <AnimatePresence initial={false}>
              {ratedStatuses.has(addStatus) && (
                <motion.div
                  key="playthrough-rating"
                  initial={shouldReduceMotion ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={shouldReduceMotion ? undefined : { opacity: 0, height: 0 }}
                  transition={{ duration: .26, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="rating-builder">
                    <div className="rating-builder__summary">
                      <span>Итоговая оценка</span>
                      <strong>{calculatedAddScore.toFixed(1)}</strong>
                      <small>среднее четырёх критериев</small>
                    </div>
                    <div className="rating-builder__wheels">
                      <RatingWheel label="Атмосфера" value={addAtmosphereScore} onChange={setAddAtmosphereScore} />
                      <RatingWheel label="Сюжет" value={addStoryScore} onChange={setAddStoryScore} />
                      <RatingWheel label="Технологичность" value={addTechnologyScore} onChange={setAddTechnologyScore} />
                      <RatingWheel label="Геймплей" value={addGameplayScore} onChange={setAddGameplayScore} />
                    </div>
                  </div>

                  <div className="review-editor">
                    <motion.button
                      type="button"
                      className="review-editor__trigger"
                      aria-expanded={addReviewOpen}
                      aria-controls="playthrough-review-content"
                      whileTap={shouldReduceMotion ? undefined : { scale: .99 }}
                      onClick={() => setAddReviewOpen((open) => !open)}
                    >
                      <span>
                        <strong>{addReview ? 'Мой отзыв' : 'Добавить отзыв'}</strong>
                        <small>необязательно</small>
                      </span>
                      <motion.b
                        animate={{ rotate: addReviewOpen ? 45 : 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                        aria-hidden="true"
                      >+</motion.b>
                    </motion.button>
                    <AnimatePresence initial={false}>
                      {addReviewOpen && (
                        <motion.div
                          key="review-fields"
                          id="playthrough-review-content"
                          className="review-editor__content"
                          initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
                          transition={{ duration: .3, ease: [0.22, 1, 0.36, 1] }}
                        >
                          <textarea
                            aria-label="Текст отзыва"
                            value={addReview}
                            onChange={(event) => setAddReview(event.target.value)}
                            maxLength={5000}
                            placeholder="Что запомнилось, что понравилось или не понравилось?"
                            rows={5}
                          />
                          <small className="review-editor__counter">{addReview.length}/5000</small>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <button className="primary-button" onClick={saveGame}>
              {editingEntry ? 'Сохранить изменения' : 'Сохранить в библиотеку'}
            </button>
            {editingEntry && (
              <button className="danger-button danger-button--inside" onClick={() => { setDeleteCollectionError(''); setDeleteGamePrompt(addGame) }}>
                Удалить из моих игр
              </button>
            )}
          </section>
        </>
      )
    }

    return (
      <>
        <header className="topbar game-database-heading">
          <div className="game-database-heading__row">
            <h1>База игр</h1>
            <p className="game-database-powered">powered by <strong>IGDB</strong></p>
          </div>
        </header>

        <p className="game-database-input-hint">Введи хотя бы 3 символа для поиска</p>
        <div className="search-wrap game-database-search">
          <Icon name="search" size={20} />
          <input
            ref={addSearchInputRef}
            value={addQuery}
            onChange={(event) => setAddQuery(event.target.value)}
            maxLength={100}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
            enterKeyHint="search"
            placeholder="Название игры..."
            aria-label="Поиск по базе игр"
          />
          {addQuery.length > 0 && (
            <button
              type="button"
              className="game-database-search__clear"
              aria-label="Очистить поиск"
              title="Очистить поле поиска"
              onClick={() => {
                setAddQuery('')
                addSearchInputRef.current?.focus()
              }}
            >
              <Icon name="x" size={15} />
            </button>
          )}
        </div>

        <section className="search-results">
          {addResults.map((game, index) => (
            <button
              type="button"
              className="search-result search-result--open"
              key={game.id}
              onClick={() => openGame(game.id)}
              aria-label={`Открыть игру «${game.title}»`}
            >
              <div className="search-result__cover">
                <Cover game={game} compact thumbnail priority={index < 6} />
              </div>
              <div className="search-result__copy">
                <strong>{game.title}</strong>
                <span>{game.year || 'Год не указан'} · {game.genres.slice(0, 2).join(' · ') || 'Жанр не указан'}</span>
                <small>{game.platforms.join(' · ')}</small>
              </div>
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </section>

        {addSearchHasMore && !addSearchError && <div ref={addSearchSentinelRef} className="game-database-sentinel" aria-hidden="true" />}

        {addSearchLoading && (
          <div className="game-database-loading" role="status">
            <span className="game-database-loading__spinner" aria-hidden="true" />
            {addSearchSource === 'igdb' ? 'Подгружаем игры из IGDB…' : 'Ищем в базе игр…'}
          </div>
        )}

        {addSearchError && (
          <div className="game-database-error" role="alert">
            <span>{addSearchError}</span>
            <button type="button" onClick={retrySearch}>Повторить</button>
          </div>
        )}

        {addQuery.trim().length >= 3 && !addSearchLoading && !addSearchError && !addSearchHasMore && addSearchSource === 'igdb' && addResults.length === 0 && (
          <p className="game-database-empty">По этому запросу игр не нашлось. Попробуй другое название.</p>
        )}

        <AnimatePresence initial={false}>
          {addQuery.trim().length >= 3 && !addSearchLoading && !addSearchError && !addSearchHasMore && addSearchSource === 'local' && (
            <motion.button
              key="igdb-deep-search"
              type="button"
              className="game-database-deep-search"
              onClick={searchIgdb}
              initial={shouldReduceMotion ? false : { opacity: 0, y: 12, scale: .97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, y: -6, scale: .98 }}
              transition={{ type: 'spring', stiffness: 330, damping: 27 }}
              whileTap={shouldReduceMotion ? undefined : { scale: .975 }}
            >
              <span className="game-database-deep-search__text">
                <strong>Не нашёл нужную игру?</strong>
                <small>Попробуй более глубокий поиск по всей базе IGDB.</small>
              </span>
              <span className="game-database-deep-search__action">
                Поиск в IGDB <Icon name="arrow" size={15} />
              </span>
            </motion.button>
          )}
        </AnimatePresence>
      </>
    )
  }

  const renderCollections = () => {
    if (selectedCollectionId === 'new') {
      return (
        <div className="collection-create-screen">
          <header className="subpage-header">
            <button
              type="button"
              className="icon-button"
              aria-label="Вернуться к коллекциям"
              onClick={() => goBackOr({ tab: 'collections', gameId: null, collectionId: null, formGameId: null })}
            >
              <Icon name="back" size={20} />
            </button>
            <div><h1>Новая коллекция</h1></div>
          </header>

          <section className="collection-create-card collection-create-card--page">
            <label className="collection-create-field">
              <span>Название</span>
              <input
                value={collectionTitle}
                onChange={(event) => setCollectionTitle(event.target.value)}
                maxLength={COLLECTION_TITLE_LIMIT}
                placeholder="Например, Лучшие RPG"
                autoFocus
              />
            </label>
            <label className="collection-create-field">
              <span>Описание <small>необязательно</small></span>
              <textarea
                value={collectionDescription}
                onChange={(event) => setCollectionDescription(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Коротко о том, что здесь собрано"
              />
            </label>
            <CollectionAppearanceEditor
              colorScheme={collectionColorScheme}
              emoji={collectionEmoji}
              onColorChange={setCollectionColorScheme}
              onEmojiChange={setCollectionEmoji}
            />
            {collectionError && <p className="collection-create-error" role="alert">{collectionError}</p>}
            <button
              className="primary-button collection-create-submit"
              onClick={() => { void createCollection() }}
              disabled={!collectionTitle.trim() || collectionSaving}
            >
              {collectionSaving ? 'Создаём…' : 'Создать коллекцию'}
            </button>
          </section>
        </div>
      )
    }

    if (selectedCollectionId) {
      const collection = collections.find((item) => item.id === selectedCollectionId)
      if (!collection) return null
      const editing = editingCollectionId === collection.id
      const draftCollection = editing && !collection.isSystem
        ? { ...collection, title: editCollectionTitle, description: editCollectionDescription, colorScheme: editCollectionColor, emoji: editCollectionEmoji, iconData: null }
        : collection
      const collectionEntries = entries.filter((entry) =>
        entry.collectionIds.includes(collection.id) && (!editing || !removedCollectionGameIds.includes(entry.gameId)),
      )
      const sortedCollectionEntries = collectionEntries.flatMap((entry) => {
        const game = catalogGameById.get(entry.gameId)
        return game ? [{ entry, game }] : []
      }).sort((a, b) => {
        const addedA = a.entry.collectionAddedAt?.[collection.id] ?? a.entry.addedAt
        const addedB = b.entry.collectionAddedAt?.[collection.id] ?? b.entry.addedAt
        const compareNames = () => a.game.title.localeCompare(b.game.title, 'ru', { sensitivity: 'base' })
        let result: number
        switch (collectionSortMode) {
          case 'added-asc': result = addedA.localeCompare(addedB); break
          case 'release-desc': result = (b.game.releaseDate || '').localeCompare(a.game.releaseDate || ''); break
          case 'release-asc': result = (a.game.releaseDate || '9999').localeCompare(b.game.releaseDate || '9999'); break
          case 'title-asc': result = compareNames(); break
          case 'title-desc': result = -compareNames(); break
          case 'igdb-desc': result = (b.game.igdbRating || -1) - (a.game.igdbRating || -1); break
          case 'igdb-asc': result = (a.game.igdbRating || 999) - (b.game.igdbRating || 999); break
          default: result = addedB.localeCompare(addedA)
        }
        return result || compareNames() || a.game.id - b.game.id
      })

      return (
        <div className="collection-detail-page">
          <header className="detail-toolbar collection-detail-toolbar">
            <button
              type="button"
              className="icon-button detail-back"
              aria-label="Вернуться к коллекциям"
              onClick={() => {
                if (editing) cancelCollectionEdit()
                goBackOr({ tab: 'collections', gameId: null, collectionId: null, formGameId: null })
              }}
            >
              <Icon name="back" size={20} />
            </button>
            <div className="collection-detail-toolbar__identity" style={collectionThemeStyle(draftCollection)}>
              <span className="collection-detail-toolbar__avatar" aria-hidden="true">
                <CollectionIcon collection={draftCollection} size={22} />
              </span>
              {editing && !collection.isSystem ? (
                <input
                  className="collection-detail-toolbar__title-input"
                  aria-label="Название коллекции"
                  value={editCollectionTitle}
                  onChange={(event) => setEditCollectionTitle(event.target.value)}
                  maxLength={COLLECTION_TITLE_LIMIT}
                  placeholder="Название"
                />
              ) : (
                <h1 className="collection-detail-toolbar__title">{collection.title}</h1>
              )}
            </div>
            <div className="detail-toolbar__actions">
              {!editing && selectedCollectionGameIds.length > 0 ? (
                <>
                  <button type="button" className="icon-button"
                    aria-label="Отменить выбор игр"
                    onClick={() => {
                      setSelectedCollectionGameIds([])
                      cancelCollectionGameHold()
                    }}><Icon name="close" size={20} /></button>
                  <button type="button" className="icon-button detail-delete"
                    aria-label={`Убрать выбранные игры из коллекции: ${selectedCollectionGameIds.length}`}
                    onClick={() => {
                      setDeleteCollectionError('')
                      setBulkRemoveGamesPrompt({
                        collectionId: collection.id,
                        gameIds: [...selectedCollectionGameIds],
                      })
                    }}><Icon name="trash" size={20} /></button>
                </>
              ) : editing ? (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Отменить редактирование"
                    title="Отменить"
                    disabled={collectionEditBusy}
                    onClick={cancelCollectionEdit}
                  ><Icon name="close" size={19} /></button>
                  <motion.button
                    type="button"
                    className="round-add collection-edit-save"
                    aria-label="Сохранить изменения"
                    title="Сохранить"
                    disabled={collectionEditBusy || (collection.isSystem ? removedCollectionGameIds.length === 0 : !editCollectionTitle.trim())}
                    whileTap={shouldReduceMotion ? undefined : { scale: .93 }}
                    onClick={() => { void saveCollectionEdit(collection) }}
                  ><Icon name="check" size={21} /></motion.button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="icon-button detail-edit"
                    title="Редактировать коллекцию"
                    aria-label="Редактировать коллекцию"
                    onClick={() => startCollectionEdit(collection)}
                  ><Icon name="edit" size={19} /></button>
                  {!collection.isSystem && (
                    <button
                      type="button"
                      className="icon-button detail-delete"
                      title="Удалить коллекцию"
                      aria-label="Удалить коллекцию"
                      onClick={() => {
                        setDeleteCollectionError('')
                        setDeleteCollectionPrompt(collection)
                      }}
                    ><Icon name="trash" size={19} /></button>
                  )}
                </>
              )}
            </div>
          </header>

          <section
            className={editing && !collection.isSystem ? 'collection-detail-hero collection-detail-hero--editing' : 'collection-detail-hero'}
            style={collectionThemeStyle(draftCollection)}
          >
            {editing && !collection.isSystem ? (
              <>
                <label className="collection-create-field">
                  <span>Описание</span>
                  <textarea
                    value={editCollectionDescription}
                    maxLength={500}
                    rows={2}
                    placeholder="Добавь описание коллекции"
                    onChange={(event) => setEditCollectionDescription(event.target.value)}
                  />
                </label>
                <CollectionAppearanceEditor
                  colorScheme={editCollectionColor}
                  emoji={editCollectionEmoji}
                  onColorChange={setEditCollectionColor}
                  onEmojiChange={setEditCollectionEmoji}
                  fallbackIcon={collection.id === WISHLIST_COLLECTION_ID ? 'heart' : 'layers'}
                />
              </>
            ) : (
              <div className="collection-detail-overview">
                <div className="collection-detail-overview__text">
                  {collection.description && (
                    <p className="collection-detail-description">
                      {collection.id === WISHLIST_COLLECTION_ID
                        ? collection.description.trim().replace(/\.\s*$/, '')
                        : collection.description}
                    </p>
                  )}
                  <span className="collection-detail-count">
                    {collectionEntries.length} {collectionEntries.length === 1 ? 'игра' : 'игр'}
                  </span>
                  {selectedCollectionGameIds.length > 0 && (
                    <span className="collection-detail-selected-count" role="status">
                      Выбрано: {selectedCollectionGameIds.length}
                    </span>
                  )}
                </div>
                <label className="collection-detail-sort">
                  <Icon name="sort" size={19} />
                  <select
                    value={collectionSortMode}
                    onChange={(event) => setCollectionSortMode(event.target.value as CollectionSortMode)}
                    aria-label="Сортировка игр в коллекции"
                  >
                    <option value="added-desc">Добавлены: новые → старые</option>
                    <option value="added-asc">Добавлены: старые → новые</option>
                    <option value="release-desc">Релиз: новые → старые</option>
                    <option value="release-asc">Релиз: старые → новые</option>
                    <option value="title-asc">Название: А → Я</option>
                    <option value="title-desc">Название: Я → А</option>
                    <option value="igdb-desc">IGDB: высокий → низкий</option>
                    <option value="igdb-asc">IGDB: низкий → высокий</option>
                  </select>
                </label>
              </div>
            )}
          </section>

          {editing && (
            <div className="collection-edit-hint">
              <span>Нажми <b>×</b> на игре, чтобы убрать её из коллекции. Данные прохождения сохранятся.</span>
              {removedCollectionGameIds.length > 0 && (
                <button type="button" onClick={() => setRemovedCollectionGameIds([])}>
                  Вернуть удалённые ({removedCollectionGameIds.length})
                </button>
              )}
            </div>
          )}
          {collectionEditError && <p className="collection-create-error" role="alert">{collectionEditError}</p>}
          {collectionEntries.length ? (
            <div className="game-grid collection-edit-grid">
              {sortedCollectionEntries.map(({ entry, game }) => (
                  <div className={editing ? 'collection-edit-game collection-edit-game--active' : 'collection-edit-game'} key={game.id}>
                    <GameCard
                      game={game}
                      entry={entry}
                      readOnly={editing}
                      quietPress
                      selectionMode={!editing && selectedCollectionGameIds.length > 0}
                      selected={selectedCollectionGameIds.includes(game.id)}
                      onPointerDown={(event) => holdCollectionGame(game.id, event)}
                      onPointerMove={moveCollectionGameHold}
                      onPointerUp={cancelCollectionGameHold}
                      onPointerCancel={cancelCollectionGameHold}
                      onPointerLeave={cancelCollectionGameHold}
                      onContextMenu={(event) => {
                        if (editing) return
                        event.preventDefault()
                        cancelCollectionGameHold()
                        if (!selectedCollectionGameIds.length) setSelectedCollectionGameIds([game.id])
                      }}
                      onOpen={(event) => {
                        if (editing) return
                        const blocked = suppressCollectionGameClickRef.current
                        if (blocked?.gameId === game.id && Date.now() - blocked.time < 800) {
                          suppressCollectionGameClickRef.current = null
                          return
                        }
                        suppressCollectionGameClickRef.current = null
                        if (selectedCollectionGameIds.length) toggleCollectionGameSelection(game.id)
                        else if (event.shiftKey) setSelectedCollectionGameIds([game.id])
                        else openGame(game.id)
                      }}
                    />
                    {editing && (
                      <motion.button
                        type="button"
                        className="collection-edit-game__remove"
                        aria-label={`Убрать «${game.title}» из коллекции`}
                        title="Убрать из коллекции"
                        whileTap={shouldReduceMotion ? undefined : { scale: .9 }}
                        onClick={() => setRemovedCollectionGameIds((current) => [...current, game.id])}
                        disabled={collectionEditBusy}
                      ><Icon name="close" size={18} /></motion.button>
                    )}
                  </div>
              ))}
            </div>
          ) : (
            <div className="empty-state collection-empty-state">
              <strong>ПУСТО</strong>
              <p>{editing ? 'Все игры убраны из черновика. Сохрани изменения галочкой.' : 'В коллекции пока нет игр.'}</p>
            </div>
          )}
        </div>
      )
    }

    return (
      <>
        <header className="topbar collection-list-topbar">
          <div>
            <h1>Коллекции</h1>
            {selectedCollectionIds.length > 0 && (
              <span className="collection-selection-count">Выбрано: {selectedCollectionIds.length}</span>
            )}
          </div>
          {selectedCollectionIds.length > 0 ? (
            <div className="collection-list-actions">
              <button type="button" className="icon-button" aria-label="Отменить выбор коллекций"
                onClick={() => setSelectedCollectionIds([])}><Icon name="close" size={20} /></button>
              <button type="button" className="icon-button detail-delete"
                aria-label={'Удалить выбранные коллекции: ' + selectedCollectionIds.length}
                onClick={() => {
                  setDeleteCollectionError('')
                  setBulkDeleteCollectionPrompt([...selectedCollectionIds])
                }}><Icon name="trash" size={20} /></button>
            </div>
          ) : (
            <button className="round-add" aria-label="Создать коллекцию" onClick={openCollectionCreator}>
              <Icon name="plus" size={20} />
            </button>
          )}
        </header>
        {collections.length === 0 && (
          <div className="empty-state collection-empty-state">
            <strong>Коллекций пока нет</strong>
            <p>Создай первую коллекцию.</p>
            <button onClick={openCollectionCreator}>Создать коллекцию</button>
          </div>
        )}
        <section className="collection-grid">
          {sortedCollections.map((collection) => {
            const items = collectionGamesById.get(collection.id) ?? []
            return (
              <motion.button
                className={selectedCollectionIds.includes(collection.id)
                  ? 'collection-card collection-card--selected'
                  : selectedCollectionIds.length ? 'collection-card collection-card--selection-mode' : 'collection-card'}
                key={collection.id}
                layout="position"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 25, scale: .965 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  layout: { type: 'spring', stiffness: 380, damping: 32 },
                  opacity: { duration: .3, delay: Math.min(sortedCollections.findIndex((item) => item.id === collection.id), 12) * .055 },
                  y: { type: 'spring', stiffness: 320, damping: 30, delay: Math.min(sortedCollections.findIndex((item) => item.id === collection.id), 12) * .055 },
                  scale: { type: 'spring', stiffness: 320, damping: 30, delay: Math.min(sortedCollections.findIndex((item) => item.id === collection.id), 12) * .055 },
                }}
                style={collectionThemeStyle(collection)}
                aria-pressed={selectedCollectionIds.length > 0 ? selectedCollectionIds.includes(collection.id) : undefined}
                aria-label={selectedCollectionIds.length
                  ? collection.title + (collection.isSystem ? ', системная, нельзя удалить' : ', выбрать для удаления')
                  : collection.title}
                onPointerDown={(event) => holdCollection(collection, event)}
                onPointerMove={moveCollectionHold}
                onPointerUp={cancelCollectionHold}
                onPointerCancel={cancelCollectionHold}
                onPointerLeave={cancelCollectionHold}
                onContextMenu={(event) => {
                  if (collection.isSystem) return
                  event.preventDefault()
                  cancelCollectionHold()
                  if (selectedCollectionIds.length === 0) setSelectedCollectionIds([collection.id])
                }}
                onClick={() => {
                  const blocked = suppressCollectionClickRef.current
                  if (blocked?.id === collection.id && Date.now() - blocked.time < 800) {
                    suppressCollectionClickRef.current = null
                    return
                  }
                  suppressCollectionClickRef.current = null
                  if (selectedCollectionIds.length) toggleCollectionSelection(collection)
                  else navigateTo({ tab: 'collections', gameId: null, collectionId: collection.id, formGameId: null })
                }}
              >
                {selectedCollectionIds.length > 0 && !collection.isSystem && (
                  <span className={selectedCollectionIds.includes(collection.id)
                    ? 'collection-card__selection collection-card__selection--checked'
                    : 'collection-card__selection'} aria-hidden="true">
                    {selectedCollectionIds.includes(collection.id) && <Icon name="check" size={16} />}
                  </span>
                )}
                <div className="collection-card__mosaic">
                  {items.slice(0, 4).map((game) => <Cover game={game} compact key={game.id} />)}
                  {items.length === 0 && <div className="collection-card__empty">ПУСТО</div>}
                </div>
                <div className="collection-card__footer">
                  <div>
                    <strong>{collection.title}</strong>
                    <span>{items.length} {items.length === 1 ? 'игра' : 'игр'}</span>
                  </div>
                  <span className="collection-card__mark"><CollectionIcon collection={collection} /></span>
                </div>
              </motion.button>
            )
          })}
        </section>
      </>
    )
  }

  const renderProfile = () => (
    <Suspense fallback={<div className="profile-loading">Загружаем профиль…</div>}>
    <ProfileView
      user={authUser!}
      onOpenWishlist={() => navigateTo({
        tab: 'collections', gameId: null, collectionId: WISHLIST_COLLECTION_ID, formGameId: null,
      })}
      onLogout={async () => {
        try { await disconnectPushForLogout() } catch { /* Log out regardless of push API availability. */ }
        await sessionFetch('/api/auth/logout', { method: 'POST' })
        clearPushStateCache(authUser?.nickname ?? '')
        setAuthUser(null)
        setEntries([])
        setCollections([])
        navigateTo({ tab: 'library', gameId: null, collectionId: null, formGameId: null }, { replace: true })
      }}
    />
    </Suspense>
  )

  const nav: { id: Tab; label: string; icon: IconName }[] = [
    { id: 'library', label: 'Мои игры', icon: 'gamepad' },
    { id: 'add', label: 'База игр', icon: 'library' },
    { id: 'collections', label: 'Коллекции', icon: 'layers' },
    { id: 'profile', label: 'Профиль', icon: 'user' },
  ]

  if (!authReady) {
    return <LoadingScreen progress={loadingProgress} phase={loadingPhase} />
  }

  if (bootstrapError) {
    return (
      <main className="bootstrap-failure" role="alert">
        <div className="bootstrap-failure__body">
          <span className="bootstrap-failure__icon" aria-hidden="true">🎮</span>
          <h1>Сервер временно недоступен</h1>
          <p>Твои игры и коллекции сохранены. Ошибка соединения не означает выход из аккаунта.</p>
          <button type="button" onClick={() => {
            setBootstrapError(false)
            setAuthReady(false)
            setLoadingProgress(12)
            setLoadingPhase('loading')
            setBootstrapRetry((value) => value + 1)
          }}>Повторить попытку</button>
        </div>
      </main>
    )
  }

  if (!authUser) {
    return <AuthScreen sessionExpired={sessionExpired} onAuthenticated={(user) => { resetSessionExpired(); void hydrateAfterLogin(user) }} />;
  }

  return (
    <div className={activeTab !== 'library' || selectedGameId != null
      ? 'app-shell app-shell--viewport'
      : 'app-shell'}>
      <main
        ref={viewportPageRef}
        className={activeTab === 'library' && selectedGameId == null
          ? 'page page--library'
          : activeTab === 'discovery' && selectedGameId == null
            ? 'page page--viewport page--discovery'
            : 'page page--viewport'}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${keyForAppView(currentViewRef.current)}-${screenRevision}`}
            ref={restoreScreenPosition}
            className="page-motion"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: .18, ease: [0.22, 1, 0.36, 1] }}
          >
            {selectedGameId ? renderDetail() : (
              <>
                {activeTab === 'library' && renderLibrary()}
                {activeTab === 'add' && renderAdd()}
                {activeTab === 'discovery' && (
                  <Suspense fallback={<div className="game-database-loading">Загружаем рекомендации…</div>}>
                    <DiscoverView
                      nickname={authUser.nickname}
                      onAddPlaythrough={(game) => {
                        // Discovery feed may contain a game not in the current
                        // catalog subset. Register it before opening the form;
                        // no discovery feedback is saved on a downward swipe.
                        rememberCatalogResults([game])
                        startAdding(game)
                      }}
                      onWishlistChange={() => {
                        void sessionFetch('/api/bootstrap').then(response => response.ok ? response.json() : null)
                          .then((payload: BootstrapPayload | null) => {
                            if (!payload) return
                            setEntries(payload.library.map(normalizeEntry))
                            setCollections(payload.collections)
                            rememberCatalogResults(payload.library.flatMap(entry => entry.game ? [entry.game] : []))
                          }).catch(() => {})
                      }}
                    />
                  </Suspense>
                )}
                {activeTab === 'collections' && renderCollections()}
                {activeTab === 'links' && (
                  <Suspense fallback={<div className="game-database-loading">Загружаем ссылки…</div>}>
                    <SavedLinksView onOpenGame={openGame} cacheNamespace={String(authUser.id)} />
                  </Suspense>
                )}
                {activeTab === 'profile' && renderProfile()}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <PushOnboarding user={authUser.nickname} />

      {(deleteCollectionPrompt || deleteGamePrompt || bulkDeleteCollectionPrompt || bulkRemoveGamesPrompt) && (
        <div className="rateapp-confirm-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismissDeletePrompt()
        }}>
          <section
            className="rateapp-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-collection-dialog-title"
          >
            <span className="rateapp-confirm__brand">RateApp</span>
            <h2 id="delete-collection-dialog-title">
              {deleteGamePrompt
                ? <>Удалить прохождение «{deleteGamePrompt.title}» из моих игр?</>
                : bulkDeleteCollectionPrompt
                  ? <>Удалить выбранные коллекции ({bulkDeleteCollectionPrompt.length})?</>
                  : bulkRemoveGamesPrompt
                    ? <>Убрать выбранные игры ({bulkRemoveGamesPrompt.gameIds.length}) из коллекции?</>
                    : <>Удалить коллекцию «{deleteCollectionPrompt?.title}»?</>}
            </h2>
            {(bulkDeleteCollectionPrompt || bulkRemoveGamesPrompt) && (
              <p className="rateapp-confirm__description">
                {bulkRemoveGamesPrompt
                  ? 'Игры будут убраны только из этой коллекции. Другие коллекции, прохождения и оценки сохранятся.'
                  : 'Игры останутся в других коллекциях и в истории прохождений.'}
              </p>
            )}
            {deleteCollectionError && <p role="alert">{deleteCollectionError}</p>}
            <div className="rateapp-confirm__actions">
              <button
                ref={deleteCollectionCancelRef}
                type="button"
                disabled={deleteCollectionBusy}
                onClick={dismissDeletePrompt}
              >Отмена</button>
              <button
                type="button"
                className="rateapp-confirm__delete"
                disabled={deleteCollectionBusy}
                onClick={() => {
                  if (deleteGamePrompt) void deleteGame(deleteGamePrompt)
                  else if (bulkDeleteCollectionPrompt) void deleteSelectedCollections(bulkDeleteCollectionPrompt)
                  else if (bulkRemoveGamesPrompt) void removeSelectedCollectionGames(bulkRemoveGamesPrompt)
                  else if (deleteCollectionPrompt) void deleteCollection(deleteCollectionPrompt)
                }}
              >{deleteCollectionBusy ? 'Удаляем…' : 'Удалить'}</button>
            </div>
          </section>
        </div>
      )}

      {exitPromptVisible && (
        <div className="app-exit-toast" role="status" aria-live="assertive">
          Нажми или свайпни «Назад» повторно, чтобы выйти
        </div>
      )}
      <nav className="bottom-nav" aria-label="Основная навигация">
          {nav.map((item) => item.id === 'add' || item.id === 'collections' ? (
            <BottomNavGameSlot
              key={item.id}
              group={item.id === 'collections' ? 'collections' : 'games'}
              nickname={authUser.nickname}
              active={item.id === 'collections'
                ? activeTab === 'collections' || activeTab === 'links'
                : activeTab === 'add' || activeTab === 'discovery'}
              onNavigate={(tab) => {
                if (activeTab === tab) resetTab(tab)
                else openTab(tab)
              }}
            />
          ) : (
            <motion.button
              layout
              key={item.id}
              onClick={() => {
                if (activeTab === item.id) resetTab(item.id)
                else openTab(item.id)
              }}
              className={activeTab === item.id ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'}
              whileTap={shouldReduceMotion ? undefined : { scale: .92 }}
              transition={{ type: 'spring', stiffness: 500, damping: 34 }}
            >
              {activeTab === item.id && (
                <motion.span
                  className="bottom-nav__active-surface"
                  layoutId="bottom-nav-active-surface"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="bottom-nav__content">
                {item.id === 'profile' ? (
                  <span className="bottom-nav__avatar" aria-hidden="true">
                    {authUser.nickname.slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  <Icon name={item.icon} />
                )}
                <span>{item.label}</span>
              </span>
            </motion.button>
          ))}
      </nav>
    </div>
  )
}

export default App