import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

// Resize the SAME Android/iOS browser contexts. This catches responsive
// breakpoints, compact heights and tall phones without multiplying every
// existing functional E2E suite by six Playwright projects.
const phones = [
  { name: 'compact 320×568', width: 320, height: 568 },
  { name: 'small 360×640', width: 360, height: 640 },
  { name: 'classic 375×667', width: 375, height: 667 },
  { name: 'modern 390×844', width: 390, height: 844 },
  { name: 'large 430×932', width: 430, height: 932 },
  { name: 'wide phone 480×900', width: 480, height: 900 },
] as const

const game = (id: number) => ({
  id, title: 'Example game ' + id, genres: [], year: 2025,
  releaseDate: '2025-01-01', developer: 'Example', platforms: ['PC'],
  igdbRating: 80, communityRating: 8, communityRatings: 10,
  accent: '#84e0ff', accent2: '#3e458d', glyph: 'EX',
})
const library = [101, 102, 103].map((id, index) => ({
  gameId: id, game: game(id), status: 'completed', score: 9.5 - index / 2,
  platform: 'PC', completedAt: '2026-10-20', startedAt: null,
  atmosphereScore: 9, storyScore: 9, technologyScore: 9, gameplayScore: 9,
  review: '', addedAt: '2026-10-20', collectionIds: [],
}))
const user = {
  id: 919, email: 'responsive@example.test', nickname: 'responsive_qa',
  createdAt: '2026-10-30T00:00:00Z', avatarVersion: 0, profileTint: 'default',
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (path === '/api/bootstrap') return json({ user, library, collections: [] })
    if (path === '/api/discover/feed') return json({ items: [], remaining: 0 })
    if (path === '/api/saved-links') return json({ items: [], nextBefore: null })
    if (path === '/api/profile/appearance' && route.request().method() === 'POST') return json(user)
    return json({})
  })
})

test('six phone viewports keep profile clouds, bottom bar and primary sections inside screen', async ({ page }) => {
  test.setTimeout(120_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const phone of phones) {
    await test.step(phone.name, async () => {
      await page.setViewportSize({ width: phone.width, height: phone.height })
      await page.goto('/?tab=profile')
      await expect(page.locator('.profile-top-game')).toHaveCount(3)
      await expect(page.locator('.profile-steam-cloud')).toBeVisible()
      const boxes = await page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        const avatar = box('.profile-glass-header__avatar-row')
        const hero = box('.profile-glass-header__hero')
        const steam = box('.profile-steam-cloud')
        const clouds = Array.from(document.querySelectorAll<HTMLElement>('.profile-top-games__item'))
          .map(element => element.getBoundingClientRect())
        const nav = box('.bottom-nav')
        const slots = Array.from(document.querySelectorAll<HTMLElement>('.bottom-nav > *'))
          .map(element => element.getBoundingClientRect())
        return {
          hero: { left: hero.left, right: hero.right },
          avatar: { x: avatar.x, width: avatar.width, right: avatar.right },
          cloudRight: Math.max(...clouds.map(cloud => cloud.right)),
          steamLeft: steam.left, steamRight: steam.right,
          nav: { y: nav.y, bottom: nav.bottom, height: nav.height },
          slots: slots.map(slot => ({ left: slot.left, right: slot.right, width: slot.width })),
        }
      })
      expect(Math.abs(boxes.avatar.x + boxes.avatar.width / 2 -
        (boxes.hero.left + boxes.hero.right) / 2)).toBeLessThan(2)
      expect(boxes.avatar.width).toBeGreaterThanOrEqual(124)
      expect(boxes.avatar.width).toBeLessThanOrEqual(177)
      expect(boxes.cloudRight).toBeLessThanOrEqual(boxes.avatar.x + 1)
      expect(boxes.steamLeft).toBeGreaterThanOrEqual(boxes.avatar.right - 1)
      expect(boxes.steamRight).toBeLessThanOrEqual(phone.width + 1)
      expect(boxes.slots).toHaveLength(4)
      for (const slot of boxes.slots) {
        expect(slot.left).toBeGreaterThanOrEqual(-1)
        expect(slot.right).toBeLessThanOrEqual(phone.width + 1)
        expect(slot.width).toBeGreaterThanOrEqual(44)
      }
      expect(boxes.nav.bottom).toBeLessThanOrEqual(phone.height + 1)
      expect(boxes.nav.y).toBeGreaterThan(0)
      expect(boxes.nav.height).toBeLessThan(phone.height / 4)

      for (const [tab, selector] of [
        ['profile', '.profile-glass-header'],
        ['library', '.library-sticky-stack'],
        ['add', '.game-database-heading'],
        ['collections', '.bottom-nav'],
        ['links', '.saved-links-header'],
        ['discovery', '.discover-topbar'],
      ]) {
        if (tab !== 'profile') await page.goto('/?tab=' + tab)
        await expect(page.locator(selector).first()).toBeVisible()
        const overflow = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          page: (() => {
            const element = document.querySelector<HTMLElement>('.page')
            return element ? element.scrollWidth - element.clientWidth : 0
          })(),
        }))
        expect(overflow.document, tab + ' at ' + phone.name).toBeLessThanOrEqual(2)
        // Explicit horizontal carousels are allowed to scroll inside their own
        // containers; the main page itself must remain viewport-width.
        expect(overflow.page, tab + ' at ' + phone.name).toBeLessThanOrEqual(2)
      }
    })
  }
})

test('avatar editing tracks its CSS diameter after phone rotation or resize', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await page.locator('.profile-file-input').setInputFiles({
    name: 'avatar.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zl1S3MAAAAASUVORK5CYII=', 'base64'),
  })
  const crop = page.locator('.profile-avatar-crop')
  await expect(crop.locator('img')).toBeVisible()
  const before = await crop.boundingBox()
  expect(before).toBeTruthy()

  await page.setViewportSize({ width: 430, height: 932 })
  await expect.poll(async () => (await crop.boundingBox())?.width ?? 0).toBeGreaterThan(before!.width + 10)
  const after = await crop.boundingBox()
  const avatar = await page.locator('.profile-glass-header__avatar-row').boundingBox()
  expect(after && avatar).toBeTruthy()
  expect(Math.abs(after!.width - avatar!.width)).toBeLessThan(1)
  expect(Math.abs(after!.height - avatar!.height)).toBeLessThan(1)

  const saveRequest = page.waitForRequest(request =>
    request.url().includes('/api/profile/appearance') && request.method() === 'POST')
  await page.getByRole('button', { name: 'Сохранить оформление профиля' }).click()
  const payload = (await saveRequest).postDataJSON() as { avatarData?: string }
  expect(payload.avatarData?.length).toBeGreaterThan(100)
})
