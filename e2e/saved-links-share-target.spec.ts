import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('Android share target accepts a URL from shared text and saves it once', async ({ page }) => {
  const nickname = 'share_' + Date.now().toString(36).slice(-8)
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

  const received: string[] = []
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/saved-links') {
      received.push(req.postData() ?? '')
    }
  })
  const shared = 'Отличная статья: https://example.com/' + nickname + '/review?a=1&b=2'
  await page.goto('/?tab=links&share_title=' + encodeURIComponent('Подборка') +
    '&share_text=' + encodeURIComponent(shared))
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toBeVisible()
  await expect(page.locator('.saved-link-card')).toHaveCount(1)
  await expect(page.getByText('Ссылка сохранена.')).toBeVisible()
  await expect(page).toHaveURL(/tab=links/)
  expect(new URL(page.url()).searchParams.has('share_text')).toBe(false)
  expect(JSON.parse(received[0])).toEqual({ url: 'https://example.com/' + nickname + '/review?a=1&b=2' })
  expect(received).toHaveLength(1)
  await page.reload()
  await expect(page.locator('.saved-link-card')).toHaveCount(1)
  expect(received).toHaveLength(1)
  await page.goto('/?tab=links&share_text=' + encodeURIComponent(shared))
  await expect(page.locator('.saved-link-card')).toHaveCount(1)
  await expect(received).toHaveLength(2)
  // The existing endpoint deduplicates owner + canonical URL.
  await expect(page.getByText('Ссылка сохранена.')).toBeVisible()
})

test('Invalid shared content opens the manual link field instead of saving', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/bootstrap'
      ? { user: { id: 781, nickname: 'share_test', email: 'share@example.test', avatarVersion: 0 }, library: [], collections: [] }
      : path === '/api/saved-links'
        ? { items: [], nextBefore: null }
        : { enabled: false, devices: 0, publicKey: '' }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  const sent: string[] = []
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/api/saved-links')) sent.push(req.url())
  })
  await page.goto('/?tab=links&share_text=' + encodeURIComponent('Просто текст без ссылки'))
  await expect(page.getByRole('heading', { name: 'Мои ссылки' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Не удалось найти адрес ссылки')
  await expect(page.getByPlaceholder('Введите ссылку')).toBeVisible()
  expect(sent).toHaveLength(0)
})
