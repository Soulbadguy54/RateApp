import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const account = {
  id: 932, email: 'mobile-responsiveness@example.test', nickname: 'profile_tabs_qa',
  avatarVersion: 0, profileTint: 'default', createdAt: '2026-10-30T00:00:00Z',
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/bootstrap'
      ? { user: account, library: [], collections: [] }
      : path === '/api/push/config'
        ? { enabled: false, publicKey: '', devices: 0 }
        : path === '/api/push/subscription'
          ? { subscribed: false }
          : {}
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
})

test('profile settings use accessible animated folder tabs; security has exactly three rows', async ({ page }) => {
  await page.goto('/?tab=profile')
  const notifications = page.getByRole('tab', { name: 'Уведомления' })
  const security = page.getByRole('tab', { name: 'Безопасность' })
  await expect(notifications).toHaveAttribute('aria-selected', 'true')
  await expect(security).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByRole('tabpanel', { name: 'Уведомления' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Релизы игр' })).toBeVisible()
  await expect(page.locator('.profile-settings .push-settings.info-card')).toHaveCSS('border-top-style', 'solid')
  await expect(page.locator('.push-settings .eyebrow')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Выйти из аккаунта' })).toHaveCount(0)
  await expect(page.locator('.profile-settings__tab-active')).toHaveCount(1)

  await security.click()
  const panel = page.getByRole('tabpanel', { name: 'Безопасность' })
  await expect(panel).toBeVisible()
  await expect(security).toHaveAttribute('aria-selected', 'true')
  await expect(notifications).toHaveAttribute('aria-selected', 'false')
  const rows = panel.locator('.profile-security__row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Email')
  await expect(rows.nth(0)).toContainText(account.email)
  await expect(rows.nth(1)).toContainText('PIN-код')
  await expect(rows.nth(2)).toContainText('Резервное копирование')
  await expect(panel.getByRole('button', { name: /Импорт/ })).toBeDisabled()
  await expect(panel.getByRole('link', { name: /Экспорт/ })).toHaveAttribute('href', '/api/export')
  await expect(panel.getByRole('button', { name: 'Изменить' })).toHaveCount(2)
  for (const button of await panel.getByRole('button', { name: 'Изменить' }).all()) {
    await expect(button).toBeDisabled()
  }

  // Keyboard tabs follow ARIA horizontal tablist navigation.
  await security.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(notifications).toHaveAttribute('aria-selected', 'true')
  await expect(notifications).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'Уведомления' })).toBeVisible()
  await notifications.focus()
  await page.keyboard.press('End')
  await expect(security).toHaveAttribute('aria-selected', 'true')
  await expect(security).toBeFocused()
})

test('phone settings fit above navigation in idle mode, without page horizontal scroll', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const viewport of [
    { width: 320, height: 568 }, { width: 360, height: 640 },
    { width: 390, height: 844 }, { width: 430, height: 932 },
  ]) {
    await test.step(viewport.width + '×' + viewport.height, async () => {
      await page.setViewportSize(viewport)
      await page.goto('/?tab=profile')
      await expect(page.getByRole('tabpanel', { name: 'Уведомления' })).toBeVisible()
      const defaultOverflow = await page.locator('.page--viewport').evaluate(
        pane => pane.scrollHeight - pane.clientHeight)
      expect(defaultOverflow, 'Notifications at ' + viewport.width).toBeLessThanOrEqual(2)
      await page.getByRole('tab', { name: 'Безопасность' }).click()
      await expect(page.locator('.profile-security__row')).toHaveCount(3)
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.page--viewport')!
        const settings = document.querySelector<HTMLElement>('.profile-settings')!
        const version = document.querySelector<HTMLElement>('.app-build-version')!
        const nav = document.querySelector<HTMLElement>('.bottom-nav')!
        const rectangle = (el: HTMLElement) => {
          const r = el.getBoundingClientRect()
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
        }
        return {
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          scrollY: pane.scrollHeight - pane.clientHeight,
          settings: rectangle(settings),
          version: rectangle(version),
          nav: rectangle(nav),
        }
      })
      expect(geometry.scrollX).toBeLessThanOrEqual(2)
      expect(geometry.scrollY, JSON.stringify(viewport)).toBeLessThanOrEqual(2)
      expect(geometry.settings.left).toBeGreaterThanOrEqual(-1)
      expect(geometry.settings.right).toBeLessThanOrEqual(viewport.width + 1)
      expect(geometry.version.bottom).toBeLessThan(geometry.nav.top)
    })
  }
})

test('powered by IGDB stays on one line with the database title at narrow widths', async ({ page }) => {
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 740 })
    await page.goto('/?tab=add')
    const result = await page.locator('.game-database-heading__row').evaluate(row => {
      const h = row.querySelector('h1')!.getBoundingClientRect()
      const caption = row.querySelector('.game-database-powered')!.getBoundingClientRect()
      return { titleRight: h.right, captionLeft: caption.left,
        captionRight: caption.right, rowHeight: row.getBoundingClientRect().height, titleHeight: h.height }
    })
    expect(result.titleRight, String(width)).toBeLessThan(result.captionLeft)
    expect(result.rowHeight, String(width)).toBeLessThan(result.titleHeight + 4)
    expect(result.captionRight, String(width)).toBeLessThanOrEqual(width - 8)
  }
})

test('selected profile outline reaches viewport edges without double folder border', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?tab=profile')
  const tabs = page.locator('.profile-settings__tabs')
  const folder = page.locator('.profile-settings__folder')
  await expect(tabs).toHaveAttribute('data-active', 'notifications')
  await expect(folder).toHaveCSS('border-top-width', '0px')
  const geometry = await page.evaluate(() => {
    const settings = document.querySelector<HTMLElement>('.profile-settings')!
    const tab = document.querySelector<HTMLElement>('.profile-settings__tabs')!
    const r = settings.getBoundingClientRect()
    const before = getComputedStyle(tab, '::before')
    const after = getComputedStyle(tab, '::after')
    return { left: r.left, right: r.right, leftRail: parseFloat(before.width), rightRail: parseFloat(after.width) }
  })
  expect(Math.abs(geometry.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.right - 390)).toBeLessThanOrEqual(1)
  expect(geometry.leftRail).toBeGreaterThan(0)
  expect(geometry.rightRail).toBeGreaterThan(150)
  await page.getByRole('tab', { name: 'Безопасность' }).click()
  await expect(tabs).toHaveAttribute('data-active', 'security')
  await expect(tabs.locator('.profile-settings__tab-active')).toHaveCount(1)
  await expect(folder).toHaveCSS('border-top-width', '0px')
})

test('profile version hugs bottom navigation with free viewport space', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?tab=profile')
  await expect(page.locator('.app-build-version')).toBeVisible()
  const gap = await page.evaluate(() => {
    const version = document.querySelector<HTMLElement>('.app-build-version')!.getBoundingClientRect()
    const nav = document.querySelector<HTMLElement>('.bottom-nav')!.getBoundingClientRect()
    return nav.top - version.bottom
  })
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThanOrEqual(40)
})
