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
  await expect(page.locator('.saved-links-add button')).toHaveCount(0)
  const linkInput = page.getByPlaceholder('Введите ссылку')
  await linkInput.fill('not-a-valid-link')
  await expect(page.locator('.saved-links-add')).toHaveClass(/saved-links-add--invalid/)
  await expect(page.getByRole('button', { name: 'Добавить введённую ссылку' })).toHaveCount(0)
  await linkInput.press('Enter')
  await expect(page.getByText(/Некорректная ссылка/)).toBeVisible()
  await expect(page.locator('.saved-link-card')).toHaveCount(1)
  await linkInput.fill('example.org/second')
  await expect(page.locator('.saved-links-add')).not.toHaveClass(/saved-links-add--invalid/)
  await expect(page.getByRole('button', { name: 'Добавить введённую ссылку' })).toBeEnabled()
  await page.getByRole('button', { name: 'Добавить введённую ссылку' }).click()
  await expect(page.locator('.saved-link-card')).toHaveCount(2)
  await expect(page.locator('.saved-link-card').first()).toContainText('Актуальный заголовок статьи')
  await expect(page.locator('.saved-link-card').first()).toContainText('Актуальный заголовок статьи')
  await expect(page.locator('.saved-link-card').first()).toContainText('Текст описания')
  await expect(page.getByText('Ссылка добавлена.')).toHaveCount(0)
  await expect(page.getByPlaceholder('Введите ссылку')).toBeVisible()
  await expect(page.getByPlaceholder('Введите ссылку')).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Добавить введённую ссылку' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Закрыть ввод ссылки' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.saved-link-card').first()).toContainText('Актуальный заголовок статьи')
  await expect(page.locator('.saved-link-card')).toHaveCount(2)
})
