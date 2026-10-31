import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('links show game cover carousel and navigate to ordinary game details', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const req = route.request()
    const pathname = new URL(req.url()).pathname
    const json = (value: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(value),
    })
    if (pathname === '/api/bootstrap') {
      await json({ user: {
        id: 99999, nickname: 'carousel-e2e', email: 'carousel@example.test',
        createdAt: '2026-10-31T12:00:00', public: false,
      }, library: [], collections: [] })
    } else if (pathname === '/api/saved-links') {
      await json({ items: [
        {
          id: 7, url: 'https://example.org/with-games', title: 'Article with games',
          createdAt: '2026-10-31T12:00:00', games: [
            { id: 101, title: 'SOMA', coverUrl: null },
            { id: 102, title: 'Disco Elysium', coverUrl: null },
          ],
        },
        {
          id: 8, url: 'https://example.org/without-games', title: 'Plain article',
          createdAt: '2026-10-31T11:00:00', games: [],
        },
      ], nextBefore: null })
    } else if (pathname.endsWith('/preview')) {
      await json({ title: null, description: null })
    } else if (pathname.endsWith('/thumbnail')) {
      await route.fulfill({ status: 204, body: '' })
    } else if (/\/api\/games\/\d+\/details$/.test(pathname)) {
      await json({ game: { id: 101, igdbId: 999, title: 'SOMA',
        coverUrl: null, platforms: [], genres: [], description: '', releaseDate: null,
        igdbRating: null }, details: {} })
    } else await json({})
  })

  await page.goto('/?tab=links')
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toBeVisible()
  const source = page.locator('[data-saved-link-id="7"]')
  const withoutGames = page.locator('[data-saved-link-id="8"]')
  await expect(source.getByText('Игры из ссылки')).toBeVisible()
  await expect(source.locator('.saved-link-card__game-tile')).toHaveCount(2)
  await expect(withoutGames.locator('.saved-link-card__matched')).toHaveCount(0)
  await expect(source.getByRole('button', { name: 'Открыть игру SOMA' })).toBeVisible()
  await source.getByRole('button', { name: 'Открыть игру SOMA' }).click()
  await expect(page).toHaveURL(/tab=links.*game=101/)
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toBeVisible()
  await expect(source.getByRole('button', { name: 'Открыть игру Disco Elysium' })).toBeVisible()
})
