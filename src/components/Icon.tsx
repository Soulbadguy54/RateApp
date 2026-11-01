import type { ReactNode } from 'react'

export type IconName =
  | 'library'
  | 'plus'
  | 'layers'
  | 'link'
  | 'external-link'
  | 'heart'
  | 'user'
  | 'search'
  | 'filter'
  | 'star'
  | 'arrow'
  | 'back'
  | 'calendar'
  | 'gamepad'
  | 'globe'
  | 'mail'
  | 'lock'
  | 'check'
  | 'play'
  | 'bookmark'
  | 'close'
  | 'x'
  | 'checkmark'
  | 'sort'
  | 'edit'
  | 'trash'
  | 'badge-new'
  | 'sparkles'
  | 'book'
  | 'cpu'
  | 'clock'
  | 'video'
  | 'download'
  | 'upload'
  | 'bell'
  | 'shield'
  | 'alert-triangle'
  | 'refresh'
  | 'chevron-left'
  | 'chevron-right'

export default function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }

  const paths: Record<IconName, ReactNode> = {
    library: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z"/><path d="M7 20V6a2 2 0 0 0-2-2"/><path d="M9 8h6M9 12h6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></>,
    'external-link': <><path d="M14 4h6v6M20 4l-9 9"/><path d="M20 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6"/></>,
    link: <><path d="M9 15l6-6"/><path d="M7 11l-2 2a4 4 0 0 0 6 6l2-2"/><path d="m17 13 2-2a4 4 0 0 0-6-6l-2 2"/></>,
    heart: <path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 3.5-6.3 8-6.3s7.2 2.1 8 6.3"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    filter: <><path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    back: <><path d="M19 12H5"/><path d="m10 17-5-5 5-5"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></>,
    gamepad: <><path d="M7 8h10a4 4 0 0 1 3.8 5.2l-1.4 4.2a2 2 0 0 1-3.2.9L14 16h-4l-2.2 2.3a2 2 0 0 1-3.2-.9l-1.4-4.2A4 4 0 0 1 7 8Z"/><path d="M8 11v4M6 13h4"/><circle cx="16.5" cy="12" r=".7" fill="currentColor"/><circle cx="18" cy="14" r=".7" fill="currentColor"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16.5 9"/></>,
    play: <><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8Z"/></>,
    bookmark: <path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-3.8L6 21V4.8Z"/>,
    close: <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>,
    x: <path d="M6 6l12 12M18 6 6 18"/>,
    checkmark: <path d="m5 12 4 4L19 6"/>,
    sort: <><path d="M8 6h11M8 12h8M8 18h5"/><path d="M4 4v16M2 18l2 2 2-2"/></>,
    edit: <><path d="M12 20h9"/><path d="m16.5 4.5 3 3L8 19H5v-3L16.5 4.5Z"/><path d="m15 6 3 3"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/></>,
    'badge-new': <><path d="M12 2.5 14.6 5l3.7-.2.8 3.5 3 2.2-1.7 3.2.7 3.5-3.7.9L15 21l-3-1.8L9 21l-2.4-2.9-3.7-.9.7-3.5-1.7-3.2 3-2.2.8-3.5 3.7.2L12 2.5Z"/></>,
    sparkles: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 17 .7 1.3L21 19l-1.3.7L19 21l-.7-1.3L17 19l1.3-.7L19 17Z"/></>,
    book: <><path d="M12 6c-2.3-1.6-5.3-1.9-9-1v14c3.7-.9 6.7-.6 9 1 2.3-1.6 5.3-1.9 9-1V5c-3.7-.9-6.7-.6-9 1Z"/><path d="M12 6v14"/></>,
    cpu: <><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></>,
    video: <><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="m10 9 5 3-5 3V9Z"/></>,
    'chevron-left': <path d="m15 6-6 6 6 6"/>,
    'chevron-right': <path d="m9 6 6 6-6 6"/>,
    'alert-triangle': <><path d="M10.2 4.3a2.1 2.1 0 0 1 3.6 0l8 14a2.1 2.1 0 0 1-1.8 3.2H4a2.1 2.1 0 0 1-1.8-3.2l8-14Z"/><path d="M12 9v5m0 3h.01"/></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.95-4"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.95 4"/><path d="M20 20v-4h-4"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 17v3h16v-3"/></>,
    upload: <><path d="M12 17V3m-5 5 5-5 5 5"/><path d="M4 17v3h16v-3"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    shield: <><path d="M12 2 20 5v6c0 5.4-3.2 8.7-8 11-4.8-2.3-8-5.6-8-11V5l8-3Z"/><path d="m9 12 2 2 4-4"/></>,
  }

  return <svg {...common}>{paths[name]}</svg>
}

