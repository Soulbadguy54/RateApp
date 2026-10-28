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

  // The ❤️ is only a visual cue on the existing collections button:
  // clicking anywhere on that button still opens the collection picker.
  const collectionsButton = page.locator('.detail-catalog-icon--collections')
  await expect(collectionsButton.locator('.detail-catalog-icon__heart')).toHaveText('❤️')
  await expect(collectionsButton.locator('.detail-catalog-icon__heart')).toHaveAttribute('aria-hidden', 'true')
  await collectionsButton.click()
  await expect(page.getByRole('region', { name: 'Управление коллекциями' })).toBeVisible()
  await collectionsButton.click()
  await expect(page.getByRole('region', { name: 'Управление коллекциями' })).toHaveCount(0)

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
