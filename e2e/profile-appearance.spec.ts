import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

// Cloud-picker tests are not installation-prompt tests: suppress the system
// install invitation so it cannot cover game cards during mobile taps.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rateapp-install-confirmed', 'yes'))
})

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
  // The compact security content is a separate folder tab, not a long stack.
  await expect(page.getByRole('tab', { name: 'Уведомления' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Безопасность' }).click()
  await expect(page.getByText('Резервное копирование')).toBeVisible()
  await expect(page.locator('.profile-security__row')).toHaveCount(3)
})


test('floating cloud cards only use personal completed/dropped scores and open the game detail', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
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
  await expect(page.locator('.profile-glass-header__hero')).toBeVisible()
  await expect(page.locator('.profile-top-game__score svg')).toHaveCount(0)
  const steam = page.getByRole('img', { name: 'Steam — интеграция пока не подключена' })
  await expect(steam).toBeVisible()
  await expect(page.getByRole('button', { name: /Steam/ })).toHaveCount(0)
  await expect(steam).toHaveCSS('animation-name', 'profile-steam-cloud-drift')
  await expect(steam).toHaveCSS('animation-duration', '6.1s')
  // Launch and drift must not write transform on the same element.
  await expect(page.locator('.profile-steam-cloud-launch')).toHaveCSS('animation-name', 'profile-steam-emerge')
  await expect(page.locator('.profile-top-games__item').first()).toHaveCSS('animation-name', 'profile-cloud-emerge')
  await expect(cards.first()).toHaveCSS('animation-name', 'profile-cloud-drift')
  const independent = await page.evaluate(() => {
    const cloud = document.querySelector<HTMLElement>('.profile-top-game')!
    const parent = cloud.parentElement!
    return {
      outer: getComputedStyle(parent).animationName.split(','),
      inner: getComputedStyle(cloud).animationName.split(','),
    }
  })
  expect(independent.outer).toHaveLength(1)
  expect(independent.inner).toHaveLength(1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(steam).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.profile-steam-cloud-launch')).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(steam).toHaveCSS('animation-name', 'profile-steam-cloud-drift')
  const avatarCenter = await page.locator('.profile-glass-header__avatar-row').boundingBox()
  const hero = await page.locator('.profile-glass-header__hero').boundingBox()
  expect(avatarCenter && hero).toBeTruthy()
  expect(Math.abs(avatarCenter!.x + avatarCenter!.width / 2 - hero!.x - hero!.width / 2)).toBeLessThan(2)
  // Cloud targets move continuously; force bypasses Playwright's stability wait (real taps are unaffected).
  await cards.first().click({ force: true })
  await expect(page).toHaveURL(/game=102/)
})


test('profile cloud picker stays scoped: pin any My Games entry, save, cancel and return to normal library', async ({ page }) => {
  const game = (id: number, title: string) => ({
    id, title, genres: [], year: 2025, releaseDate: '2025-01-01',
    developer: 'Example', platforms: ['PC'], igdbRating: 90,
    communityRating: 7, communityRatings: 10,
    accent: '#77ccff', accent2: '#34355d', glyph: title.slice(0, 2).toUpperCase(),
  })
  const gs = [game(501, 'Top Alpha'), game(502, 'Top Beta'),
    game(503, 'My Playing'), game(504, 'Other Pick')]
  const ratings: (number | null)[] = [9.8, 9.3, null, 8.1]
  const library = gs.map((g, i) => ({
    gameId: g.id, game: g, status: i === 2 ? 'playing' : 'completed',
    score: ratings[i], completedAt: '2026-10-01', platform: 'PC',
    atmosphereScore: 9, storyScore: 9, technologyScore: 9, gameplayScore: 9,
    review: '', addedAt: '2026-10-01', collectionIds: [],
  }))
  let pins: (number | null)[] = [null, null, null]
  let saves = 0
  const user = () => ({
    id: 418, email: 'cloud-picker@example.test', nickname: 'cloud_picker',
    profileTint: 'default', avatarVersion: 0, profileCloudGameIds: pins,
    createdAt: '2026-10-01T00:00:00Z',
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/profile/appearance' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { cloudGameIds: (number | null)[] }
      pins = body.cloudGameIds
      saves++
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user()) })
    }
    const body = path === '/api/bootstrap' ? { user: user(), library, collections: [] } : {}
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/?tab=profile')
  const edit = page.getByRole('button', { name: 'Редактировать оформление профиля' })
  const save = page.getByRole('button', { name: 'Сохранить оформление профиля' })
  await expect(page.locator('.profile-top-game')).toHaveCount(3)
  await edit.click()
  await page.getByRole('button', { name: 'Изменить игру в облаке 2' }).click({ force: true })
  const picker = page.locator('.library-cloud-picker')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('heading', { name: 'Мои игры' })).toBeVisible()
  await expect(picker.getByText('Выбери игру!', { exact: true })).toBeVisible()
  await expect(picker.getByText('Выбери игру!', { exact: true })).toHaveCSS('text-align', 'center')
  await expect(picker.getByRole('button', { name: 'Назад в профиль' })).toHaveClass(/app-back-button/)
  await expect(picker.getByRole('button', { name: 'Назад в профиль' })).toHaveCSS('width', '42px')
  await expect(picker.getByRole('button', { name: 'Добавить игру' })).toHaveCount(0)
  // Cancel picker with arrow. Profile remains in edit mode; no slot changed.
  await picker.getByRole('button', { name: 'Назад в профиль' }).click()
  await expect(save).toBeVisible()
  await page.getByRole('button', { name: 'Изменить игру в облаке 2' }).click({ force: true })
  await picker.getByRole('button', { name: 'Открыть поиск' }).click()
  await picker.getByRole('textbox', { name: 'Поиск в библиотеке' }).fill('My Playing')
  await expect(picker.locator('.game-card')).toHaveCount(1)
  await picker.locator('.game-card').click()
  await expect(save).toBeVisible()
  await expect(page.getByRole('button', { name: 'Изменить игру в облаке 2' })).toBeVisible()
  await save.click()
  await expect(page.locator('.profile-top-game')).toHaveCount(3)
  await expect(page.locator('.profile-top-game').nth(1)).toHaveAttribute('aria-label', 'My Playing')
  await expect(page.locator('.profile-top-game__score')).toHaveText(['9.8', '9.3'])
  expect(pins).toEqual([null, 503, null])
  expect(saves).toBe(1)
  // Hard reload: persisted pin wins, even when it has no personal rating.
  await page.reload()
  await expect(page.locator('.profile-top-game').nth(1)).toHaveAttribute('aria-label', 'My Playing')
  // Preview another choice, leave profile without confirming: server keeps old pin.
  await page.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await page.getByRole('button', { name: 'Изменить игру в облаке 1' }).click({ force: true })
  await picker.locator('.game-card').filter({ hasText: 'Other Pick' }).click()
  await page.locator('.bottom-nav__item').filter({ hasText: 'Мои игры' }).click()
  await expect(page.locator('.library-cloud-picker')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Добавить игру' })).toBeVisible()
  await expect(page.locator('.game-card')).toHaveCount(4)
  await page.locator('.game-card').filter({ hasText: 'Other Pick' }).click()
  await expect(page).toHaveURL(/game=504/)
  expect(saves).toBe(1)
  await page.locator('.bottom-nav__item--profile').click()
  await expect(page.locator('.profile-top-game').nth(1)).toHaveAttribute('aria-label', 'My Playing')
  await expect(page.locator('.profile-top-game').nth(0)).toHaveAttribute('aria-label', /Top Alpha/)
})


test('Control Resonant playing and rated RDR2 both pin via public IGDB IDs, not private DB IDs', async ({ page }) => {
  const games = [
    { id: 129887, title: 'Control Resonant', status: 'playing', score: null },
    { id: 7343, title: 'Red Dead Redemption 2', status: 'completed', score: 9.7 },
  ] as const
  const library = games.map((g, i) => ({
    gameId: g.id, status: g.status, score: g.score, platform: 'PC',
    completedAt: g.score == null ? null : '2026-10-01', startedAt: '2026-10-01',
    atmosphereScore: g.score, storyScore: g.score,
    technologyScore: g.score, gameplayScore: g.score,
    addedAt: '2026-10-01', collectionIds: [], review: '',
    game: { id: g.id, title: g.title, genres: [], year: 2026, releaseDate: '2026-01-01',
      developer: 'Example', platforms: ['PC'], igdbRating: 91,
      communityRating: 8.2, communityRatings: 30, accent: '#4da4f5',
      accent2: '#273858', glyph: 'G' },
  }))
  // Backend owns two internal FKs (13, 14); bootstrap deliberately exposes
  // unrelated public IGDB IDs. Fake the same server-side IGDB lookup contract.
  const internalToIgdb = new Map([[13, 129887], [14, 7343]])
  let pins: (number | null)[] = [null, null, null]
  let saves = 0
  const user = () => ({
    id: 421, email: 'clouds-public-ids@example.test', nickname: 'public_ids',
    profileTint: 'default', avatarVersion: 0,
    profileCloudGameIds: pins, createdAt: '2026-10-30T00:00:00Z',
  })
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const json = (body: unknown, code = 200) => route.fulfill({
      status: code, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (pathname === '/api/bootstrap') return json({ user: user(), library, collections: [] })
    if (pathname === '/api/profile/appearance' && route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { cloudGameIds: (number | null)[] }
      const chosen = payload.cloudGameIds.filter((id): id is number => id !== null)
      if (!chosen.every(id => [...internalToIgdb.values()].includes(id))) {
        return json({ detail: 'INVALID_CLOUD_GAME' }, 422)
      }
      pins = payload.cloudGameIds
      saves += 1
      return json(user())
    }
    return json({})
  })
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await page.getByRole('button', { name: 'Изменить игру в облаке 1' }).click({ force: true })
  const picker = page.locator('.library-cloud-picker')
  await picker.locator('.game-card').filter({ hasText: 'Control Resonant' }).click()
  await expect(page.getByRole('button', { name: 'Сохранить оформление профиля' })).toBeVisible()
  await page.getByRole('button', { name: 'Изменить игру в облаке 2' }).click({ force: true })
  await picker.locator('.game-card').filter({ hasText: 'Red Dead Redemption 2' }).click()
  await page.getByRole('button', { name: 'Сохранить оформление профиля' }).click()
  await expect(page.getByRole('button', { name: 'Редактировать оформление профиля' })).toBeVisible()
  expect(pins).toEqual([129887, 7343, null])
  expect(saves).toBe(1)
  await expect(page.getByRole('alert').filter({ hasText: 'Выбери игру из' })).toHaveCount(0)
  await expect(page.locator('.profile-top-game').nth(0)).toHaveAttribute('aria-label', 'Control Resonant')
  await expect(page.locator('.profile-top-game').nth(1)).toHaveAttribute('aria-label',
    'Red Dead Redemption 2, личная оценка 9.7 из 10')
  await page.reload()
  await expect(page.locator('.profile-top-game').nth(0)).toHaveAttribute('aria-label', 'Control Resonant')
  await expect(page.locator('.profile-top-game').nth(1)).toHaveAttribute('aria-label',
    'Red Dead Redemption 2, личная оценка 9.7 из 10')
  const steam = page.getByRole('img', { name: 'Steam — интеграция пока не подключена' })
  await expect(steam.locator('img')).toHaveAttribute('src', '/brand/steam.svg')
})
