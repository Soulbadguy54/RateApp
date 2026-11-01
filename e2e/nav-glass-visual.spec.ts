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
