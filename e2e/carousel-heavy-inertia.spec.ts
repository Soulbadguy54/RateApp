import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('slow drag is weighted; fast drag continues toward the far end without opening games', async ({ page }) => {
  let openDetails = 0
  const games = Array.from({ length: 14 }, (_, i) => ({
    id: 1000 + i, igdbId: 5000 + i, title: 'Game ' + (i + 1), coverUrl: null,
  }))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (path === '/api/bootstrap') await json({
      user: { id: 701, nickname: 'inertia-qa', email: 'qa@example.test' },
      library: [], collections: [],
    })
    else if (path === '/api/saved-links') await json({ items: [{
      id: 72, title: 'Большая подборка', url: 'https://example.org/shelf',
      createdAt: '2026-10-31T09:00:00Z', games,
    }], nextBefore: null })
    else if (path.endsWith('/preview')) await json({ title: null, description: null })
    else if (path.endsWith('/thumbnail')) await route.fulfill({ status: 204, body: '' })
    else if (path.includes('/details')) { openDetails++; await json({}) }
    else await json({})
  })
  await page.goto('/?tab=links')
  const track = page.locator('.saved-link-card__matched-track')
  await expect(track).toBeVisible()
  const box = await track.boundingBox()
  if (!box) throw new Error('Missing carousel')
  const x = box.x + box.width * .73
  const y = box.y + Math.min(50, box.height / 2)
  const limits = await track.evaluate(el => ({
    max: el.scrollWidth - el.clientWidth, left: el.scrollLeft,
  }))
  expect(limits.max).toBeGreaterThan(400)
  const ptr = page.mouse
  await ptr.move(x, y)
  await ptr.down()
  await ptr.move(x - 38, y - 8, { steps: 8 })
  await page.waitForTimeout(550)
  await ptr.up()
  const afterSlow = await track.evaluate(el => el.scrollLeft)
  expect(afterSlow).toBeGreaterThan(15)
  expect(afterSlow).toBeLessThan(115)
  await ptr.move(x, y)
  await ptr.down()
  await ptr.move(x - 160, y - 38, { steps: 3 })
  await ptr.up()
  await page.waitForTimeout(1500)
  const afterFast = await track.evaluate(el => el.scrollLeft)
  expect(afterFast).toBeGreaterThan(limits.max * .8)
  expect(openDetails).toBe(0)
})
