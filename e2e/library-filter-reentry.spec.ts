import { expect, test } from '@playwright/test'

test('My Games filters reset on PWA re-entry, not on in-app tab changes', async ({ page }) => {
  const nickname = 'filters_' + Date.now().toString(36).slice(-8)
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
  const tab = (label: string) => page.locator('.bottom-nav__item').filter({ hasText: label })

  await tab('Мои игры').click()
  const completed = page.locator('.library-status-card--completed')
  const filters = page.getByRole('button', { name: 'Фильтры библиотеки' })
  const sort = page.getByRole('combobox', { name: 'Сортировка' })
  await expect(completed).toBeVisible()
  await completed.click()
  await expect(completed).toHaveAttribute('aria-pressed', 'true')
  await sort.selectOption('title')

  // Navigation within the still-open app must not discard My Games filters.
  await tab('Коллекции').click()
  await tab('Мои игры').click()
  await expect(completed).toHaveAttribute('aria-pressed', 'true')
  await expect(sort).toHaveValue('title')
  await filters.click()
  await expect(filters).toHaveAttribute('aria-expanded', 'true')

  // The app may remain mounted when the user backgrounds and reopens the PWA.
  // Drive the browser lifecycle explicitly, without reloading React.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(completed).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    Reflect.deleteProperty(document, 'visibilityState')
  })
  await expect(completed).toHaveAttribute('aria-pressed', 'false')
  await expect(filters).toHaveAttribute('aria-expanded', 'false')
  // Sorting is not a filter; no need to disturb it on a resume.
  await expect(sort).toHaveValue('title')

  // Back/forward cache restores also count as re-entry (not an initial pageshow).
  await completed.click()
  await page.evaluate(() => {
    const show = new Event('pageshow')
    Object.defineProperty(show, 'persisted', { value: true })
    window.dispatchEvent(show)
  })
  await expect(completed).toHaveAttribute('aria-pressed', 'false')

  // Fully loading the PWA again already gets the normal initial filter state.
  await completed.click()
  await page.reload()
  await expect(completed).toHaveAttribute('aria-pressed', 'false')
})
