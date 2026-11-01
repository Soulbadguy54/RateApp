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
  await page.locator('.bottom-nav__item--switchable').click()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toBeVisible()
  await expect(page.locator('[data-nav-slot="games"] .bottom-nav__active-surface')).toBeVisible()
})
