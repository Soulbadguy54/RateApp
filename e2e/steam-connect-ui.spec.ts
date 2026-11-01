import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rateapp-install-confirmed', 'yes'))
})

for (const connected of [false, true]) {
  test('Steam cloud ' + (connected ? 'linked' : 'unlinked') + ' opens expanding privacy dialog', async ({ page }) => {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      const body = path === '/api/bootstrap'
        ? { user: { id: 703, nickname: 'steam_qa', email: 'steam@example.test',
            avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
        : path === '/api/steam/connection'
          ? { connected, steamId64: connected ? '76561198012345678' : null }
          : path === '/api/steam/overview'
            ? { steamId64: '76561198012345678', configured: true,
                profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
                  profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
                gameCount: 10, canSync: true, redFlags: [], lastSyncedAt: null }
        : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto('/?tab=profile')
    const steam = page.getByRole('button', { name: connected ? 'Steam подключен, открыть настройки' : 'Подключить Steam' })
    await expect(steam).toBeVisible()
    const dot = steam.locator('.profile-steam-cloud__status')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveCSS('background-color', connected ? 'rgb(94, 241, 155)' : 'rgb(255, 92, 102)')
    if (connected) await expect(steam.locator('img')).toHaveCSS('filter', /invert\(1\)/)
    await steam.click({ force: true })
    const panel = page.getByRole('dialog', { name: connected ? 'Подключенный аккаунт Steam' : 'Подключение Steam' })
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-mode', 'compact')
    await expect(panel).toHaveCSS('scrollbar-width', 'none')
    await expect(page).toHaveURL(/tab=profile/)
    await expect(steam).toHaveCSS('pointer-events', 'auto')
    await expect(panel).toContainText(connected ? 'Игры синхронизируются только по вашему запросу.' : 'Привяжите Steam, чтобы импортировать библиотеку в Rate APP.')
    if (connected) {
      const profile = panel.getByRole('link', { name: 'Открыть профиль Steam' })
      await expect(profile).toHaveAttribute('href', 'https://steamcommunity.com/profiles/76561198012345678/')
      await expect(profile).toHaveAttribute('target', '_blank')
      await expect(profile.locator('svg')).toBeVisible()
      await expect(profile).toContainText('Steam QA')
      await expect(profile).toContainText('Steam ID: 76561198012345678')
      await expect(panel).not.toContainText('Игр доступно:')
      await expect(panel).not.toContainText('Новых игр найдено:')
      await expect(panel.locator('.steam-integration__brand h2')).toContainText('Steam подключен')
      await expect(panel.locator('.steam-integration__close')).toHaveCSS('border-style', 'solid')
      await expect(panel.getByRole('button', { name: 'Синхронизировать' })).toBeEnabled()
      await expect(panel.getByRole('button', { name: 'Отвязать Steam' })).toBeVisible()
      await expect(panel).not.toContainText('настройки приватности Steam')
    } else {
      const privacy = panel.getByRole('link', { name: /настройки приватности Steam/ })
      await expect(privacy).toHaveAttribute('href', 'https://steamcommunity.com/my/edit/settings')
      await expect(panel).toContainText('Мой профиль — Открытый')
      await expect(panel).toContainText('Доступ к игровой информации — Открытый')
      await expect(panel).toContainText('Скрывать общее время в играх, даже если видны другие данные о них — снимите галочку')
      await expect(panel).toContainText('Синхронизация запускается только вручную.')
      await expect(panel).not.toContainText('не имеет доступа к закрытым играм')
      await expect(panel.getByRole('link', { name: 'Войти в Steam' })).toHaveAttribute('href', '/api/steam/connect')
      await expect(panel).toContainText('не получает пароль')
    }
    await panel.getByRole('button', { name: 'Закрыть подключение Steam' }).click()
    await expect(panel).toHaveCount(0)
  })
}

test('Steam redirect result opens link dialog and can be dismissed', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: { id: 704, nickname: 'callback_qa', email: 'steam@example.test',
          avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-01T00:00:00Z' },
        library: [], collections: [] }
      : path === '/api/steam/connection'
        ? { connected: true, steamId64: '76561198012345678' }
        : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/?tab=profile&steam=connected')
  const dialog = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Steam подключен')
  await expect(dialog).not.toContainText('Steam успешно подключен')
  await expect(page).not.toHaveURL(/steam=connected/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('Steam preview requires a second Sync click and shows only new and unknown games', async ({ page }) => {
  let previews = 0
  let commits = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: { id: 705, nickname: 'steam_sync_qa', email: 'steam@example.test',
            avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection'
        ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/steam/overview'
        ? { steamId64: '76561198012345678', configured: true,
            profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
              profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
            gameCount: 3, canSync: true, redFlags: [], lastSyncedAt: null }
      : path === '/api/steam/preview'
        ? (previews++, { token: 'preview-12345678901234567890123456',
            items: [{ igdbId: 1877, title: 'Cyberpunk 2077', status: 'playing',
              coverUrl: null, apps: [{ appid: 1091500, minutes: 400 }] }],
            unresolved: [{ appid: 999999, name: 'Unknown Steam Game' }] })
      : path === '/api/steam/commit'
        ? (commits++, { created: [{ igdbId: 1877, title: 'Cyberpunk 2077', status: 'playing' }],
            unresolved: [{ appid: 999999, name: 'Unknown Steam Game' }] })
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  const sync = panel.getByRole('button', { name: 'Синхронизировать' })
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect(panel).toContainText('Будут добавлены:')
  await expect(panel).toContainText('Нужно найти в Rate APP:')
  await expect(panel).toContainText('Будут добавлены: 1')
  await expect(panel).toContainText('Это предпросмотр, игры еще не синхронизированы')
  await expect(panel).toContainText('Cyberpunk 2077')
  await expect(panel).not.toContainText('Steam #')
  await expect(panel.getByRole('link', { name: 'Unknown Steam Game' }))
    .toHaveAttribute('href', 'https://store.steampowered.com/app/999999/')
  await expect(panel.getByRole('button', { name: 'Найти в базе Rate APP: Unknown Steam Game' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Больше не показывать: Unknown Steam Game' })).toBeVisible()
  expect(previews).toBe(1)
  expect(commits).toBe(0)
  await sync.click()
  await expect(panel).toContainText('Синхронизировано новых игр: 1')
  expect(commits).toBe(1)
})

test('privacy red flag shows actionable instructions, not internal API details', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: { id: 713, nickname: 'privacy_qa', email: 'steam@example.test',
          avatarVersion: 0, profileTint: 'rose', createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection' ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/steam/overview'
        ? { steamId64: '76561198012345678', configured: true,
            profile: { name: 'Steam Player', avatarUrl: 'https://avatars.steamstatic.com/qa.jpg',
              profilePublic: true, profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
            gameCount: 0, canSync: false, privacyIssue: true,
            redFlags: ['Список игр скрыт'], lastSyncedAt: null }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.route('https://avatars.steamstatic.com/qa.jpg', route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+dRTsAAAAASUVORK5CYII=', 'base64') }))
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await expect(panel.getByRole('link', { name: 'Открыть профиль Steam' })).toContainText('Steam Player')
  await expect(panel.locator('.steam-integration__profile > img')).toBeVisible()
  await expect(panel).toContainText('Проверьте настройки приватности Steam')
  await expect(panel).toContainText('Доступ к игровой информации')
  await expect(panel.getByRole('link', { name: 'настройки приватности Steam' }))
    .toHaveAttribute('href', 'https://steamcommunity.com/my/edit/settings')
  await expect(panel.getByRole('button', { name: 'Синхронизировать' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Проверить доступ снова' })).toBeVisible()
  await expect(panel).not.toContainText('STEAM_WEB_API_KEY')
  await expect(panel.locator('.steam-integration__brand h2')).toHaveCount(1)
  await expect(panel.locator('.steam-integration__panel')).toHaveCSS('--steam-accent', '#e384b5')
  await expect(panel.locator('.steam-integration__disconnect')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('server setup failures never appear as API key instructions in Steam UI', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: { id: 714, nickname: 'service_qa', email: 'steam@example.test',
          avatarVersion: 0, profileTint: 'blue', createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection' ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/steam/overview'
        ? { steamId64: '76561198012345678', configured: false,
            profile: { name: 'Профиль Steam', avatarUrl: null,
              profilePublic: null, profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
            gameCount: 0, canSync: false, privacyIssue: false,
            redFlags: ['Пока не удаётся проверить библиотеку Steam. Попробуйте позже.'], lastSyncedAt: null }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await expect(panel).toContainText('Пока не удаётся проверить доступ к библиотеке Steam')
  await expect(panel.getByRole('button', { name: 'Синхронизировать' })).toBeDisabled()
  await expect(panel).not.toContainText('STEAM_WEB_API_KEY')
  await expect(panel).not.toContainText('Администратору')
  await expect(panel.locator('.steam-integration__panel')).toHaveCSS('--steam-accent', '#719be4')
})

test('Steam sync button acknowledges click with continuous activity state', async ({ page }) => {
  let releasePreview: (() => void) | undefined
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/steam/preview') {
      await new Promise<void>(resolve => { releasePreview = resolve })
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ token: 'preview-12345678901234567890123456', items: [], unresolved: [],
          nextSyncAt: new Date(Date.now() + 120000).toISOString() }) })
      return
    }
    const payload = path === '/api/bootstrap'
      ? { user: { id: 715, nickname: 'spinner_qa', email: 'steam@example.test',
          profileTint: 'default', avatarVersion: 0, createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection' ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/steam/overview'
        ? { steamId64: '76561198012345678', configured: true,
            profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
              profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
            gameCount: 8, canSync: true, redFlags: [], lastSyncedAt: null }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  const sync = panel.getByRole('button', { name: 'Синхронизировать' })
  await expect(panel).toHaveAttribute('data-mode', 'compact')
  const compactHeight = await panel.evaluate(element => element.offsetHeight)
  await sync.click()
  // Sync starts the spinner only. An empty result must never expand the glass.
  await expect(panel).toHaveAttribute('data-mode', 'compact')
  await expect.poll(async () => panel.evaluate(element => element.offsetHeight))
    .toBeCloseTo(compactHeight, 0)
  await expect(panel).toHaveCSS('scrollbar-width', 'none')
  await expect(panel.getByRole('button', { name: 'Проверяем библиотеку…' })).toBeDisabled()
  await expect(panel.locator('.steam-integration__connect--sync .steam-integration__sync-icon')).toHaveCSS('animation-name', 'steam-sync-turn')
  await page.waitForTimeout(1300)
  await expect(panel.locator('.steam-integration__connect--sync .steam-integration__sync-icon')).toHaveCSS('animation-name', 'steam-sync-turn')
  releasePreview?.()
  await expect(panel).toContainText('Это предпросмотр, игры еще не синхронизированы')
  await expect(panel).toHaveAttribute('data-mode', 'compact')
  const afterEmpty = await panel.evaluate(element => element.offsetHeight)
  expect(Math.abs(afterEmpty - compactHeight)).toBeLessThan(2)
  await expect(panel.getByRole('button', { name: 'Синхронизировать' })).toBeEnabled()
})

test('Steam unresolved rows have separate Steam page/search/dismiss actions and hide after dismiss', async ({ page }) => {
  let ignored = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/steam/ignored') {
      ignored++
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"hidden":true}' })
      return
    }
    const body = path === '/api/bootstrap'
      ? { user: { id: 720, nickname: 'steam_filter_qa', email: 'steam@example.test',
            avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection'
        ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/steam/overview'
        ? { steamId64: '76561198012345678', configured: true,
            profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
              profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
            gameCount: 5, alreadyAddedCount: 3, canSync: true, redFlags: [], lastSyncedAt: new Date(Date.now() - 4000000).toISOString() }
      : path === '/api/steam/preview'
        ? { token: 'preview-12345678901234567890123456', items: [
              { igdbId: 1877, title: 'Cyberpunk 2077', status: 'playing', coverUrl: null,
                apps: [{ appid: 1091500, minutes: 100 }] }],
            unresolved: [{ appid: 809010, name: 'A game Steam cannot map' }],
            nextSyncAt: new Date(Date.now() + 30000).toISOString() }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/?tab=profile')
  const cloud = page.getByRole('button', { name: 'Steam подключен, открыть настройки' })
  await expect(cloud).toBeVisible()
  await cloud.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.steam-integration__brand h2')).toHaveText('Steam подключен')
  await panel.getByRole('button', { name: 'Синхронизировать' }).click()
  await expect(panel).toContainText('Будут добавлены: 1')
  await expect(panel.getByLabel('Уже добавлено: 3')).toBeVisible()
  await expect(panel.locator('.steam-integration__unresolved-search')).toHaveCSS('color', 'rgb(140, 242, 125)')
  await expect(panel.locator('.steam-integration__unresolved-dismiss')).toHaveCSS('color', 'rgb(255, 129, 142)')
  await expect(panel).toContainText('Последняя синхронизация:')
  await expect(panel).toContainText('Нужно найти в Rate APP: 1')
  await expect(panel).toContainText('Попробуйте добавить игру вручную.')
  await expect(panel.getByRole('link', { name: 'A game Steam cannot map' }))
    .toHaveAttribute('href', 'https://store.steampowered.com/app/809010/')
  await panel.getByRole('button', { name: 'Больше не показывать: A game Steam cannot map' }).click()
  await expect(panel).toContainText('Нужно найти в Rate APP: 0')
  await expect(panel).not.toContainText('A game Steam cannot map')
  expect(ignored).toBe(1)
  await expect(panel).not.toContainText('809010')
})

test('manual Steam search saves playthrough before asking consent, links only on checkmark', async ({ page }) => {
  const game = { id: 889, title: 'Call of Duty: Modern Warfare', genres: ['Шутер'],
    year: 2019, releaseDate: '2019-10-25', developer: 'Infinity Ward',
    platforms: ['PC'], igdbRating: 8, communityRating: 0, communityRatings: 0,
    accent: '#336699', accent2: '#223344', glyph: 'C' }
  let saved = 0
  let linked = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data: unknown = {}
    if (path === '/api/bootstrap') data = {
      user: { id: 721, nickname: 'cod_qa', email: 'steam@example.test',
        avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-01T00:00:00Z' },
      library: [], collections: [
        { id: 'wishlist', title: 'Хочу пройти', mark: '❤️', description: '',
          isSystem: true }],
    }
    else if (path === '/api/steam/connection') data = { connected: true, steamId64: '76561198012345678' }
    else if (path === '/api/steam/overview') data = {
      steamId64: '76561198012345678', configured: true,
      profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
        profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
      gameCount: 1, canSync: true, redFlags: [], lastSyncedAt: null }
    else if (path === '/api/steam/preview') data = {
      token: 'preview-12345678901234567890123456', items: [],
      unresolved: [{ appid: 809010, name: 'Call of Duty Deluxe' }],
      nextSyncAt: new Date(Date.now() + 30000).toISOString() }
    else if (path === '/api/games/search') data = { items: [game], hasMore: false, nextOffset: null }
    else if (path === '/api/library/889' && route.request().method() === 'PUT') {
      saved++
      data = { gameId: 889, game, status: 'playing', platform: 'PC',
        startedAt: '2026-11-01', completedAt: null, score: null,
        atmosphereScore: null, storyScore: null, technologyScore: null,
        gameplayScore: null, review: null, steamLinked: false,
        collectionIds: [], addedAt: '2026-11-01' }
    } else if (path === '/api/steam/manual-match') {
      linked++
      data = { linked: true }
    } else if (path === '/api/push/config') data = { enabled: false, publicKey: '', devices: 0 }
    else if (path === '/api/games/889/details') data = { game }
    else if (path === '/api/games/889/community-rating') data = { gameId: 889, communityRating: 0, communityRatings: 0 }
    else if (path === '/api/games/889/similar') data = []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await panel.getByRole('button', { name: 'Синхронизировать' }).click()
  await panel.getByRole('button', { name: 'Найти в базе Rate APP: Call of Duty Deluxe' }).click()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toHaveValue('Call of Duty Deluxe')
  await page.getByRole('button', { name: 'Открыть игру «Call of Duty: Modern Warfare»' }).click()
  await page.getByRole('button', { name: 'Добавить прохождение' }).click()
  await page.locator('.choice-button--playing').click()
  await page.getByRole('button', { name: 'Сохранить в библиотеку' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Это та же игра?' })
  await expect(dialog).toContainText('Call of Duty Deluxe')
  await expect(dialog).toContainText('Call of Duty: Modern Warfare')
  await expect(dialog).not.toContainText('Игра уже добавлена в Rate APP')
  await expect(dialog.locator('.rateapp-confirm__brand')).toHaveCount(0)
  const pairHeights = await dialog.locator('.steam-match-confirm__pair > div').evaluateAll(nodes =>
    nodes.map(node => node.getBoundingClientRect().height))
  expect(pairHeights.every(height => height < 120)).toBe(true)
  expect(saved).toBe(1)
  expect(linked).toBe(0)
  await dialog.getByRole('button', { name: 'Да, связать игры' }).click()
  await expect(dialog).toHaveCount(0)
  expect(linked).toBe(1)
  await expect(page.locator('.detail-hero__steam-badge')).toBeVisible()
  await expect(page.locator('.detail-hero__steam-badge')).toHaveCSS('width', '18px')
  // A bottom-tab switch must end the Steam lookup; navigation within the
  // lookup (search -> game -> Back) keeps its state until that explicit switch.
  await page.getByRole('button', { name: 'Профиль', exact: true }).click()
  await page.getByRole('button', { name: 'База игр', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toHaveValue('')
})


for (const scenario of [
  { collectionId: 'wishlist', collectionTitle: 'Хочу пройти', accept: true },
  { collectionId: 'coop', collectionTitle: 'Кооператив', accept: false },
] as const) {
  test('manual Steam search links from a collection and respects decline: ' + scenario.collectionTitle, async ({ page }) => {
    const game = { id: 889, title: 'Call of Duty: Modern Warfare', genres: ['Шутер'],
      year: 2019, releaseDate: '2019-10-25', developer: 'Infinity Ward',
      platforms: ['PC'], igdbRating: 8, communityRating: 0, communityRatings: 0,
      accent: '#336699', accent2: '#223344', glyph: 'C' }
    let memberships = 0
    let linked = 0
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let data: unknown = {}
      if (path === '/api/bootstrap') data = {
        user: { id: 722, nickname: 'cod_collection_qa', email: 'steam@example.test',
          avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-01T00:00:00Z' },
        library: [],
        collections: [
          { id: 'wishlist', title: 'Хочу пройти', mark: '❤️', description: '', isSystem: true },
          { id: 'coop', title: 'Кооператив', mark: '🎮', description: '', isSystem: false },
        ],
      }
      else if (path === '/api/steam/connection')
        data = { connected: true, steamId64: '76561198012345678' }
      else if (path === '/api/steam/overview') data = {
        steamId64: '76561198012345678', configured: true,
        profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
          profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
        gameCount: 1, canSync: true, redFlags: [], lastSyncedAt: null,
      }
      else if (path === '/api/steam/preview') data = {
        token: 'preview-12345678901234567890123456', items: [],
        unresolved: [{ appid: 809010, name: 'Call of Duty Deluxe' }],
        nextSyncAt: new Date(Date.now() + 30000).toISOString(),
      }
      else if (path === '/api/games/search')
        data = { items: [game], hasMore: false, nextOffset: null }
      else if (path === '/api/games/889/details') data = { game }
      else if (path === '/api/games/889/community-rating')
        data = { gameId: 889, communityRating: 0, communityRatings: 0 }
      else if (path === '/api/games/889/similar') data = { items: [] }
      else if (path === '/api/push/config')
        data = { enabled: false, publicKey: '', devices: 0 }
      else if (path === '/api/library/889/wishlist' ||
               path === '/api/library/889/collections/coop') {
        if (route.request().method() === 'PUT') memberships++
      }
      else if (path === '/api/steam/manual-match') {
        linked++
        data = { linked: true }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    })

    await page.goto('/?tab=profile')
    await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
    const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
    await panel.getByRole('button', { name: 'Синхронизировать' }).click()
    await panel.getByRole('button', { name: 'Найти в базе Rate APP: Call of Duty Deluxe' }).click()
    const search = page.getByRole('textbox', { name: 'Поиск по базе игр' })
    await expect(search).toHaveValue('Call of Duty Deluxe')
    // The Steam AppID context must survive the user's correction of the search term.
    await search.fill('Call of Duty')
    await page.getByRole('button', { name: 'Открыть игру «Call of Duty: Modern Warfare»' }).click()
    await page.locator('.detail-toolbar__actions').getByRole('button', { name: 'Коллекции' }).click()
    await page.getByRole('button', {
      name: 'Добавить «Call of Duty: Modern Warfare» в «' + scenario.collectionTitle + '»',
    }).click()

    const consent = page.getByRole('alertdialog', { name: 'Это та же игра?' })
    await expect(consent).toContainText('Call of Duty Deluxe')
    await expect(consent).toContainText('Call of Duty: Modern Warfare')
    expect(memberships).toBe(1)
    expect(linked).toBe(0)
    await consent.getByRole('button', {
      name: scenario.accept ? 'Да, связать игры' : 'Нет, не связывать игры',
    }).click()
    await expect(consent).toHaveCount(0)
    expect(linked).toBe(scenario.accept ? 1 : 0)
    if (scenario.accept) {
      await expect(page.locator('.detail-hero__steam-badge')).toBeVisible()
    } else {
      await expect(page.locator('.detail-hero__steam-badge')).toHaveCount(0)
    }
  })
}


test('Steam modal consumes Back and empty preview has no new-game block', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/bootstrap' ? {
      user: { id: 812, nickname: 'back_qa', email: 'steam@example.test',
        avatarVersion: 0, profileTint: 'rose', createdAt: '2026-11-01T00:00:00Z' },
      library: [], collections: [],
    } : path === '/api/steam/connection' ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/steam/overview' ? {
        steamId64: '76561198012345678', configured: true, alreadyAddedCount: 4,
        profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
          profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
        gameCount: 5, canSync: true, redFlags: [], lastSyncedAt: null,
      } : path === '/api/steam/preview' ? {
        token: 'preview-12345678901234567890123456', items: [],
        unresolved: [{ appid: 809010, name: 'Call of Duty Deluxe' }],
      } : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click({ force: true })
  const modal = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await modal.getByRole('button', { name: 'Синхронизировать' }).click()
  await expect(modal.locator('.steam-integration__already-added')).toContainText('Уже добавлено: 4')
  await expect(modal).not.toContainText('Будут добавлены')
  await expect(modal).not.toContainText('Новых игр для добавления нет.')
  await expect(modal).toContainText('Нужно найти в Rate APP: 1')
  await expect(page.locator('.page--viewport')).toHaveCSS('scrollbar-width', 'none')
  await expect(page.locator('.app-shell--viewport')).toHaveCSS('--profile-full-rgb', '235,87,153')
  await page.evaluate(() => {
    const event = new Event('rateapp:cancel-transient', { cancelable: true })
    window.dispatchEvent(event)
    if (!event.defaultPrevented) throw new Error('Steam dialog did not consume Back')
  })
  await expect(modal).toHaveCount(0)
  await expect(page).toHaveURL(/tab=profile/)
})


test('Steam compact dialog reserves space while overview loads and never navigates on cloud tap', async ({ page }) => {
  let finishOverview: (() => void) | undefined
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/steam/overview') {
      await new Promise<void>(resolve => { finishOverview = resolve })
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          steamId64: '76561198012345678', configured: true,
          profile: { name: 'Мой Steam', avatarUrl: null, profilePublic: true,
            profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
          gameCount: 1, canSync: true, redFlags: [], lastSyncedAt: '2026-10-31T12:00:00Z',
        }) })
      return
    }
    const data = path === '/api/bootstrap'
      ? { user: { id: 819, nickname: 'steady_qa', email: 'steam@example.test',
          avatarVersion: 0, profileTint: 'rose', createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection' ? { connected: true, steamId64: '76561198012345678' }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  await page.goto('/?tab=profile')
  const cloud = page.getByRole('button', { name: 'Steam подключен, открыть настройки' })
  await expect(cloud).toBeVisible()
  await cloud.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-mode', 'compact')
  await expect(dialog).not.toContainText('Проверяем подключение и вашу библиотеку')
  await expect(dialog.getByLabel('Профиль Steam загружается')).toBeVisible()
  await expect(dialog.locator('.steam-integration__avatar-placeholder')).toBeVisible()
  await expect(dialog).toContainText('Последняя синхронизация: —')
  await expect(dialog.getByRole('button', { name: 'Синхронизировать' })).toBeDisabled()
  const initialHeight = await dialog.evaluate(el => el.offsetHeight)
  finishOverview?.()
  await expect(dialog.locator('.steam-integration__brand h2')).toHaveText('Steam подключен', { timeout: 8000 })
  await expect(dialog).toContainText('Последняя синхронизация:')
  await expect(dialog.getByRole('link', { name: 'Открыть профиль Steam' })).toContainText('Мой Steam')
  await expect(dialog).not.toContainText('Последняя синхронизация: —')
  const bottomSpacing = await dialog.evaluate(panel => {
    const unlink = panel.querySelector('.steam-integration__disconnect')!
    return panel.getBoundingClientRect().bottom - unlink.getBoundingClientRect().bottom
  })
  expect(bottomSpacing).toBeGreaterThan(6)
  expect(bottomSpacing).toBeLessThan(90)
  const loadedHeight = await dialog.evaluate(el => el.offsetHeight)
  expect(Math.abs(loadedHeight - initialHeight)).toBeLessThan(2)
  await expect(dialog).toHaveAttribute('data-mode', 'compact')
  await expect(page).toHaveURL(/tab=profile/)
  await dialog.getByRole('button', { name: 'Закрыть подключение Steam' }).click()
  await expect(dialog).toHaveCount(0)
})


for (const count of [2, 26]) {
  test('Steam dialog sizes to returned games (' + count + ') and caps long lists at viewport', async ({ page }) => {
    let releasePreview: (() => void) | undefined
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/steam/preview') {
        await new Promise<void>(resolve => { releasePreview = resolve })
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            token: 'preview-12345678901234567890123456',
            items: [], unresolved: Array.from({ length: count }, (_, i) => ({
              appid: 550000 + i, name: 'Несопоставленная игра № ' + (i + 1),
            })),
            nextSyncAt: new Date(Date.now() + 30000).toISOString(),
          }),
        })
        return
      }
      const data = path === '/api/bootstrap'
        ? { user: { id: 820 + count, nickname: 'sizing_qa', email: 'steam@example.test',
            avatarVersion: 0, profileTint: 'blue', createdAt: '2026-11-01T00:00:00Z' },
            library: [], collections: [] }
        : path === '/api/steam/connection' ? { connected: true, steamId64: '76561198012345678' }
        : path === '/api/steam/overview' ? {
          steamId64: '76561198012345678', configured: true,
          profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
            profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
          gameCount: count, canSync: true, redFlags: [], lastSyncedAt: null,
        }
        : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    })
    await page.goto('/?tab=profile')
    const cloud = page.getByRole('button', { name: 'Steam подключен, открыть настройки' })
    await cloud.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
    await expect(panel).toHaveAttribute('data-mode', 'compact')
    const before = await panel.evaluate(el => el.offsetHeight)
    await panel.getByRole('button', { name: 'Синхронизировать' }).click()
    await expect(panel).toHaveAttribute('data-mode', 'compact')
    await expect(panel.getByRole('button', { name: 'Проверяем библиотеку…' })).toBeDisabled()
    const during = await panel.evaluate(el => el.offsetHeight)
    expect(Math.abs(during - before)).toBeLessThan(2)
    releasePreview?.()
    await expect(panel).toHaveAttribute('data-mode', 'results')
    await expect(panel).toContainText('Нужно найти в Rate APP: ' + count)
    const viewport = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight)
    await expect.poll(async () => panel.evaluate(el => el.offsetHeight))
      .toBeGreaterThan(before + 8)
    // Wait for the actual 530ms glass resize to settle, not its first frame.
    await expect.poll(async () => panel.evaluate(el => {
      const desired = Number.parseFloat(el.style.height)
      return Number.isFinite(desired) ? Math.abs(el.offsetHeight - desired) : 1000
    }), { timeout: 2500 }).toBeLessThan(4)
    const after = await panel.evaluate(el => el.offsetHeight)
    expect(after).toBeLessThanOrEqual(viewport)
    if (count === 26) {
      expect(after).toBeGreaterThan(viewport * .86)
      const scrollable = await panel.evaluate(el => el.scrollHeight > el.clientHeight + 50)
      expect(scrollable).toBe(true)
      await expect(panel).toHaveCSS('scrollbar-width', 'none')
      await panel.evaluate(el => { el.scrollTop = el.scrollHeight })
      await expect(panel.getByRole('button', { name: 'Больше не показывать: Несопоставленная игра № 26' })).toBeVisible()
    } else {
      expect(after).toBeLessThan(viewport * .9)
    }
    await expect(page).toHaveURL(/tab=profile/)
  })
}
