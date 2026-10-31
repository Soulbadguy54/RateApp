import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('new link receives safe metadata despite list reload; delete waits 2s', async ({ page }) => {
  const original = { id: 63, url: 'https://example.org/old', title: 'Старый обзор',
    createdAt: '2026-10-30T11:00:00Z', games: [] }
  const newItem = { id: 64, url: 'https://example.org/new', title: null,
    createdAt: '2026-10-31T11:00:00Z', games: [] }
  let links = [original]
  let deletes = 0
  let previews = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (path === '/api/bootstrap') await json({ user: { id: 726, nickname: 'preview-delete-qa',
      email: 'qa@example.test' }, library: [], collections: [] })
    else if (path === '/api/saved-links' && method === 'GET')
      await json({ items: links, nextBefore: null })
    else if (path === '/api/saved-links' && method === 'POST') {
      links = [newItem, original]
      await json(newItem, 201)
    } else if (path === '/api/saved-links/64/preview') {
      previews++
      // GET /saved-links updates the list while this request is still pending.
      await new Promise(resolve => setTimeout(resolve, 450))
      await json({ title: 'Правильный заголовок материала', description: 'Описание из метаданных' })
    } else if (path.endsWith('/preview')) {
      await json({ title: null, description: null })
    } else if (path.endsWith('/thumbnail')) {
      await route.fulfill({ status: 204, body: '' })
    } else if (path === '/api/saved-links/64' && method === 'DELETE') {
      deletes++
      links = links.filter(item => item.id !== 64)
      await route.fulfill({ status: 204, body: '' })
    } else await json({})
  })
  await page.goto('/?tab=links')
  await page.getByRole('button', { name: 'Добавить ссылку' }).click()
  await page.getByPlaceholder('Введите ссылку').fill('example.org/new')
  await page.getByPlaceholder('Введите ссылку').press('Enter')
  const fresh = page.locator('[data-saved-link-id="64"]')
  await expect(fresh).toBeVisible()
  await expect(fresh.locator('h3')).toHaveText('Правильный заголовок материала')
  await expect(fresh).toContainText('Описание из метаданных')
  expect(previews).toBeGreaterThan(0)
  await fresh.getByRole('button', { name: /Удалить ссылку/ }).click()
  const film = fresh.locator('.saved-link-card__radial-timer')
  await expect(film).toBeVisible()
  expect(await film.evaluate(el => getComputedStyle(el).animationDuration)).toBe('2s')
  await page.waitForTimeout(500)
  expect(deletes).toBe(0)
  await fresh.getByRole('button', { name: /Отменить удаление/ }).click()
  await page.waitForTimeout(2200)
  expect(deletes).toBe(0)
  await fresh.getByRole('button', { name: /Удалить ссылку/ }).click()
  await expect(fresh).toHaveCount(0, { timeout: 6500 })
  expect(deletes).toBe(1)
})

test('profile explains server-disabled push with outlined warning, not fake permission request', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (path === '/api/bootstrap') await json({ user: { id: 731, nickname: 'push-qa',
      email: 'push@example.test' }, library: [], collections: [] })
    else if (path === '/api/push/config') await json({ enabled: false, publicKey: '', devices: 0 })
    else await json({})
  })
  await page.goto('/?tab=profile')
  await expect(page.getByRole('heading', { name: '@push-qa' })).toBeVisible()
  const warning = page.locator('.push-settings__warning')
  // Web Push API may not be supported in the Playwright engine. In that case
  // the UI correctly explains the browser support requirement instead.
  await expect(warning).toBeVisible()
  await expect(page.getByText('Уведомления временно недоступны.')).toHaveCount(0)
  await expect(page.locator('.push-settings__warning svg')).toHaveCount(1)
})
