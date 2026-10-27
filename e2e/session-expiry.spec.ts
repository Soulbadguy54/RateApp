import { test, expect, type Page } from '@playwright/test'

// Expire the actual server-side auth session without reloading the already
// authenticated SPA. Using a real 401 avoids WebKit interception differences
// between network requests and the installed PWA service worker.
async function register(page: Page) {
  const nickname = 'expiry_' + Math.random().toString(36).slice(2, 9)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await page.getByRole('button', { name: 'Регистрация' }).click()
  await page.locator('input[type=email]').fill(nickname + '@example.com')
  await page.locator('input[autocomplete=username]').fill(nickname)
  await page.locator('input[autocomplete=new-password]').first().fill('29843571')
  await page.locator('input[autocomplete=new-password]').last().fill('29843571')
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.locator('.bottom-nav')).toBeVisible()
}

async function expireSession(page: Page) {
  const response = await page.request.post('/api/auth/logout')
  expect(response.status()).toBe(204)
}

test('expired game-search session leads to clear re-login, not IGDB error', async ({ page }) => {
  await register(page)
  await page.locator('.bottom-nav__item').filter({ hasText: 'База игр' }).click()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toBeVisible()
  await expireSession(page)
  const expiredSearch = page.waitForResponse(response =>
    response.url().includes('/api/games/search?') && response.status() === 401,
  )
  await page.getByRole('textbox', { name: 'Поиск по базе игр' }).fill('Neon')
  await expiredSearch
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await expect(page.getByText('Сессия закончилась. Войди снова, чтобы продолжить.')).toBeVisible()
  await expect(page.getByText('Session expired')).toHaveCount(0)
})

test('expired local Discovery feed session also returns to login', async ({ page }) => {
  await register(page)
  const shortcut = page.locator('.bottom-nav__item--switchable')
  await shortcut.focus()
  await page.keyboard.press('ArrowRight')
  await expect(shortcut).toContainText('Для тебя')
  await expireSession(page)
  const expiredFeed = page.waitForResponse(response =>
    response.url().includes('/api/discover/feed') && response.status() === 401,
  )
  await shortcut.click()
  await expiredFeed
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await expect(page.getByText('Твои игры и оценки сохранены.')).toBeVisible()
})
