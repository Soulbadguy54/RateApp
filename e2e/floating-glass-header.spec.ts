import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('links retain glass header while the list scrolls underneath', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (path === '/api/bootstrap') return json({
      user: { id: 818, nickname: 'glass-qa', email: 'qa@example.test' },
      library: [], collections: [],
    })
    if (path === '/api/saved-links') return json({
      items: Array.from({ length: 25 }, (_, i) => ({
        id: i + 1, url: 'https://example.org/article-' + i,
        title: 'Подборка игр ' + i, createdAt: '2026-10-31T10:00:00Z',
        games: [],
      })), nextBefore: null,
    })
    if (path.endsWith('/preview')) return json({ title: null, description: null })
    if (path.endsWith('/thumbnail')) return route.fulfill({ status: 204, body: '' })
    return json({})
  })
  await page.goto('/?tab=links')
  const header = page.locator('.saved-links-header')
  await expect(header).toBeVisible()
  const scrollPane = page.locator('.page--viewport')
  const initial = await header.boundingBox()
  expect(initial).not.toBeNull()
  const filter = await header.evaluate(el => getComputedStyle(el).backdropFilter)
  expect(filter).toContain('blur(')
  const range = await scrollPane.evaluate(el => el.scrollHeight - el.clientHeight)
  expect(range).toBeGreaterThan(400)
  await scrollPane.evaluate(el => { el.scrollTop = 440 })
  await expect.poll(() => scrollPane.evaluate(el => el.scrollTop)).toBeGreaterThan(400)
  const sticky = await header.boundingBox()
  expect(sticky).not.toBeNull()
  expect(Math.abs(sticky!.y - initial!.y)).toBeLessThan(15)
})
