import { test, expect } from '@playwright/test'

test('temporary 503 never masquerades as a logout', async ({ page }) => {
  await page.route('**/api/bootstrap', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Unavailable"}' }),
  )
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Сервер временно недоступен' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Повторить попытку' })).toBeVisible()

  await page.unroute('**/api/bootstrap')
  await page.getByRole('button', { name: 'Повторить попытку' }).click()
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
})

test('mobile registration, collections and account backup', async ({ page }) => {
  const nickname = 'e2e_' + Date.now().toString(36).slice(-8)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await page.getByRole('button', { name: 'Регистрация' }).click()
  await page.locator('input[type=email]').fill(nickname + '@example.com')
  await page.locator('input[autocomplete=username]').fill(nickname)
  await page.locator('input[autocomplete=new-password]').first().fill('29843571')
  await page.locator('input[autocomplete=new-password]').last().fill('29843571')
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.locator('.bottom-nav')).toBeVisible()
  // PWA install invite may appear after login. Dismiss before tapping bottom nav.
  const installClose = page.getByRole('button', { name: 'Закрыть предложение установки' })
  if (await installClose.isVisible()) await installClose.click()

  await page.locator('.bottom-nav__item').filter({ hasText: 'Коллекции' }).click()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await page.getByRole('button', { name: 'Создать коллекцию' }).first().click()
  await expect(page.getByRole('heading', { name: 'Новая коллекция' })).toBeVisible()
  await page.locator('input[placeholder="Например, Лучшие RPG"]').fill('Playwright smoke')
  await page.locator('.collection-create-submit').click()
  await expect(page.getByText('Playwright smoke').first()).toBeVisible()

  await page.locator('.bottom-nav__item').filter({ hasText: 'Профиль' }).click()
  await expect(page.getByRole('link', { name: /Скачать данные/ })).toBeVisible()
  const backup = await page.request.get('/api/export', { failOnStatusCode: true })
  const body = await backup.json()
  expect(body.format).toBe('rateapp-export')
  expect(body.nickname).toBe(nickname)
  expect(body.collections.some((c: { title: string }) => c.title === 'Playwright smoke')).toBe(true)

  // Exercise the same long-press selection and confirmed bulk-remove flow
  // that mobile users invoke, against real API + PostgreSQL.
  const collection = body.collections.find((c: { title: string }) => c.title === 'Playwright smoke')
  const added = await page.request.put(`/api/library/1/collections/${collection.id}`)
  expect(added.status()).toBe(200)
  await page.goto(`/?tab=collections&collection=${encodeURIComponent(collection.id)}`)
  await expect(page.locator('.game-card')).toHaveCount(1)
  const card = page.locator('.game-card').first()
  await card.dispatchEvent('pointerdown', { pointerId: 17, button: 0, clientX: 20, clientY: 20 })
  await expect(card).toHaveAttribute('aria-pressed', 'true', { timeout: 4000 })
  await card.dispatchEvent('pointerup', { pointerId: 17, button: 0, clientX: 20, clientY: 20 })
  await page.getByRole('button', { name: /Убрать выбранные игры из коллекции/ }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
  await expect(page.locator('.game-card')).toHaveCount(0)
  const libraryResponse = await page.request.get('/api/library')
  expect(libraryResponse.status()).toBe(200)
  expect((await libraryResponse.json()).every(
    (entry: { collectionIds: string[] }) => !entry.collectionIds.includes(collection.id)
  )).toBe(true)
})

test('search -> game -> new playthrough -> back returns to search with fresh rating', async ({ page }) => {
  const nickname = 'flow_' + Date.now().toString(36).slice(-8)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Войти' })).toBeVisible()
  await page.getByRole('button', { name: 'Регистрация' }).click()
  await page.locator('input[type=email]').fill(nickname + '@example.com')
  await page.locator('input[autocomplete=username]').fill(nickname)
  await page.locator('input[autocomplete=new-password]').first().fill('29843571')
  await page.locator('input[autocomplete=new-password]').last().fill('29843571')
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.locator('.bottom-nav')).toBeVisible()

  const installClose = page.getByRole('button', { name: 'Закрыть предложение установки' })
  if (await installClose.isVisible()) await installClose.click()

  // Force both ratings to be absent on the initial detail view; the real
  // API still handles the subsequent save and fresh community aggregate.
  await page.route('**/api/games/search?*', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({ response, json: {
      ...payload,
      items: payload.items.map((game: { title: string }) =>
        game.title === 'Neon Divide'
          ? { ...game, igdbRating: 0, communityRating: 0, communityRatings: 0 }
          : game,
      ),
    } })
  })
  await page.route('**/api/games/1/details', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({ response, json: {
      ...payload,
      game: payload.game ? { ...payload.game, igdbRating: 0 } : payload.game,
    } })
  })
  await page.route('**/api/games/1/community-rating', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ gameId: 1, communityRating: 0, communityRatings: 0 }) }),
  )

  await page.locator('.bottom-nav__item').filter({ hasText: 'База игр' }).click()
  await page.getByRole('textbox', { name: 'Поиск по базе игр' }).fill('Neon')
  const result = page.getByRole('button', { name: 'Открыть игру «Neon Divide»' })
  await expect(result).toBeVisible()
  await result.click()

  // Compact ratings keep their big scores but put the label and value on
  // the same line. Both boxes should shrink without clipping the score.
  const ratingLayout = await page.locator('.detail-rating-section').evaluate(section =>
    [...section.querySelectorAll<HTMLElement>('.detail-rating-panel')].map(panel => {
      const label = panel.querySelector<HTMLElement>('.detail-rating-panel__label')!
      const score = panel.querySelector<HTMLElement>('.detail-rating-panel__score')!
      const panelBox = panel.getBoundingClientRect()
      const labelBox = label.getBoundingClientRect()
      const scoreBox = score.getBoundingClientRect()
      return {
        height: panelBox.height,
        labelRight: labelBox.right,
        scoreLeft: scoreBox.left,
        scoreRight: scoreBox.right,
        panelRight: panelBox.right,
        centerDifference: Math.abs(
          (labelBox.top + labelBox.bottom) / 2 - (scoreBox.top + scoreBox.bottom) / 2,
        ),
      }
    }),
  )
  expect(ratingLayout).toHaveLength(2)
  for (const rating of ratingLayout) {
    expect(rating.height).toBeLessThan(70)
    expect(rating.labelRight).toBeLessThanOrEqual(rating.scoreLeft + 1)
    expect(rating.scoreRight).toBeLessThanOrEqual(rating.panelRight + 1)
    expect(rating.centerDifference).toBeLessThan(12)
  }

  // The missing score is two centered grey lines against the right edge,
  // without the former big dash or a misleading /100 or /10 suffix.
  for (const kind of ['igdb', 'community']) {
    const panel = page.locator(`.detail-rating-panel--${kind}`)
    await expect(panel).toHaveAttribute('aria-label', /нет рейтинга/)
    const empty = panel.locator('.detail-rating-panel__score--empty')
    await expect(empty.locator('span')).toHaveText(['Нет', 'рейтинга'])
    await expect(empty).toHaveCSS('color', 'rgb(140, 152, 172)')
    const geometry = await panel.evaluate(el => {
      const panelBox = el.getBoundingClientRect()
      const emptyBox = el.querySelector('.detail-rating-panel__score--empty')!.getBoundingClientRect()
      return { rightGap: panelBox.right - emptyBox.right, emptyWidth: emptyBox.width }
    })
    expect(geometry.rightGap).toBeGreaterThan(0)
    expect(geometry.rightGap).toBeLessThan(16)
    expect(geometry.emptyWidth).toBeGreaterThan(20)
  }

  // The two neutral outline icons are identically sized and exactly
  // centered. Each slow dissolve lasts 35% of a 7.2s cycle = 2.52s.
  const collectionsButton = page.locator('.detail-catalog-icon--collections')
  const layers = collectionsButton.locator('.detail-catalog-icon__symbol--layers')
  const heart = collectionsButton.locator('.detail-catalog-icon__symbol--heart')
  await expect(layers).toHaveAttribute('aria-hidden', 'true')
  await expect(heart).toHaveAttribute('aria-hidden', 'true')
  await expect(heart.locator('img')).toHaveCount(0)
  await expect(layers.locator('svg')).toHaveAttribute('width', '19')
  await expect(layers.locator('svg')).toHaveAttribute('height', '19')
  await expect(heart.locator('svg')).toHaveAttribute('width', '19')
  await expect(heart.locator('svg')).toHaveAttribute('height', '19')
  const iconGeometry = await collectionsButton.evaluate(button => {
    const a = button.querySelector('.detail-catalog-icon__symbol--layers svg')!.getBoundingClientRect()
    const b = button.querySelector('.detail-catalog-icon__symbol--heart svg')!.getBoundingClientRect()
    const layerStyle = getComputedStyle(button.querySelector('.detail-catalog-icon__symbol--layers svg')!)
    const heartStyle = getComputedStyle(button.querySelector('.detail-catalog-icon__symbol--heart svg')!)
    return {
      widthDelta: Math.abs(a.width - b.width),
      heightDelta: Math.abs(a.height - b.height),
      centerXDelta: Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2),
      centerYDelta: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2),
      sameStrokeWidth: layerStyle.getPropertyValue('stroke-width') === heartStyle.getPropertyValue('stroke-width'),
      sameFill: layerStyle.getPropertyValue('fill') === heartStyle.getPropertyValue('fill'),
    }
  })
  expect(iconGeometry.widthDelta).toBeLessThan(0.5)
  expect(iconGeometry.heightDelta).toBeLessThan(0.5)
  expect(iconGeometry.centerXDelta).toBeLessThan(0.5)
  expect(iconGeometry.centerYDelta).toBeLessThan(0.5)
  // Same outline geometry, but distinct semantic colors: the neutral
  // collections icon and the rose accent shared with wishlist.
  await expect(layers).toHaveCSS('color', 'rgb(191, 196, 215)')
  await expect(heart).toHaveCSS('color', 'rgb(255, 162, 202)')
  await expect(layers.locator('svg')).toHaveAttribute('stroke', 'currentColor')
  await expect(heart.locator('svg')).toHaveAttribute('stroke', 'currentColor')
  expect(iconGeometry.sameStrokeWidth).toBe(true)
  expect(iconGeometry.sameFill).toBe(true)
  await expect(layers).toHaveCSS('animation-name', 'detail-collections-layers')
  await expect(heart).toHaveCSS('animation-name', 'detail-collections-heart')
  await expect(layers).toHaveCSS('animation-duration', '7.2s')
  await expect(heart).toHaveCSS('animation-duration', '7.2s')
  await expect(heart).toHaveCSS('animation-timing-function', 'ease-in-out')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(layers).toHaveCSS('animation-name', 'none')
  await expect(heart).toHaveCSS('opacity', '0')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await collectionsButton.click()
  await expect(page.getByRole('region', { name: 'Управление коллекциями' })).toBeVisible()
  await collectionsButton.click()
  await expect(page.getByRole('region', { name: 'Управление коллекциями' })).toHaveCount(0)

  await page.unroute('**/api/games/search?*')
  await page.unroute('**/api/games/1/details')
  await page.unroute('**/api/games/1/community-rating')
  await page.getByRole('button', { name: 'Добавить прохождение' }).click()
  await expect(page.getByRole('heading', { name: 'Прохождение' })).toBeVisible()

  const atmosphere = page.getByRole('spinbutton', { name: 'Атмосфера' })
  await expect(atmosphere.locator('.rating-wheel__item')).toHaveCount(19)
  await atmosphere.focus()
  await page.keyboard.press('ArrowDown')
  await expect(atmosphere).toHaveAttribute('aria-valuenow', '8.5')

  // Seeded test catalog games do not always have an IGDB platform list.
  // A completed playthrough still requires an explicit platform.
  const platformInput = page.getByPlaceholder('Укажите платформу')
  if (await platformInput.isVisible()) {
    await platformInput.fill('PC')
  } else {
    await page.locator('.form-field select').first().selectOption({ index: 1 })
  }

  await page.getByRole('button', { name: 'Сохранить в библиотеку' }).click()
  await expect(page.getByRole('button', { name: 'Редактировать запись об игре' })).toBeVisible()
  const fresh = await page.request.get('/api/games/1/community-rating')
  expect(fresh.status()).toBe(200)
  const freshData = await fresh.json() as { communityRating: number; communityRatings: number }
  expect(freshData.communityRatings).toBeGreaterThanOrEqual(1)
  await expect(page.locator('.detail-rating-panel--community .detail-rating-panel__score strong'))
    .toHaveText(freshData.communityRating.toFixed(1))

  // Saving must pop back to the original game entry, not replace the form
  // with a second copy of the game in browser history.
  await page.getByRole('button', { name: 'Вернуться назад' }).click()
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toHaveValue('Neon')
  await expect(page.getByRole('button', { name: 'Открыть игру «Neon Divide»' })).toBeVisible()
})
