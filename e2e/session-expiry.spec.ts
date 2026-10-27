import { test, expect, type Page } from '@playwright/test'

// These are protected API failures, not IGDB failures. A missing server-side
// session must return to login without losing the user's stored game data.
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
  return nickname
}

test('expired game-search session leads to clear re-login, not IGDB error', async ({ page }) => {
  await register(page)
  await page.route('**/api/games/search?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'Neon') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Session expired"}' })
    } else {
      await route.continue()
    }
  })
  await page.locator('.bottom-nav__item').filter({ hasText: 'База игр' }).click()
  await page.getByRole('textbox', { name: 'Поиск по базе игр' }).fill('Neon')
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await expect(page.getByText('Сессия закончилась. Войди снова, чтобы продолжить.')).toBeVisible()
  await expect(page.getByText('Session expired')).toHaveCount(0)
})

test('expired local Discovery feed session also returns to login', async ({ page }) => {
  await register(page)
  await page.route('**/api/discover/feed', route =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Session expired"}' }),
  )
  await page.goto('/?tab=discovery')
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await expect(page.getByText('Твои игры и оценки сохранены.')).toBeVisible()
})
