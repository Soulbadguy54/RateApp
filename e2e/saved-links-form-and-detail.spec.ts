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
      if (pathname.includes('/62/')) {
        // Server GET revalidates while this new link's metadata is still
        // running. The request must not be cancelled by a list re-render.
        await new Promise(resolve => setTimeout(resolve, 320))
        await json({ title: 'Актуальный заголовок статьи', description: 'Текст описания' })
      } else {
        await json({ title: null, description: null })
      }
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
  await expect(page.locator('.saved-links-add button')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Добавить введённую ссылку' })).toBeDisabled()
  await page.getByPlaceholder('Введите ссылку').fill('example.org/second')
  await expect(page.getByRole('button', { name: 'Добавить введённую ссылку' })).toBeEnabled()
  await page.getByRole('button', { name: 'Добавить введённую ссылку' }).click()
  await expect(page.locator('.saved-link-card')).toHaveCount(2)
  await expect(page.locator('.saved-link-card').first()).toContainText('Актуальный заголовок статьи')
  await expect(page.locator('.saved-link-card').first()).toContainText('Актуальный заголовок статьи')
  await expect(page.locator('.saved-link-card').first()).toContainText('Текст описания')
  await expect(page.getByText('Ссылка добавлена.')).toHaveCount(0)
  await expect(page.getByPlaceholder('Введите ссылку')).toBeVisible()
  await expect(page.getByPlaceholder('Введите ссылку')).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Закрыть ввод ссылки' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.saved-link-card').first()).toContainText('Актуальный заголовок статьи')
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
  let removed = 0
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
    } else if (pathname.endsWith('/wishlist') && method === 'DELETE') {
      removed++
      await json({})
    } else await json({})
  })
  await page.goto('/?tab=links')
  await expect(page.getByRole('button', { name: 'Открыть игру SOMA' })).toBeVisible()
  await page.getByRole('button', { name: 'Открыть игру SOMA' }).click()
  await expect(page).toHaveURL(/game=9727/)
  await expect(page.getByRole('heading', { name: 'SOMA' })).toBeVisible()
  // This test verifies game gestures, not the asynchronous install banner.
  // Avoid a banner mounting/unmounting over the lower game cover during click.
  await page.addStyleTag({ content: '.install-prompt { display: none !important; pointer-events: none !important; }' })
  await expect(page.getByRole('button', { name: 'Открыть похожую игру Disco Elysium' })).toBeVisible()
  const collection = page.getByRole('button', { name: 'Коллекции', exact: true }).first()
  // Mobile touch events must survive native contextmenu/pointercancel.
  // Simulate touch input with ordinary DOM Events: Safari WebKit's Touch
  // constructor is not constructible in automated browser contexts.
  await collection.evaluate(el => {
    const touch = { identifier: 39, clientX: 45, clientY: 45, target: el }
    const event = new Event('touchstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: [touch] })
    Object.defineProperty(event, 'targetTouches', { value: [touch] })
    Object.defineProperty(event, 'changedTouches', { value: [touch] })
    el.dispatchEvent(event)
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(540)
  await collection.evaluate(el => {
    const touch = { identifier: 39, clientX: 45, clientY: 45, target: el }
    const event = new Event('touchend', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: [] })
    Object.defineProperty(event, 'targetTouches', { value: [] })
    Object.defineProperty(event, 'changedTouches', { value: [touch] })
    el.dispatchEvent(event)
  })
  await expect(page.getByText('Добавлено в «Хочу пройти»')).toBeVisible()
  expect(added).toBe(1)
  await expect(collection).toHaveAttribute('aria-pressed', 'true')
  await expect(collection.locator('svg')).toHaveCSS('fill', 'rgb(255, 162, 202)')
  await collection.evaluate(el => {
    const touch = { identifier: 40, clientX: 45, clientY: 45, target: el }
    const event = new Event('touchstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: [touch] })
    Object.defineProperty(event, 'targetTouches', { value: [touch] })
    Object.defineProperty(event, 'changedTouches', { value: [touch] })
    el.dispatchEvent(event)
  })
  await page.waitForTimeout(540)
  await collection.evaluate(el => {
    const touch = { identifier: 40, clientX: 45, clientY: 45, target: el }
    const event = new Event('touchend', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: [] })
    Object.defineProperty(event, 'targetTouches', { value: [] })
    Object.defineProperty(event, 'changedTouches', { value: [touch] })
    el.dispatchEvent(event)
  })
  await expect(page.getByText('Убрано из «Хочу пройти»')).toBeVisible()
  await expect(collection).toHaveAttribute('aria-pressed', 'false')
  expect(removed).toBe(1)
  await expect(page.locator('.detail-collection-picker')).toHaveCount(0)
  // PWA install overlay appears on a delay on some mobile engines.

  await page.getByRole('button', { name: 'Открыть похожую игру Disco Elysium' }).click()
  await expect(page).toHaveURL(/game=26472/)
})
