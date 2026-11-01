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
          : path === '/api/steam/overview'
          ? { steamId64: '76561198012345678', configured: false,
              profile: { name: 'Steam', avatarUrl: null, profilePublic: null,
                profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
              gameCount: 0, canSync: false, redFlags: ['Steam Web API key не настроен'], lastSyncedAt: null }
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
    await expect(panel).toContainText(connected ? 'Игры загружаются только по вашему запросу' : 'Rate APP')
    if (connected) {
      await expect(panel.getByText('SteamID:')).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Синхронизировать' })).toBeEnabled()
      await expect(panel.getByRole('button', { name: 'Отвязать Steam' })).toBeVisible()
    } else {
      const privacy = panel.getByRole('link', { name: /Открыть настройки приватности Steam/ })
      await expect(privacy).toHaveAttribute('href', 'https://steamcommunity.com/my/edit/settings')
      await expect(panel).toContainText('Сведения об играх')
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
