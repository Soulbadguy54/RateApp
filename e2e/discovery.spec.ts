import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

// Playwright route mocks must not be intercepted by the installed PWA worker.
test.use({ serviceWorkers: 'block' })

async function movePointer(page: Page, fromX: number, fromY: number, toX: number, toY: number) {
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move(toX, toY, { steps: 12 })
  await page.mouse.up()
}

async function dragCover(page: Page, direction: 'left' | 'right' | 'up') {
  // With a short/wide poster the glass fills the lower stage: always begin
  // on the visible cover itself, never at an arbitrary viewport percentage.
  const art = await page.locator('.discover-cover__image, .discover-cover__fallback').boundingBox()
  if (!art) throw new Error('Discovery cover absent')
  const x = art.x + art.width * .5
  const y = art.y + Math.min(art.height * (direction === 'up' ? .78 : .28), 220)
  await movePointer(page, x, y, x + (direction === 'left' ? -160 : direction === 'right' ? 160 : 0),
    y + (direction === 'up' ? -155 : 0))
}

async function dragHandle(page: Page, delta: number, simulateTouch = false) {
  if (simulateTouch) {
    // WebKit's Mouse API does not simulate a continuous iPhone touch drag.
    // Exercise our cross-browser fallback with a continuous DOM mouse stream.
    // Native touch has a parallel onTouchStart/touchmove/touchend path in the app.
    await page.evaluate(dy => {
      const handle = document.querySelector<HTMLButtonElement>('.discover-sheet__handle')
      if (!handle) throw new Error('Sheet handle absent')
      const box = handle.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      handle.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1,
      }))
      for (let i = 1; i <= 14; i++) {
        window.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, clientX: x, clientY: y + dy * i / 14, buttons: 1,
        }))
      }
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, clientX: x, clientY: y + dy, button: 0,
      }))
    }, delta)
    return
  }
  const handle = await page.getByRole('button', { name: /подробности/i }).boundingBox()
  if (!handle) throw new Error('Sheet handle absent')
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await movePointer(page, x, y, x, y + delta)
}

test('discovery: rounded art, spring-fitted tinted glass and gentle guide blur', async ({ page }) => {
  const nickname = 'disc_' + Date.now().toString(36).slice(-8)
  const onIPhone = test.info().project.name.includes('WebKit')
  const game = (id: number, title: string) => ({
    id, title, genres: ['Action', 'RPG'], year: 2025,
    releaseDate: '2025-06-12', developer: 'Example Studio',
    platforms: ['PC', 'PlayStation 5'], igdbRating: 89,
    communityRating: 8.6, communityRatings: 3,
    accent: '#9976ec', accent2: '#32275c', glyph: 'DS',
    coverUrl: `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${id === 900000001 ? 'co123' : 'co456'}.jpg`,
    summary: 'A great story about stars.',
    storeLinks: [{ provider: 'steam', label: 'Steam', url: 'https://store.steampowered.com/app/1234' }],
    trailerUrl: null,
  })
  // Deterministic dimensions, with the NEXT poster intentionally delayed:
  // even on a slow network, the new card must not pop in half-painted.
  let releaseWidePoster: () => void = () => {}
  const wideGate = new Promise<void>(resolve => { releaseWidePoster = resolve })
  await page.route('https://images.igdb.com/igdb/image/upload/**', async route => {
    const wide = route.request().url().includes('co456')
    if (wide) await wideGate
    const width = wide ? 1000 : 600
    const height = wide ? 500 : 900
    return route.fulfill({
      status: 200, contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#7652ac"/></svg>`,
    })
  })
  const actions: string[] = []
  let releaseFeed: () => void = () => {}
  const feedGate = new Promise<void>(resolve => { releaseFeed = resolve })
  await page.route('**/api/discover/feed', async route => {
    await feedGate
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [game(900000001, 'Discovery One'), game(900000002, 'Discovery Two')], remaining: 2 }),
    })
  })
  await page.route(/\/api\/discover\/description\/\d+/, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      description: 'Это история о звёздах. '.repeat(90),
      translated: true, language: 'ru',
    }),
  }))
  await page.route('**/api/discover/feedback', async route => {
    const post = route.request().postDataJSON() as { action: string }
    actions.push(post.action)
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await page.route('**/api/discover/feedback/*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"ok":true}',
  }))
  let detailRequests = 0
  await page.route('**/api/games/*/details', route => {
    detailRequests += 1
    return route.abort()
  })
  await page.goto('/')
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
  await page.getByRole('button', { name: 'Открыть рекомендации игр' }).click()
  await expect(page.locator('.discover-screen')).toBeVisible()
  // Loading and empty states must NEVER flash a foreign dark gradient.
  await expect(page.locator('.discover-state')).toHaveCSS('background-color', await page.locator('body').evaluate(
    el => getComputedStyle(el).backgroundColor,
  ))
  releaseFeed()
  await expect(page.locator('.bottom-nav')).toBeVisible()
  await expect(page.locator('.page')).toHaveClass(/page--discovery/)
  await expect(page.locator('.bottom-nav')).toBeVisible()
  await expect(page.getByText('Discovery One')).toBeVisible()
  await expect(page.getByText('Новые игры для тебя')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Обучение рекомендациям' })).toBeVisible()
  // A first-use tutorial is plain directional text over the loaded blurred game:
  // no separate glass card, frames or a visible "Start" button.
  await expect(page.locator('.discover-guide__panel')).toHaveCount(0)
  await expect(page.locator('.discover-guide__intro')).toBeVisible()
  await expect(page.locator('.discover-guide__intro')).toContainText('Подбираем игры по твоим оценкам')
  await expect(page.locator('.discover-guide__direction')).toHaveCount(3)
  await expect(page.locator('.discover-guide__direction--left')).toContainText('Меньше похожих')
  await expect(page.locator('.discover-guide__direction--right')).toContainText('Больше похожих')
  await expect(page.locator('.discover-guide__direction--up')).toContainText('В список желаемого')
  await expect(page.locator('.discover-guide__direction--left')).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.discover-guide__intro')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.discover-guide__backdrop')).toHaveCSS('backdrop-filter', /blur\(7px\)/)
  await expect(page.locator('.discover-guide__backdrop')).toHaveCSS('background-color', 'rgba(6, 10, 23, 0.32)')
  await expect(page.getByText('Хочу поиграть').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Закрыть обучение' })).toHaveCount(1)
  // The invisible full-surface hit target accepts a tap away from all text.
  await page.locator('.discover-guide__dismiss').click({ position: { x: 18, y: 90 } })
  await expect(page.getByRole('dialog', { name: 'Обучение рекомендациям' })).toHaveCount(0)
  await expect(page.getByText('Discovery One')).toBeVisible()
  const image = page.locator('.discover-cover__image')
  await expect(image).toBeVisible()
  await expect(image).toHaveCSS('object-fit', 'contain')
  await expect(image).toHaveAttribute('src', /\/t_cover_big_2x\//)
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    await expect(image).toHaveCSS(`border-${corner}-radius`, '22px')
  }
  await expect(page.locator('.discover-cover__ambient')).toHaveCount(0)
  await expect(page.locator('.discover-cover__fade')).toHaveCount(0)
  await expect(page.locator('.discover-stage')).toHaveCSS('border-top-left-radius', '0px')
  await expect(page.locator('.discover-hint--up')).toHaveCSS('top', '10px')
  const stageRect = await page.locator('.discover-stage').boundingBox()
  await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(600)
  const coverRect = await image.boundingBox()
  const sheetRect = await page.locator('.discover-sheet').boundingBox()
  const topbarRect = await page.locator('.discover-topbar').boundingBox()
  const navbarRect = await page.locator('.bottom-nav').boundingBox()
  const viewport = page.viewportSize()
  if (!stageRect || !coverRect || !sheetRect || !topbarRect || !navbarRect || !viewport)
    throw new Error('Discovery geometry missing')
  // Exactly one poster between the real top and bottom navigation: edge-to-edge,
  // with no inherited .page left/right padding, margin or bottom gap.
  expect(Math.abs(stageRect.x)).toBeLessThan(2)
  expect(Math.abs(stageRect.width - viewport.width)).toBeLessThan(2)
  expect(Math.abs(stageRect.y - (topbarRect.y + topbarRect.height))).toBeLessThan(2)
  expect(Math.abs((stageRect.y + stageRect.height) - navbarRect.y)).toBeLessThan(2)
  // Image keeps its aspect ratio, with a deliberate 12px separation from the topbar.
  expect(coverRect.width).toBeLessThanOrEqual(stageRect.width + 1)
  expect(coverRect.height).toBeLessThanOrEqual(stageRect.height + 1)
  expect(Math.abs(coverRect.y - stageRect.y - 12)).toBeLessThan(2)
  expect(Math.abs(coverRect.width / coverRect.height - 600 / 900)).toBeLessThan(.025)
  const background = await page.locator('.discover-stage').evaluate(stage => ({
    stage: getComputedStyle(stage).backgroundColor,
    deck: getComputedStyle(stage.querySelector('.discover-deck')!).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  }))
  expect(background.stage).toBe(background.body)
  expect(background.deck).toBe(background.body)
  expect(sheetRect.height / stageRect.height).toBeGreaterThan(.98)
  expect(sheetRect.height / stageRect.height).toBeLessThan(1.02)
  // The translucent glass is anchored to the BOTTOM, independent of cover size.
  const sheetStyle = await page.locator('.discover-sheet').evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundImage, backdrop: style.backdropFilter }
  })
  expect(sheetStyle.background).toContain('0.46')
  expect(sheetStyle.backdrop).toContain('blur(12px)')
  const glassAtRest = await page.locator('.discover-sheet').boundingBox()
  if (!glassAtRest) throw new Error('Glass absent')
  // With a tall poster the minimum visible metadata may overlap the image;
  // in all cases the glass edge meets or covers its bottom, leaving no gap.
  await expect.poll(async () => {
    const art = await image.boundingBox()
    const stage = await page.locator('.discover-stage').boundingBox()
    const glass = await page.locator('.discover-sheet').boundingBox()
    const summary = await page.locator('.discover-sheet__summary-row').boundingBox()
    if (!art || !stage || !glass || !summary) return 999
    const limit = stage.y + stage.height - (33 + summary.height + 8)
    return Math.abs(glass.y - Math.min(art.y + art.height + 12, limit))
  }, { timeout: 6500 }).toBeLessThan(4)
  // Artwork never gets an ambient clone / artificial full-height dark backdrop.
  await expect(page.locator('.discover-cover')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  // The panel's fallback minimum still exposes its metadata on tall posters.
  const minRow = await page.locator('.discover-sheet__summary-row').boundingBox()
  const restGlass = await page.locator('.discover-sheet').boundingBox()
  if (!minRow || !restGlass) throw new Error('Missing panel metadata')
  expect(stageRect.y + stageRect.height - restGlass.y).toBeGreaterThanOrEqual(minRow.height + 33)
  // Hints share one synchronized 7.5-second fade cycle, not a blinking garland.
  for (const hint of await page.locator('.discover-hint').all()) {
    await expect(hint).toHaveCSS('animation-duration', '7.5s')
    await expect(hint).toHaveCSS('animation-delay', '0s')
  }
  await expect(page.locator('.discover-sheet__ratings')).toContainText('IGDB')
  await expect(page.locator('.discover-sheet__ratings')).toContainText('Rate APP')
  await expect(page.locator('.discover-actions')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Развернуть подробности' })).toHaveAttribute('aria-expanded', 'false')

  // Short pull returns to the initial sheet position.
  const posterBeforePull = await image.boundingBox()
  await dragHandle(page, -30, onIPhone)
  await expect(page.getByRole('button', { name: 'Развернуть подробности' })).toHaveAttribute('aria-expanded', 'false')
  const posterAfterPull = await image.boundingBox()
  expect(posterAfterPull?.y).toBeCloseTo(posterBeforePull?.y ?? 0, 0)
  // Short fast flicks should open and close, even below the old long-drag
  // threshold. The synthetic mouse stream also exercises WebKit fallback.
  await page.evaluate(async () => {
    const handle = document.querySelector<HTMLElement>('.discover-sheet__handle')!
    const rect = handle.getBoundingClientRect()
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, buttons: 1 }))
    for (let i = 1; i <= 6; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y - i * 13, buttons: 1 }))
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y - 78 }))
  })
  await expect(page.getByRole('button', { name: 'Свернуть подробности' })).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(async () => {
    const row = document.querySelector<HTMLElement>('.discover-sheet__summary-row')!
    const rect = row.getBoundingClientRect()
    const x = rect.left + 20, y = rect.top + 20
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, buttons: 1 }))
    for (let i = 1; i <= 6; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y + i * 13, buttons: 1 }))
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y + 78 }))
  })
  await expect(page.getByRole('button', { name: 'Развернуть подробности' })).toHaveAttribute('aria-expanded', 'false')
  // Long pull expands and reveals actual details.
  // A smaller content-wrapped peek means a longer deliberate pull is required.
  await dragHandle(page, -345, onIPhone)
  await expect(page.getByRole('button', { name: 'Свернуть подробности' })).toHaveAttribute('aria-expanded', 'true')
  // The glass, not the cover, moves upward and occludes 80% of the art.
  await expect.poll(async () => {
    const glass = await page.locator('.discover-sheet').boundingBox()
    const stage = await page.locator('.discover-stage').boundingBox()
    if (!glass || !stage) return -1
    return (stage.y + stage.height - glass.y) / stage.height
  }, { timeout: 3500 }).toBeGreaterThan(.77)
  const posterExpanded = await image.boundingBox()
  expect(posterExpanded?.y).toBeCloseTo(posterBeforePull?.y ?? 0, 0)
  const description = page.getByRole('region', { name: 'Описание игры' })
  await expect(description).toContainText('Это история о звёздах.')
  await expect(description).toHaveCSS('overflow-y', 'auto')
  await expect(page.locator('.discover-sheet__body')).toHaveCSS('overflow-y', 'hidden')
  await expect.poll(() => description.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(40)
  await description.evaluate(node => { node.scrollTop = 90 })
  await expect.poll(() => description.evaluate(node => node.scrollTop)).toBeGreaterThan(40)
  await expect(page.getByRole('button', { name: 'Свернуть подробности' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('link', { name: 'Открыть Steam' })).toHaveCount(1)
  await expect(page.locator('.discover-sheet__links img[src="/brand/steam.svg"]')).toHaveCount(1)
  const linksRect = await page.locator('.discover-sheet__links').boundingBox()
  const descRect = await description.boundingBox()
  expect(linksRect && descRect && linksRect.y + linksRect.height <= descRect.y + 1).toBeTruthy()
  expect(detailRequests).toBe(0)
  // While details are expanded, swiping the poster must not submit a like/dislike.
  await dragCover(page, 'right')
  expect(actions).toHaveLength(0)
  // Pull down from the actual metadata row rather than just the chevron.
  // This is the native large touch surface the user requested.
  if (onIPhone) {
    await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.discover-sheet__summary-row')
      if (!row) throw new Error('Missing summary row')
      const rect = row.getBoundingClientRect()
      const x = rect.left + Math.min(rect.width * .3, 65)
      const y = rect.top + rect.height / 2
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, buttons: 1 }))
      for (let i = 1; i <= 16; i++) window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: x, clientY: y + 340 * i / 16, buttons: 1,
      }))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y + 340 }))
    })
  } else {
    const row = await page.locator('.discover-sheet__summary-row').boundingBox()
    if (!row) throw new Error('Missing summary row')
    await movePointer(page, row.x + 30, row.y + row.height / 2, row.x + 30, row.y + row.height / 2 + 340)
  }
  await expect(page.getByRole('button', { name: 'Развернуть подробности' })).toHaveAttribute('aria-expanded', 'false')
  // The sheet finishes its deliberate, non-jelly snap before a new gesture.
  await page.waitForTimeout(420)

  // One uninterrupted touch must move smoothly left→right→centre; no
  // pivot jump, dead zone, 32px sticking or accidental vote on release.
  const activePoster = await page.locator('.discover-cover__image').boundingBox()
  if (!activePoster) throw new Error('Missing active cover for continuous touch')
  const touchX = activePoster.x + activePoster.width / 2
  const touchY = activePoster.y + Math.min(activePoster.height * .28, 180)
  const translationX = () => page.locator('.discover-artwork').evaluate(node => {
    return new DOMMatrixReadOnly(getComputedStyle(node).transform).m41
  })
  await page.mouse.move(touchX, touchY)
  await page.mouse.down()
  await page.mouse.move(touchX - 95, touchY, { steps: 10 })
  expect(await translationX()).toBeLessThan(-15)
  await page.mouse.move(touchX + 95, touchY, { steps: 15 })
  expect(await translationX()).toBeGreaterThan(15)
  await page.mouse.move(touchX, touchY, { steps: 10 })
  expect(Math.abs(await translationX())).toBeLessThan(10)
  await page.mouse.up()
  expect(actions).toHaveLength(0)

  // Right means LIKE, left means DISLIKE; not the reversed direction from v1.
  await dragCover(page, 'right')
  await expect(page.getByText('Discovery Two')).toBeVisible()
  await expect(page.locator('.discover-swipe-feedback--right')).toHaveCount(1)
  await expect(page.locator('.discover-swipe-feedback--right')).toHaveCSS('color', 'rgb(145, 255, 208)')
  await expect(page.locator('.discover-swipe-feedback--right')).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.discover-swipe-feedback--right')).toHaveCSS('box-shadow', 'none')
  expect(await page.locator('.discover-swipe-feedback--right').evaluate(node =>
    getComputedStyle(node, '::before').backgroundImage)).toContain('radial-gradient')
  // A pending next image is covered by the animated soft placeholder.
  await expect(page.getByTestId('poster-loading')).toBeVisible()
  await expect(page.locator('.discover-cover__image')).toHaveCSS('opacity', '0')
  releaseWidePoster()
  await expect(page.locator('.discover-cover__image')).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('poster-loading')).toHaveCount(0)
  const glowRect = await page.locator('.discover-swipe-feedback--right').boundingBox()
  const screenRect = await page.locator('.discover-screen').boundingBox()
  const navRect = await page.locator('.bottom-nav').boundingBox()
  expect(glowRect && screenRect && navRect).toBeTruthy()
  expect(Math.abs(glowRect!.y - screenRect!.y)).toBeLessThan(2)
  expect(glowRect!.y + glowRect!.height).toBeLessThanOrEqual(navRect!.y + 1)
  // Feedback lives outside the old poster and remains on the arriving card.
  await expect.poll(() => page.locator('.discover-swipe-feedback--right')
    .evaluate(node => Number(getComputedStyle(node).opacity))).toBeGreaterThan(.1)
  // Game Two is a wide poster: it must be shorter than the portrait poster
  // rather than filling the remaining screen with a fake blurred extension.
  const wideImage = page.locator('.discover-cover__image')
  await expect.poll(() => wideImage.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1000)
  const wideRect = await wideImage.boundingBox()
  const wideStage = await page.locator('.discover-stage').boundingBox()
  if (!wideRect || !wideStage) throw new Error('Wide poster geometry missing')
  expect(Math.abs(wideRect.y - wideStage.y - 12)).toBeLessThan(2)
  expect(Math.abs(wideRect.width / wideRect.height - 2)).toBeLessThan(.025)
  expect(wideStage.y + wideStage.height - (wideRect.y + wideRect.height)).toBeGreaterThan(30)
  // When the next poster is wide, the same glass springs upward to its bottom.
  await expect.poll(async () => {
    const art = await wideImage.boundingBox()
    const glass = await page.locator('.discover-sheet').boundingBox()
    return !art || !glass ? 999 : Math.abs(glass.y - (art.y + art.height + 12))
  }, { timeout: 6500 }).toBeLessThan(4)
  expect(actions).toEqual(['like'])
  await page.getByRole('button', { name: 'Шаг назад' }).click()
  await expect(page.getByText('Discovery One')).toBeVisible()
  // The persistent glass updates before AnimatePresence mounts the returned
  // poster. Wait for the actual swipe target, not just the new sheet title.
  await expect(page.locator('.discover-cover__gesture')).toHaveAttribute('aria-label', 'Свайпы для игры Discovery One')
  await expect(page.locator('.discover-deck')).toHaveCSS('opacity', '1')
  await dragCover(page, 'left')
  await expect(page.getByText('Discovery Two')).toBeVisible()
  expect(actions).toEqual(['like', 'dislike'])
  await expect(page.locator('.discover-swipe-feedback--left')).toHaveCount(1)
  // The info icon reopens the same ONE-frame onboarding.
  await page.getByRole('button', { name: 'Показать обучение' }).click()
  await expect(page.getByText('Новые игры для тебя')).toBeVisible()
  await expect(page.locator('.discover-guide__panel')).toHaveCount(0)
  await page.locator('.discover-guide__dismiss').click({ position: { x: 24, y: 220 } })
  await expect(page.getByRole('dialog', { name: 'Обучение рекомендациям' })).toHaveCount(0)
  await expect(page.getByText('Discovery Two')).toBeVisible()
  await dragCover(page, 'up')
  await expect(page.getByText('Пока всё просмотрено')).toBeVisible()
  expect(actions).toEqual(['like', 'dislike', 'wishlist'])
  await expect(page.locator('.discover-swipe-feedback--up')).toHaveCount(1)
  await page.getByRole('button', { name: 'Вернуться в базу игр' }).click()
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()
  await expect(page.locator('.bottom-nav')).toBeVisible()
})
