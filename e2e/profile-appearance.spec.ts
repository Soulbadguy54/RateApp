import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('profile keeps nickname, avatar and tint inside one sticky glass panel', async ({ page }) => {
  let avatarVersion = 0
  let tint = 'default'
  let saves = 0
  const user = () => ({
    id: 416, email: 'appearance@example.test', nickname: 'appearance_qa',
    createdAt: '2026-10-30T00:00:00Z', public: true,
    avatarVersion, profileTint: tint,
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const json = (body: unknown, code = 200) => route.fulfill({
      status: code, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (pathname === '/api/bootstrap') return json({ user: user(), library: [], collections: [] })
    if (pathname === '/api/profile/appearance' && route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { tint: string; updateAvatar: boolean; avatarData?: string }
      saves++
      expect(payload.tint).toBe(['blue', 'coral', 'default'][saves - 1])
      expect(payload.updateAvatar).toBe(saves === 1)
      if (saves === 1) {
        expect((payload.avatarData ?? '').length).toBeGreaterThan(100)
        avatarVersion++
      } else {
        expect(payload.avatarData).toBeUndefined()
      }
      tint = payload.tint
      return json(user())
    }
    if (pathname === '/api/profile/avatar') return route.fulfill({ status: 404, body: '' })
    return json({})
  })
  await page.goto('/?tab=profile')
  const header = page.locator('.profile-glass-header')
  await expect(header).toBeVisible()
  await expect(header.getByRole('heading', { name: '@appearance_qa' })).toBeVisible()
  await expect(header.locator('.profile-picture')).toBeVisible()
  await expect(header.locator('.profile-top-game')).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Выбрать аватар' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Редактировать оформление профиля' })).toBeVisible()
  await header.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await expect(header.getByRole('button', { name: 'Сохранить оформление профиля' })).toBeVisible()
  const bigPencil = header.getByRole('button', { name: 'Выбрать аватар' })
  await expect(bigPencil).toBeVisible()
  await expect(bigPencil.locator('svg')).toHaveCSS('width', '72px')
  const pencilBox = await bigPencil.boundingBox()
  const avatarBox = await header.locator('.profile-glass-header__avatar-row').boundingBox()
  expect(pencilBox && avatarBox).toBeTruthy()
  expect(Math.abs(pencilBox!.x - avatarBox!.x)).toBeLessThan(2)
  expect(Math.abs(pencilBox!.y - avatarBox!.y)).toBeLessThan(2)
  await expect(header.getByRole('radio')).toHaveCount(7)
  await expect(header.getByRole('radio', { name: 'Коралловый' })).toBeVisible()
  await expect(header.getByRole('radio', { name: 'Зелёный' })).toHaveCount(0)
  await header.getByRole('radio', { name: 'Синий' }).click()
  await expect(header.getByRole('radio', { name: 'Синий' })).toHaveAttribute('aria-checked', 'true')
  await expect(header.getByRole('heading', { name: '@appearance_qa' })).toHaveCSS('color', 'rgb(113, 155, 228)')
  // Native file input uses the OS picker on the phone. Simulate its selection.
  await header.locator('input[type=file]').setInputFiles({
    name: 'profile.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zl1S3MAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(header.locator('.profile-avatar-crop img')).toBeVisible()
  await expect(header.getByRole('slider', { name: 'Масштаб аватара' })).toHaveCount(0)
  await expect(header.getByText('Перемещайте фото пальцем')).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Другое фото' })).toHaveCount(0)
  const replacePicker = page.waitForEvent('filechooser')
  await header.getByRole('button', { name: /Кадрировать аватар или нажать/ }).click()
  await (await replacePicker).setFiles({
    name: 'replacement.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zl1S3MAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(header.locator('.profile-avatar-crop img')).toBeVisible()
  await header.getByRole('button', { name: 'Сохранить оформление профиля' }).click()
  await expect(header.getByRole('button', { name: 'Редактировать оформление профиля' })).toBeVisible()
  await expect(header.getByRole('radio')).toHaveCount(0)
  await expect(page.locator('.bottom-nav__avatar img')).toHaveAttribute('src', '/api/profile/avatar?u=416&v=1')
  const navLabel = page.locator('.bottom-nav__item--profile .bottom-nav__content > span:last-child')
  await expect(navLabel).toHaveCSS('color', 'rgb(113, 155, 228)')
  // Changing only the glass tint also changes the nickname and nav label.
  await header.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await header.getByRole('radio', { name: 'Коралловый' }).click()
  await expect(header.getByRole('heading', { name: '@appearance_qa' })).toHaveCSS('color', 'rgb(238, 138, 114)')
  await header.getByRole('button', { name: 'Сохранить оформление профиля' }).click()
  await expect(navLabel).toHaveCSS('color', 'rgb(238, 138, 114)')
  // Default removes the tint overlay; green is a fallback, NOT a palette choice.
  await header.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await header.getByRole('radio', { name: 'Без оттенка' }).click()
  await header.getByRole('button', { name: 'Сохранить оформление профиля' }).click()
  await expect(header.getByRole('heading', { name: '@appearance_qa' })).toHaveCSS('color', 'rgb(140, 242, 125)')
  await expect(navLabel).toHaveCSS('color', 'rgb(140, 242, 125)')
  await expect(header).toHaveCSS('backdrop-filter', /blur\(12px\)/)
  // The remaining account content scrolls beneath the same header.
  await expect(page.getByText('Резервное копирование')).toBeVisible()
})


test('floating cloud cards only use personal completed/dropped scores and open the game detail', async ({ page }) => {
  const game = (id: number, title: string) => ({
    id, title, genres: [], year: 2025, releaseDate: '2025-01-01',
    developer: 'Example', platforms: ['PC'], igdbRating: 90,
    communityRating: 8.9, communityRatings: 100,
    accent: '#84e0ff', accent2: '#3e458d', glyph: title.slice(0, 2).toUpperCase(),
  })
  const catalogue = [
    game(101, 'Aster'), game(102, 'Gloom'), game(103, 'Beacon'),
    game(104, 'Drift'), game(105, 'Surprise'),
  ]
  const library = [
    { gameId: 101, game: catalogue[0], status: 'completed', score: 9.5 },
    { gameId: 102, game: catalogue[1], status: 'dropped', score: 9.8 },
    { gameId: 103, game: catalogue[2], status: 'completed', score: 9.1 },
    { gameId: 104, game: catalogue[3], status: 'completed', score: 9.7 },
    { gameId: 105, game: catalogue[4], status: 'playing', score: 10 },
  ].map(entry => ({
    ...entry, platform: 'PC', completedAt: '2026-10-20', startedAt: null,
    atmosphereScore: 9, storyScore: 9, technologyScore: 9, gameplayScore: 9,
    review: '', addedAt: '2026-10-20', collectionIds: [],
  }))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: { id: 417, email: 'clouds@example.test', nickname: 'clouds_qa',
          profileTint: 'default', avatarVersion: 0, createdAt: '2026-10-01T00:00:00Z' },
          library, collections: [] }
      : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/?tab=profile')
  const cards = page.locator('.profile-top-game')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toHaveAttribute('aria-label', 'Gloom, личная оценка 9.8 из 10')
  await expect(cards.nth(1)).toHaveAttribute('aria-label', 'Drift, личная оценка 9.7 из 10')
  await expect(cards.nth(2)).toHaveAttribute('aria-label', 'Aster, личная оценка 9.5 из 10')
  await expect(page.locator('.profile-top-game__score')).toHaveText(['9.8', '9.7', '9.5'])
  await expect(page.locator('.profile-glass-header__hero--ranked')).toBeVisible()
  await cards.first().click()
  await expect(page).toHaveURL(/game=102/)
})
