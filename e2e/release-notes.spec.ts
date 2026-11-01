import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rateapp-install-confirmed', 'yes'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/bootstrap'
      ? { user: { id: 936, nickname: 'releases_qa', email: 'qa@example.test',
          profileTint: 'violet', avatarVersion: 0, createdAt: '2026-10-01T00:00:00Z' },
          library: [], collections: [] }
      : path === '/api/steam/connection' ? { connected: false, steamId64: null }
      : path === '/api/push/config' ? { enabled: false, publicKey: '', devices: 0 }
      : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
})

test('public version number opens business-only notes and arrows browse production batches', async ({ page }) => {
  await page.goto('/?tab=profile')
  const version = page.getByRole('button', { name: 'История обновлений, версия 26.11.001' })
  await expect(version).toBeVisible()
  await expect(version.locator('span')).toHaveText('26.11.001')
  const header = page.locator('.profile-glass-header.topbar')
  await expect(header).toHaveCSS('border-top-width', '0px')
  await expect(header).toHaveCSS('border-top-left-radius', '0px')
  await page.locator('.page--viewport').evaluate(node => { node.scrollTop = node.scrollHeight })
  const footerGap = await page.evaluate(() => {
    const version = document.querySelector('.app-build-version__trigger')!.getBoundingClientRect()
    const nav = document.querySelector('.bottom-nav')!.getBoundingClientRect()
    return nav.top - version.bottom
  })
  expect(footerGap).toBeGreaterThanOrEqual(0)
  expect(footerGap).toBeLessThan(86)
  await version.click()

  const dialog = page.getByRole('dialog', { name: 'История обновлений' })
  const previous = dialog.getByRole('button', { name: 'Предыдущая версия' })
  const next = dialog.getByRole('button', { name: 'Следующая версия' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.release-notes__version strong')).toHaveText('26.11.001')
  await expect(dialog).toContainText('Подключение Steam')
  await expect(dialog).toContainText('Мои ссылки')
  await expect(dialog).not.toContainText('Rate APP</span>')
  await expect(dialog).not.toContainText('миграц')
  await expect(dialog).not.toContainText('GitHub')
  await expect(next).toBeDisabled()

  await previous.click()
  await expect(dialog.locator('.release-notes__version strong')).toHaveText('26.10.012')
  await expect(dialog).toContainText('Все октябрьские обновления')
  await expect(dialog).toContainText('персональными рекомендациями')
  await expect(dialog).toContainText('собственные коллекции')
  await expect(previous).toBeDisabled()
  await next.click()
  await expect(dialog.locator('.release-notes__version strong')).toHaveText('26.11.001')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(version).toBeFocused()
})

test('version history consumes native Back without leaving the profile', async ({ page }) => {
  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'История обновлений, версия 26.11.001' }).click()
  const dialog = page.getByRole('dialog', { name: 'История обновлений' })
  await expect(dialog).toBeVisible()
  await page.evaluate(() => {
    const back = new Event('rateapp:cancel-transient', { cancelable: true })
    window.dispatchEvent(back)
    if (!back.defaultPrevented) throw new Error('Version dialog did not consume Back')
  })
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/tab=profile/)
})
