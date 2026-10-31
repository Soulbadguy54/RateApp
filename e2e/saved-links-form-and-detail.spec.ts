import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('My Links: top-right plus, keyboard submit, newest first and reload cache', async ({ page }) => {
  const first = { id: 61, url: 'https://example.org/first',
    title: 'Первый обзор', createdAt: '2026-10-30T09:00:00Z', games: [] }
  const newItem = { id: 62, url: 'https://example.org/second',
    title: 'Новый обзор', createdAt: '2026-10-31T09:00:00Z', games: [] }
  let list = [first]
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const method = route.request().method()
    const json = (value: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(value),
    })
    if (pathname === '/api/bootstrap') {
      await json({ user: { id: 987, nickname: 'cached-saved-links',
        email: 'cached@example.test' }, library: [], collections: [] })
    } else if (pathname === '/api/saved-links' && method === 'GET') {
      await json({ items: list, nextBefore: null })
    } else if (pathname === '/api/saved-links' && method === 'POST') {
      list = [newItem, ...list]
      await json(newItem, 201)
    } else if (pathname.endsWith('/preview')) {
      await json({ title: null, description: null })
    } else if (pathname.endsWith('/thumbnail')) {
      await route.fulfill({ status: 204, body: '' })
    } else await json({})
  })

  await page.goto('/?tab=links')
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Добавить ссылку' })).toBeVisible()
  await expect(page.getByPlaceholder('Введите ссылку')).not.toBeVisible()
  await expect(page.getByText('Сохранённое 1')).toHaveCount(0)
  await page.getByRole('button', { name: 'Добавить ссылку' }).click()
  await expect(page.getByPlaceholder('Введите ссылку')).toBeVisible()
  await expect(page.locator('.saved-links-add button')).toHaveCount(0)
  await page.getByPlaceholder('Введите ссылку').fill('example.org/second')
  await page.getByPlaceholder('Введите ссылку').press('Enter')
  await expect(page.locator('.saved-link-card')).toHaveCount(2)
  await expect(page.locator('.saved-link-card').first()).toContainText('Новый обзор')
  await expect(page.getByText('Ссылка добавлена.')).toHaveCount(0)
  await expect(page.getByPlaceholder('Введите ссылку')).toBeVisible()
  await expect(page.getByPlaceholder('Введите ссылку')).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Закрыть ввод ссылки' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.saved-link-card').first()).toContainText('Новый обзор')
  await expect(page.locator('.saved-link-card')).toHaveCount(2)
})

test('Game detail from links: IGDB ID, similar covers, and wishlist hold toast', async ({ page }) => {
  const details = { id: 9727, title: 'SOMA', genres: ['Adventure'],
    year: 2015, releaseDate: '2015-09-22', developer: 'Frictional Games',
    platforms: ['PC'], igdbRating: 84, communityRating: 0,
    communityRatings: 0, accent: '#6dc', accent2: '#258',
    glyph: 'S', coverUrl: '' }
  const related = { ...details, id: 26472, title: 'Disco Elysium', glyph: 'D' }
  let added = 0
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const method = route.request().method()
    const json = (value: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(value),
    })
    if (pathname === '/api/bootstrap') {
      await json({ user: { id: 987, nickname: 'detail-hold-qa',
        email: 'hold@example.test' }, library: [], collections: [] })
    } else if (pathname === '/api/saved-links') {
      await json({ items: [{ id: 9, url: 'https://example.org/games',
        title: 'Article games', createdAt: '2026-10-31T09:00:00Z',
        games: [{ id: 1251, igdbId: 9727, title: 'SOMA', coverUrl: null }] }],
        nextBefore: null })
    } else if (pathname.endsWith('/preview')) {
      await json({ title: 'Article games', description: null })
    } else if (pathname.endsWith('/thumbnail')) {
      await route.fulfill({ status: 204, body: '' })
    } else if (pathname === '/api/games/9727/details') {
      await json({ game: details, storyHours: 9, completionHours: 13,
        storeLinks: [], trailerUrl: null })
    } else if (pathname === '/api/games/9727/similar') {
      await json({ items: [related] })
    } else if (pathname.endsWith('/wishlist') && method === 'PUT') {
      added++
      await json({})
    } else await json({})
  })
  await page.goto('/?tab=links')
  await expect(page.getByRole('button', { name: 'Открыть игру SOMA' })).toBeVisible()
  await page.getByRole('button', { name: 'Открыть игру SOMA' }).click()
  await expect(page).toHaveURL(/game=9727/)
  await expect(page.getByRole('heading', { name: 'SOMA' })).toBeVisible()
  const dismissInstall = page.getByRole('button', { name: 'Закрыть предложение установки' })
  if (await dismissInstall.isVisible()) await dismissInstall.click()
  await expect(page.getByRole('button', { name: 'Открыть похожую игру Disco Elysium' })).toBeVisible()
  const collection = page.getByRole('button', { name: 'Коллекции', exact: true }).first()
  // Mobile touch events must survive native contextmenu/pointercancel.
  await collection.evaluate(el => {
    const touch = new Touch({ identifier: 39, target: el, clientX: 45, clientY: 45 })
    el.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true,
      touches: [touch], targetTouches: [touch], changedTouches: [touch],
    }))
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(540)
  await collection.evaluate(el => {
    const touch = new Touch({ identifier: 39, target: el, clientX: 45, clientY: 45 })
    el.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true,
      touches: [], targetTouches: [], changedTouches: [touch],
    }))
  })
  await expect(page.getByText('Добавлено в «Хочу пройти»')).toBeVisible()
  expect(added).toBe(1)
  await expect(page.locator('.detail-collection-picker')).toHaveCount(0)
  // PWA install overlay appears on a delay on some mobile engines.
  const lateInstall = page.getByRole('button', { name: 'Закрыть предложение установки' })
  if (await lateInstall.isVisible()) await lateInstall.click()
  await page.getByRole('button', { name: 'Открыть похожую игру Disco Elysium' }).click()
  await expect(page).toHaveURL(/game=26472/)
})
