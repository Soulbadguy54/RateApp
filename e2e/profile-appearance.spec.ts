import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('profile keeps nickname, avatar and tint inside one sticky glass panel', async ({ page }) => {
  let avatarVersion = 0
  let tint = 'default'
  const user = () => ({
    id: 416, email: 'appearance@example.test', nickname: 'appearance_qa',
    createdAt: '2026-10-30T00:00:00Z', public: true,
    avatarVersion, profileTint: tint,
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const json = (body: unknown, code = 200) => route.fulfill({
      status: code, contentType: 'application/json', body: JSON.stringify(body),
    })
    if (pathname === '/api/bootstrap') return json({ user: user(), library: [], collections: [] })
    if (pathname === '/api/profile/appearance' && route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { tint: string; updateAvatar: boolean; avatarData?: string }
      expect(payload.tint).toBe('blue')
      expect(payload.updateAvatar).toBe(true)
      expect((payload.avatarData ?? '').length).toBeGreaterThan(100)
      tint = payload.tint
      avatarVersion++
      return json(user())
    }
    if (pathname === '/api/profile/avatar') return route.fulfill({ status: 404, body: '' })
    return json({})
  })
  await page.goto('/?tab=profile')
  const header = page.locator('.profile-glass-header')
  await expect(header).toBeVisible()
  await expect(header.getByRole('heading', { name: '@appearance_qa' })).toBeVisible()
  await expect(header.locator('.profile-picture')).toBeVisible()
  await expect(header.getByRole('button', { name: 'Выбрать аватар' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Редактировать оформление профиля' })).toBeVisible()
  await header.getByRole('button', { name: 'Редактировать оформление профиля' }).click()
  await expect(header.getByRole('button', { name: 'Сохранить оформление профиля' })).toBeVisible()
  await expect(header.getByRole('radio')).toHaveCount(6)
  await header.getByRole('radio', { name: 'Синий' }).click()
  await expect(header.getByRole('radio', { name: 'Синий' })).toHaveAttribute('aria-checked', 'true')
  // Native file input uses the OS picker on the phone. Simulate its selection.
  await header.locator('input[type=file]').setInputFiles({
    name: 'profile.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zl1S3MAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(header.locator('.profile-avatar-crop img')).toBeVisible()
  await expect(header.getByRole('slider', { name: 'Масштаб аватара' })).toBeVisible()
  await header.getByRole('slider', { name: 'Масштаб аватара' }).evaluate(el => {
    const input = el as HTMLInputElement
    input.value = '1.7'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await header.getByRole('button', { name: 'Сохранить оформление профиля' }).click()
  await expect(header.getByRole('button', { name: 'Редактировать оформление профиля' })).toBeVisible()
  await expect(header.getByRole('radio')).toHaveCount(0)
  await expect(page.locator('.bottom-nav__avatar img')).toHaveAttribute('src', '/api/profile/avatar?u=416&v=1')
  await expect(header).toHaveCSS('backdrop-filter', /blur\(12px\)/)
  // The remaining account content scrolls beneath the same header.
  await expect(page.getByText('Резервное копирование')).toBeVisible()
})
