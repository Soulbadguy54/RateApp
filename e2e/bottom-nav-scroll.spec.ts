import { expect, test } from '@playwright/test'

test('fixed bottom navigation survives a scrolled My Games to Database switch', async ({ page }) => {
  const nickname = 'navscroll_' + Date.now().toString(36).slice(-8)
  await page.goto('/')
  await page.getByRole('button', { name: 'Регистрация' }).click()
  await page.locator('input[type=email]').fill(nickname + '@example.com')
  await page.locator('input[autocomplete=username]').fill(nickname)
  const pin = '29843571'
  await page.locator('input[autocomplete=new-password]').first().fill(pin)
  await page.locator('input[autocomplete=new-password]').last().fill(pin)
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.locator('.page--library')).toBeVisible()
  const close = page.getByRole('button', { name: 'Закрыть предложение установки' })
  if (await close.isVisible()) await close.click()
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.page--library')!.style.minHeight = '230dvh'
    window.scrollTo(0, 430)
  })
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(250)
  // Measure every frame across the scroll-root change: settled geometry
  // alone would miss the unintended spring animation.
  await page.evaluate(() => {
    const fixedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(
      '.bottom-nav > button.bottom-nav__item',
    ))
    if (fixedButtons.length !== 2) throw new Error('Expected My Games and Profile buttons')
    const probe = { running: true, frames: [] as Array<{ projection: number; top: number }[]> }
    ;(window as Window & { __navMotionProbe?: typeof probe }).__navMotionProbe = probe
    const sample = () => {
      if (!probe.running) return
      probe.frames.push(fixedButtons.map(button => {
        const t = getComputedStyle(button).transform
        const matrix = new DOMMatrixReadOnly(t === 'none' ? undefined : t)
        return {
          projection: Math.max(
            Math.abs(matrix.m41), Math.abs(matrix.m42),
            Math.abs(matrix.a - 1) * 50, Math.abs(matrix.d - 1) * 50,
          ),
          top: button.getBoundingClientRect().top,
        }
      }))
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  await page.locator('.bottom-nav__item--switchable').click()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toBeVisible()
  await page.waitForTimeout(500)
  const frames = await page.evaluate(() => {
    const probe = (window as Window & { __navMotionProbe?: {
      running: boolean; frames: Array<{ projection: number; top: number }[]>
    } }).__navMotionProbe
    if (!probe) throw new Error('No navigation frame samples')
    probe.running = false
    return probe.frames
  })
  expect(frames.length).toBeGreaterThan(4)
  for (const frame of frames) {
    for (const [index, button] of frame.entries()) {
      expect(button.projection).toBeLessThan(1)
      expect(Math.abs(button.top - frames[0][index].top)).toBeLessThan(2)
    }
  }
  // The selected tab's shared active surface must still animate normally.
  await expect(page.locator('[data-nav-slot="games"] .bottom-nav__active-surface')).toBeVisible()
})
