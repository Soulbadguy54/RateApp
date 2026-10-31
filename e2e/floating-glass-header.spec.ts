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
    if (path === '/api/discover/feed') return json({ items: [], remaining: 0 })
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
  const geometry = await header.evaluate(el => {
    const styles = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return {
      top: box.top, left: box.left, right: box.right,
      radius: styles.borderTopLeftRadius, topBorder: styles.borderTopWidth,
      titleSize: getComputedStyle(el.querySelector('h1')!).fontSize,
      captionSize: getComputedStyle(el.querySelector('p')!).fontSize,
      captionGap: parseFloat(getComputedStyle(el.querySelector('p')!).marginTop),
      glass: styles.backdropFilter, bg: styles.backgroundImage,
    }
  })
  expect(geometry.top).toBeGreaterThanOrEqual(-1)
  expect(geometry.top).toBeLessThan(2)
  expect(geometry.left).toBeGreaterThanOrEqual(-1)
  expect(geometry.left).toBeLessThan(2)
  expect(Math.abs(geometry.right - page.viewportSize()!.width)).toBeLessThan(2)
  expect(geometry.radius).toBe('0px')
  expect(geometry.topBorder).toBe('0px')
  expect(geometry.glass).toContain('blur(12px)')
  expect(geometry.captionSize).toBe('11px')
  expect(geometry.captionGap).toBe(4)

  // Other sections use the SAME main heading scale, including Discovery.
  await page.goto('/?tab=add')
  const catalogTitle = page.locator('.game-database-heading h1')
  await expect(catalogTitle).toBeVisible()
  await expect(catalogTitle).toHaveCSS('font-size', geometry.titleSize)
  await expect(page.locator('.game-database-powered')).toHaveCSS('margin-top', '4px')
  await page.goto('/?tab=library')
  await expect(page.locator('.library-title')).toHaveCSS('font-size', geometry.titleSize)
  await page.goto('/?tab=links')
  await expect(header).toBeVisible()
  const range = await scrollPane.evaluate(el => el.scrollHeight - el.clientHeight)
  expect(range).toBeGreaterThan(400)
  await scrollPane.evaluate(el => { el.scrollTop = 440 })
  await expect.poll(() => scrollPane.evaluate(el => el.scrollTop)).toBeGreaterThan(400)
  const sticky = await header.boundingBox()
  expect(sticky).not.toBeNull()
  expect(Math.abs(sticky!.y - initial!.y)).toBeLessThan(24)
  await page.goto('/?tab=discovery')
  await expect(page.locator('.discover-topbar__title')).toHaveCSS('font-size', geometry.titleSize)
  await expect(page.locator('.discover-topbar')).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.discover-topbar')).toHaveCSS('border-bottom-left-radius', '0px')
})
