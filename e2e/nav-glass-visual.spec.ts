import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rateapp-install-confirmed', 'yes'))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: { id: 607, nickname: 'glass_qa', email: 'glass@example.test',
          profileTint: 'default', avatarVersion: 0, createdAt: '2026-11-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 } : {}
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
})

for (const slotName of ['games', 'collections'] as const) {
  test(slotName + ' hold menu has animated morph and exactly the nav glass', async ({ page }) => {
    await page.goto('/?tab=profile')
    const slot = page.locator('[data-nav-slot="' + slotName + '"] > button')
    await expect(slot).toBeVisible()
    const r = await slot.boundingBox()
    if (!r) throw new Error('Missing bottom nav slot')
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
    await page.mouse.down()
    const popup = page.locator('[data-nav-popup="' + slotName + '"]')
    const bubble = popup.locator('.bottom-nav__bubble')
    const surface = popup.locator('.bottom-nav__liquid-surface')
    await expect(bubble).toBeVisible({ timeout: 4000 })
    await expect(bubble).toHaveCSS('border-radius', '16px')
    await expect(bubble).toHaveCSS('border-top-color', 'rgba(175, 187, 204, 0.27)')
    await expect(popup.locator('.bottom-nav__liquid-path')).toHaveCSS('stroke', 'none')
    await expect(popup.locator('.bottom-nav__liquid-rim')).toHaveCount(0)
    // Exact material equality, including gradient, saturate and blur, not
    // merely a visually similar dark RGBA rectangle.
    const glass = await page.evaluate((slot) => {
      const bar = document.querySelector<HTMLElement>('.bottom-nav')!
      const dialog = document.querySelector<HTMLElement>('[data-nav-popup="' + slot + '"] .bottom-nav__bubble')
      return { bar: getComputedStyle(bar).backgroundImage, filter: getComputedStyle(bar).backdropFilter,
        popup: dialog ? getComputedStyle(dialog).backgroundImage : '',
        popupFilter: dialog ? getComputedStyle(dialog).backdropFilter : '',
        bodyPortal: dialog?.parentElement?.parentElement === document.body }
    }, slotName)
    expect(glass.popup).toBe(glass.bar)
    expect(glass.popupFilter).toBe(glass.filter)
    expect(glass.bodyPortal).toBe(true)
    await expect.poll(async () => Number(await surface.evaluate(el => getComputedStyle(el).opacity)), { timeout: 4000 })
      .toBeLessThan(.06)
    await page.mouse.up()
    await expect(bubble).toHaveCount(0, { timeout: 4000 })
  })
}


test('morph expands and contracts as a shape, never an early rectangular fade', async ({ page }) => {
  await page.goto('/?tab=profile')
  const slot = page.locator('[data-nav-slot="games"] > button')
  await expect(slot).toBeVisible()
  const rect = await slot.boundingBox()
  if (!rect) throw new Error('Missing navigation button')
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  await page.mouse.move(x, y)
  const sampler = (sampleCount: number) => page.evaluate(async (count) => {
    const samples: Array<{ width: number; svgOpacity: number; glassOpacity: number }> = []
    for (let i = 0; i < count; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const svg = document.querySelector<SVGSVGElement>('[data-nav-popup="games"] .bottom-nav__liquid-surface')
      const path = svg?.querySelector<SVGGraphicsElement>('.bottom-nav__liquid-path')
      const glass = document.querySelector<HTMLElement>('[data-nav-popup="games"] .bottom-nav__bubble')
      if (svg && path && glass) samples.push({
        width: path.getBBox().width,
        svgOpacity: Number(getComputedStyle(svg).opacity),
        glassOpacity: Number(getComputedStyle(glass).opacity),
      })
    }
    return samples
  }, sampleCount)
  const opening = sampler(95)
  await page.mouse.down()
  const openFrames = await opening
  expect(openFrames.some(s => s.width < 65 && s.svgOpacity > .75)).toBe(true)
  expect(openFrames.some(s => s.width > 175 && s.svgOpacity > .5)).toBe(true)
  expect(openFrames.some(s => s.width < 120 && s.glassOpacity < .08)).toBe(true)
  const closing = sampler(60)
  await page.mouse.up()
  const closeFrames = await closing
  expect(closeFrames.some(s => s.width > 175)).toBe(true)
  expect(closeFrames.some(s => s.width < 55 && s.svgOpacity > .5)).toBe(true)
  await expect(page.locator('[data-nav-popup="games"] .bottom-nav__bubble')).toHaveCount(0)
})


test('long-press drag and release still selects a floating portal choice', async ({ page }) => {
  await page.goto('/?tab=profile')
  for (const [group, targetId, resultTab] of [
    ['games', 'discovery', 'discovery'], ['collections', 'links', 'links'],
  ] as const) {
    const slot = page.locator('[data-nav-slot="' + group + '"] > button')
    const rect = await slot.boundingBox()
    if (!rect) throw new Error('Missing slot ' + group)
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.mouse.down()
    const choice = page.locator('[data-nav-popup="' + group + '"] [data-' +
      (group === 'games' ? 'game' : 'collection') + '-nav-choice="' + targetId + '"]')
    await expect(choice).toBeVisible({ timeout: 4000 })
    // Wait for the shape to finish expanding, then drag with capture retained.
    await expect.poll(async () => Number(await choice.evaluate(el => getComputedStyle(el.parentElement!).opacity)))
      .toBeGreaterThan(.9)
    const bounds = await choice.boundingBox()
    if (!bounds) throw new Error('Missing portal choice')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 9 })
    await expect(choice).toHaveAttribute('data-highlighted', 'true')
    await page.mouse.up()
    await expect(page).toHaveURL(new RegExp('tab=' + resultTab))
    await expect(page.locator('[data-nav-popup="' + group + '"] .bottom-nav__bubble')).toHaveCount(0)
  }
})

test('keyboard ArrowUp opens and Escape closes the portal without navigation', async ({ page }) => {
  await page.goto('/?tab=profile')
  const slot = page.locator('[data-nav-slot="games"] > button')
  await slot.focus()
  await page.keyboard.press('ArrowUp')
  await expect(slot).toHaveAttribute('aria-expanded', 'true')
  const choice = page.locator('[data-nav-popup="games"] [data-game-nav-choice]').first()
  await expect(choice).toBeVisible()
  await expect(choice).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(slot).toHaveAttribute('aria-expanded', 'false')
  await expect(page).toHaveURL(/tab=profile/)
})

test('Steam cloud emerges without overshoot or a competing transform', async ({ page }) => {
  await page.goto('/?tab=profile')
  const launch = page.locator('.profile-steam-cloud-launch')
  await expect(launch).toBeVisible()
  const result = await launch.evaluate(el => {
    const animation = el.getAnimations().find(item => 'animationName' in item &&
      (item as CSSAnimation).animationName === 'profile-steam-emerge')
    const frames = animation?.effect instanceof KeyframeEffect
      ? animation.effect.getKeyframes() : []
    const drift = el.querySelector('.profile-steam-cloud')
    return { frames: frames.map(frame => ({ offset: frame.offset, transform: frame.transform })),
      launchName: getComputedStyle(el).animationName,
      driftName: drift ? getComputedStyle(drift).animationName : '' }
  })
  expect(result.launchName).toBe('profile-steam-emerge')
  expect(result.driftName).toBe('profile-steam-cloud-drift')
  expect(result.frames.map(frame => frame.offset)).toEqual([0, 1])
  expect(result.frames[1].transform).toContain('scale(1)')
})
