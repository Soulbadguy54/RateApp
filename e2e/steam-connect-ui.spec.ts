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
    const steam = page.getByRole('button', { name: connected ? 'Steam подключён, открыть настройки' : 'Подключить Steam' })
    await expect(steam).toBeVisible()
    const dot = steam.locator('.profile-steam-cloud__status')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveCSS('background-color', connected ? 'rgb(94, 241, 155)' : 'rgb(255, 92, 102)')
    if (connected) await expect(steam.locator('img')).toHaveCSS('filter', /invert\(1\)/)
    await steam.click({ force: true })
    const panel = page.getByRole('dialog', { name: connected ? 'Подключённый аккаунт Steam' : 'Подключение Steam' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(connected ? 'Игры синхронизируются только по вашему запросу.' : 'Привяжите Steam, чтобы импортировать библиотеку в Rate APP.')
    if (connected) {
      const profile = panel.getByRole('link', { name: 'Открыть профиль Steam' })
      await expect(profile).toHaveAttribute('href', 'https://steamcommunity.com/profiles/76561198012345678/')
      await expect(profile).toContainText('Steam QA')
      await expect(profile).toContainText('Steam ID: 76561198012345678')
      await expect(panel).toContainText('Игр доступно: 10')
      await expect(panel).toContainText('Последняя синхронизация: —')
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
  const dialog = page.getByRole('dialog', { name: 'Подключённый аккаунт Steam' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Steam успешно подключён')
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
  await page.getByRole('button', { name: 'Steam подключён, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключённый аккаунт Steam' })
  const sync = panel.getByRole('button', { name: 'Синхронизировать' })
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect(panel).toContainText('Будут добавлены')
  await expect(panel).toContainText('Cyberpunk 2077')
  await expect(panel.getByRole('button', { name: /Unknown Steam Game/ })).toBeVisible()
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
  await page.getByRole('button', { name: 'Steam подключён, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключённый аккаунт Steam' })
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
  await page.getByRole('button', { name: 'Steam подключён, открыть настройки' }).click({ force: true })
  const panel = page.getByRole('dialog', { name: 'Подключённый аккаунт Steam' })
  await expect(panel).toContainText('Пока не удаётся проверить доступ к библиотеке Steam')
  await expect(panel.getByRole('button', { name: 'Синхронизировать' })).toBeDisabled()
  await expect(panel).not.toContainText('STEAM_WEB_API_KEY')
  await expect(panel).not.toContainText('Администратору')
  await expect(panel.locator('.steam-integration__panel')).toHaveCSS('--steam-accent', '#719be4')
})
