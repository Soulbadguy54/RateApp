import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('Discovery uses violet spinner above a friendly message; Links uses green', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (value: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(value),
    })
    if (path === '/api/bootstrap') await json({
      user: { id: 9117, nickname: 'loader-qa', email: 'loader@example.test' },
      library: [], collections: [],
    })
    else if (path === '/api/saved-links') {
      await new Promise(resolve => setTimeout(resolve, 900))
      await json({ items: [], nextBefore: null })
    } else if (path.includes('/api/discover/feed')) {
      await new Promise(resolve => setTimeout(resolve, 900))
      await json({ items: [], remaining: 0 })
    } else await json({})
  })
  await page.goto('/?tab=links')
  const green = page.locator('.content-loading--green')
  await expect(green).toBeVisible()
  await expect(green.locator('.content-loading__spinner')).toBeVisible()
  await expect(green).toContainText('Открываем ссылки')
  await expect(green.locator('.content-loading__spinner')).toHaveCSS('border-top-color', 'rgb(140, 242, 125)')
  await expect(page.getByText('Пока нет ссылок')).toBeVisible()
  await page.goto('/?tab=discovery')
  const violet = page.locator('.discover-state .content-loading--violet')
  await expect(violet).toBeVisible()
  await expect(violet).toContainText('Подбираем игры')
  await expect(violet.locator('.content-loading__spinner')).toHaveCSS('border-top-color', 'rgb(184, 150, 250)')
})
