import { test, expect } from '@playwright/test'

// Navigation is scoped to the most recent bottom-nav selection, but links
// inside a flow (including links crossing sections) retain ordinary Back.
test('mobile Back follows in-flow links but never reopens a previous bottom tab', async ({ page }) => {
  const nickname = 'backscope_' + Date.now().toString(36).slice(-8)
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
  const nav = (label: string) => page.locator('.bottom-nav__item').filter({ hasText: label })

  // Within one flow even a cross-section link is reversible:
  // database search -> game detail -> wishlist collection -> detail -> search.
  await nav('База игр').click()
  await page.getByRole('textbox', { name: 'Поиск по базе игр' }).fill('Neon')
  const game = page.getByRole('button', { name: 'Открыть игру «Neon Divide»' })
  await expect(game).toBeVisible()
  await game.click()
  await page.locator('.detail-catalog-icon--collections').click()
  await page.getByRole('button', { name: 'Открыть коллекцию «Хочу пройти»' }).click()
  await expect(page).toHaveURL(/tab=collections.*collection=/)
  await page.goBack()
  await expect(page.getByRole('button', { name: 'Вернуться назад' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('textbox', { name: 'Поиск по базе игр' })).toHaveValue('Neon')

  // Bottom nav creates a new root boundary. Back from a collection may
  // return to its list, but never to the game detail in another tab.
  await game.click()
  await nav('Коллекции').click()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await page.getByRole('button', { name: 'Хочу пройти' }).click()
  await expect(page.getByRole('button', { name: 'Вернуться к коллекциям' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await page.goBack()
  await expect(page.locator('.app-exit-toast')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await expect(page).toHaveURL(/tab=collections/)
  await expect(page).not.toHaveURL(/collection=/)

  // Switching tabs disarms the previous exit prompt; Profile is also a root.
  await nav('Профиль').click()
  await expect(page.locator('.app-exit-toast')).toHaveCount(0)
  await page.goBack()
  await expect(page.locator('.app-exit-toast')).toBeVisible()
  await expect(page).toHaveURL(/tab=profile/)

  // Re-selecting the active bottom tab from a child resets its local stack,
  // so Back should offer exit instead of resurrecting the child.
  await nav('Коллекции').click()
  await page.getByRole('button', { name: 'Хочу пройти' }).click()
  await nav('Коллекции').click()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await page.goBack()
  await expect(page.locator('.app-exit-toast')).toBeVisible()
  await expect(page).not.toHaveURL(/collection=/)
})
