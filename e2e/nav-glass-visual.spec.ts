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
  test(slotName + ' hold menu has stable gray border, symmetric corners and strong live blur', async ({ page }) => {
    await page.goto('/?tab=profile')
    const slot = page.locator('[data-nav-slot="' + slotName + '"] > button')
    await expect(slot).toBeVisible()
    const r = await slot.boundingBox()
    if (!r) throw new Error('Missing bottom nav slot')
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
    await page.mouse.down()
    const bubble = page.locator('[data-nav-slot="' + slotName + '"] .bottom-nav__bubble')
    const surface = page.locator('[data-nav-slot="' + slotName + '"] .bottom-nav__liquid-surface')
    await expect(bubble).toBeVisible({ timeout: 4000 })
    const background = await page.locator('.bottom-nav').evaluate(el => getComputedStyle(el).backgroundImage)
    await expect(bubble).toHaveCSS('background-image', background)
    await expect(bubble).toHaveCSS('border-radius', '16px')
    await expect(bubble).toHaveCSS('border-top-color', 'rgba(180, 193, 210, 0.25)')
    await expect(bubble).toHaveCSS('backdrop-filter', /blur\(32px\)/)
    await expect(page.locator('[data-nav-slot="' + slotName + '"] .bottom-nav__liquid-path')).toHaveCSS('stroke', 'none')
    await expect(page.locator('[data-nav-slot="' + slotName + '"] .bottom-nav__liquid-rim')).toHaveCount(0)
    await expect.poll(async () => Number(await surface.evaluate(el => getComputedStyle(el).opacity)), { timeout: 4000 })
      .toBeLessThan(.06)
    await page.mouse.up()
    await expect(bubble).toHaveCount(0, { timeout: 4000 })
  })
}

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

test('nav liquid grows from the droplet and retracts through intermediate silhouettes', async ({ page }) => {
  await page.goto('/?tab=profile')
  const slot = page.locator('[data-nav-slot="games"] > button')
  const box = await slot.boundingBox()
  if (!box) throw new Error('Missing slot')
  await page.evaluate(() => {
    const frames: { width: number; opacity: number }[] = []
    ;(window as Window & { __steamNavMorphFrames?: typeof frames }).__steamNavMorphFrames = frames
    const started = performance.now()
    const sample = () => {
      const surface = document.querySelector<SVGSVGElement>('.bottom-nav__liquid-surface')
      const shape = surface?.querySelector<SVGGraphicsElement>('.bottom-nav__liquid-path')
      if (surface && shape) frames.push({
        width: shape.getBBox().width,
        opacity: Number(getComputedStyle(surface).opacity),
      })
      if (performance.now() - started < 2700) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const liquid = page.locator('[data-nav-slot="games"] .bottom-nav__liquid-surface')
  await expect(liquid).toBeVisible({ timeout: 4000 })
  await expect.poll(async () => liquid.evaluate(el =>
    (el.querySelector('path') as SVGGraphicsElement).getBBox().width), { timeout: 3000 }).toBeGreaterThan(185)
  await page.mouse.up()
  await expect(liquid).toHaveCount(0, { timeout: 3000 })
  const frames = await page.evaluate(() => (window as Window & {
    __steamNavMorphFrames?: Array<{ width: number; opacity: number }>
  }).__steamNavMorphFrames ?? [])
  expect(frames.some(frame => frame.width < 85 && frame.opacity > .35)).toBe(true)
  expect(frames.some(frame => frame.width > 175 && frame.opacity > .35)).toBe(true)
})
