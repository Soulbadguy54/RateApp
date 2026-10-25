import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('game nav: tap priority, hold-and-drag bubble, swipe-only pinning, history and persistence', async ({ page }) => {
  const nickname = 'nav_' + Date.now().toString(36).slice(-8)
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

  const slot = page.locator('.bottom-nav__item--switchable')
  await expect(slot).toContainText('База игр')
  await slot.click()
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()
  await expect(page.locator('.game-database-discovery-button')).toHaveCount(0)
  // IGDB slot is purple; other navigation items keep the Rate APP green.
  await expect(slot.locator('svg')).toHaveCSS('color', 'rgb(223, 182, 255)')
  await expect(page.locator('.bottom-nav__item').filter({ hasText: 'Мои игры' }).locator('svg'))
    .not.toHaveCSS('color', 'rgb(223, 182, 255)')

  // Small finger drift must still count as a normal tap, not a swipe.
  let box = await slot.boundingBox()
  if (!box) throw new Error('Switchable navigation slot missing')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 9, box.y + box.height / 2 + 4)
  await page.mouse.up()
  await expect(slot).toContainText('База игр')
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()

  // Press on the fixed navigation, keep the pointer down, travel upward into
  // the floating menu and release over the target — no second tap needed.
  box = await slot.boundingBox()
  if (!box) throw new Error('Switchable navigation slot missing')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const discovery = page.locator('[data-game-nav-choice="discovery"]')
  await expect(discovery).toBeVisible({ timeout: 3500 })
  // The actual liquid SVG background (not a faded box) shares the nav glass
  // color; the two options reuse the same icon/label and absolute cell size.
  const glass = await page.locator('.bottom-nav').evaluate(el => getComputedStyle(el).backgroundColor)
  const liquid = page.locator('.bottom-nav__liquid-path')
  await expect(liquid).toHaveCSS('fill', glass)
  await expect(page.locator('.bottom-nav__bubble')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  // The path grows from a droplet into the whole two-cell panel.
  await expect.poll(
    async () => liquid.evaluate(el => (el as SVGGraphicsElement).getBBox().width),
    { timeout: 2500 },
  ).toBeGreaterThan(180)
  const tail = await page.locator('.bottom-nav__bubble').evaluate(el => getComputedStyle(el, '::after').content)
  expect(tail).toBe('none')
  await expect(page.locator('.bottom-nav__bubble-choice .bottom-nav__content')).toHaveCount(2)
  // The bubble must rest above the nav's top border, not overlap its padding.
  await expect.poll(async () => {
    const nav = await page.locator('.bottom-nav').boundingBox()
    const menu = await page.locator('.bottom-nav__bubble').boundingBox()
    return nav && menu ? nav.y - (menu.y + menu.height) : -100
  }).toBeGreaterThanOrEqual(3)
  // Equality means the entire interactive rectangle, not merely 22px SVGs.
  const reference = await page.locator('.bottom-nav > button.bottom-nav__item').first().boundingBox()
  const choiceRect = await discovery.boundingBox()
  if (!reference || !choiceRect) throw new Error('Navigation button geometry missing')
  expect(Math.abs(choiceRect.width - reference.width)).toBeLessThan(0.5)
  expect(Math.abs(choiceRect.height - reference.height)).toBeLessThan(0.5)

  const iconSizes = await page.locator('.bottom-nav__bubble-choice svg').evaluateAll(els =>
    els.map(el => [getComputedStyle(el).width, getComputedStyle(el).height])
  )
  expect(iconSizes).toEqual([['22px', '22px'], ['22px', '22px']])
  const tint = await slot.locator('.bottom-nav__active-surface')
    .evaluate(el => getComputedStyle(el).backgroundColor)
  const bubbleTint = await page.locator('.bottom-nav__bubble-highlight')
    .evaluate(el => getComputedStyle(el).backgroundColor)
  expect(bubbleTint).toBe(tint)
  const target = await discovery.boundingBox()
  if (!target) throw new Error('Discovery bubble target missing')
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await expect(discovery).toHaveAttribute('data-highlighted', 'true')
  await page.mouse.up()
  await expect(slot).toContainText('Для тебя')
  await expect(page.locator('.discover-screen')).toBeVisible()
  await expect(page).toHaveURL(/tab=discovery/)
  await expect(page.locator('.bottom-nav__bubble')).toHaveCount(0)

  // Both destinations retain normal browser history.
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()
  await expect(slot).toContainText('Для тебя')

  // Drag/release right after the droplet appears: hit testing must use the
  // final anchor geometry, even while its visual surface is still expanding.
  box = await slot.boundingBox()
  if (!box) throw new Error('Switchable navigation slot missing')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.locator('.bottom-nav__bubble')).toBeVisible()
  const anchor = await page.locator('.bottom-nav__bubble-anchor').boundingBox()
  if (!anchor) throw new Error('Bubble anchor missing')
  await page.mouse.move(anchor.x + anchor.width * .75, anchor.y + anchor.height / 2)
  await page.mouse.up()
  await expect(page.locator('.discover-screen')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()

  // A deliberate sideways gesture changes ONLY the pinned shortcut.
  box = await slot.boundingBox()
  if (!box) throw new Error('Switchable navigation slot missing')
  await page.mouse.move(box.x + box.width * .72, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * .72 - 54, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(slot).toContainText('База игр')
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()

  await page.reload()
  await expect(slot).toContainText('База игр')
  await slot.focus()
  await page.keyboard.press('ArrowRight')
  await expect(slot).toContainText('Для тебя')
  await page.reload()
  await expect(slot).toContainText('Для тебя')
  await slot.click()
  await expect(page.locator('.discover-screen')).toBeVisible()

  // Race regression: swipe and an immediate fresh tap BEFORE React commits a
  // new render. The old time-based suppression discarded that new tap.
  await page.locator('.bottom-nav__item').filter({ hasText: 'Мои игры' }).click()
  await expect(page.locator('.page--library')).toBeVisible()
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.bottom-nav__item--switchable')
    if (!button) throw new Error('Navigation button missing')
    const b = button.getBoundingClientRect()
    const x = b.left + b.width * .76
    const y = b.top + b.height / 2
    const fire = (name: string, px: number, py: number, pointerId: number) => {
      button.dispatchEvent(new PointerEvent(name, {
        bubbles: true, cancelable: true, isPrimary: true, pointerType: 'touch',
        pointerId, button: 0, clientX: px, clientY: py,
      }))
    }
    // Switch discovery -> add by swipe, then dispatch the gesture's click.
    fire('pointerdown', x, y, 91)
    fire('pointermove', x - 54, y, 91)
    fire('pointerup', x - 54, y, 91)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    // Immediately tap again. This second click must navigate to add.
    fire('pointerdown', x, y, 92)
    fire('pointerup', x, y, 92)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
  await expect(slot).toContainText('База игр')
  await expect(page.getByRole('heading', { name: 'База игр' })).toBeVisible()
  await expect(page).not.toHaveURL(/tab=discovery/)
})

test('game nav: releasing long press on original button does not navigate', async ({ page }) => {
  const nickname = 'hold_' + Date.now().toString(36).slice(-8)
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
  const slot = page.locator('.bottom-nav__item--switchable')
  const box = await slot.boundingBox()
  if (!box) throw new Error('Switchable navigation slot missing')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.locator('.bottom-nav__bubble')).toBeVisible({ timeout: 3500 })
  await page.mouse.up()
  await expect(page.locator('.bottom-nav__bubble')).toHaveCount(0)
  await expect(page.locator('.page--library')).toBeVisible()
  await expect(slot).toContainText('База игр')
})
