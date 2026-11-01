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
          : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto('/?tab=profile')
    const steam = page.getByRole('button', { name: connected ? 'Steam подключён, открыть настройки' : 'Подключить Steam' })
    await expect(steam).toBeVisible()
    const dot = steam.locator('.profile-steam-cloud__status')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveCSS('background-color', connected ? 'rgb(94, 241, 155)' : 'rgb(255, 92, 102)')
    await steam.click({ force: true })
    const panel = page.getByRole('dialog', { name: connected ? 'Подключённый аккаунт Steam' : 'Подключение Steam' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(connected ? 'Импорт игр пока не включён' : 'Rate APP')
    if (connected) {
      await expect(panel.getByText('SteamID:')).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Отвязать Steam' })).toBeVisible()
    } else {
      const privacy = panel.getByRole('link', { name: /Открыть настройки приватности Steam/ })
      await expect(privacy).toHaveAttribute('href', 'https://steamcommunity.com/my/edit/settings')
      await expect(panel).toContainText('Сведения об играх')
      await expect(panel.getByRole('link', { name: 'Войти через Steam' })).toHaveAttribute('href', '/api/steam/connect')
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
