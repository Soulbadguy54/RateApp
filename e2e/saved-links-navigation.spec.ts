import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('collections + my links reuse swipe, liquid hold menu, persistence and saved-link actions', async ({ page }) => {
  const nickname = 'links_' + Date.now().toString(36).slice(-8)
  await page.goto('/')
  await page.getByRole('button', { name: 'Регистрация' }).click()
  await page.locator('input[type=email]').fill(nickname + '@example.com')
  await page.locator('input[autocomplete=username]').fill(nickname)
  await page.locator('input[autocomplete=new-password]').first().fill('29843571')
  await page.locator('input[autocomplete=new-password]').last().fill('29843571')
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.locator('.bottom-nav')).toBeVisible()
  const closeInstall = page.getByRole('button', { name: 'Закрыть предложение установки' })
  if (await closeInstall.isVisible()) await closeInstall.click()

  const slot = page.locator('[data-nav-slot="collections"] > button')
  await expect(slot).toContainText('Коллекции')
  await slot.click()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()

  // A horizontal gesture only swaps the shortcut. It MUST NOT navigate.
  const rect = await slot.boundingBox()
  if (!rect) throw new Error('Collections/links nav cell is missing')
  await page.mouse.move(rect.x + rect.width * .75, rect.y + rect.height * .5)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width * .15, rect.y + rect.height * .5, { steps: 6 })
  await page.mouse.up()
  await expect(slot).toContainText('Мои ссылки')
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await slot.click()
  await expect(page).toHaveURL(/tab=links/)
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toBeVisible()

  const url = 'https://example.org/games-list'
  await page.getByLabel('Добавить ссылку').fill(url)
  await page.getByRole('button', { name: 'Сохранить ссылку' }).click()
  await expect(page.locator('.saved-link-card')).toHaveCount(1)
  await expect(page.locator('.saved-link-card')).toContainText('example.org')

  // Deletion needs a second explicit action. No game or user data are deleted.
  await page.getByRole('button', { name: /Удалить ссылку/ }).click()
  await expect(page.locator('.saved-link-card__delete-confirm')).toBeVisible()
  await page.getByRole('button', { name: 'Отмена' }).click()
  await expect(page.locator('.saved-link-card')).toHaveCount(1)

  // A real held press opens the same liquid shape as the database slot.
  const target = await slot.boundingBox()
  if (!target) throw new Error('Grouped nav target missing')
  await page.mouse.move(target.x + target.width * .5, target.y + target.height * .5)
  await page.mouse.down()
  await page.waitForTimeout(450)
  const collections = page.locator('[data-collection-nav-choice="collections"]')
  await expect(collections).toBeVisible()
  await expect(page.locator('[data-nav-slot="collections"] .bottom-nav__liquid-surface')).toBeVisible()
  const choice = await collections.boundingBox()
  if (!choice) throw new Error('Collections bubble target missing')
  await page.mouse.move(choice.x + choice.width / 2, choice.y + choice.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByRole('heading', { name: 'Коллекции' })).toBeVisible()
  await expect(slot).toContainText('Коллекции')

  // Arrow keys offer the existing accessible shortcut and survive reloads.
  await slot.focus()
  await page.keyboard.press('ArrowRight')
  await expect(slot).toContainText('Мои ссылки')
  await page.reload()
  await expect(slot).toContainText('Мои ссылки')
  await slot.click()
  await expect(page.locator('.saved-link-card')).toHaveCount(1)
  await page.getByRole('button', { name: /Удалить ссылку/ }).click()
  await page.locator('.saved-link-card__delete-confirm').getByRole('button', { name: 'Удалить' }).click()
  await expect(page.locator('.saved-link-card')).toHaveCount(0)
  await expect(page.getByText('Пока нет ссылок')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.app-exit-toast')).toBeVisible()
  await expect(page).toHaveURL(/tab=links/)
})
