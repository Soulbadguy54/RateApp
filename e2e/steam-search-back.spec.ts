import { test, expect } from '@playwright/test'

test('Steam lookup survives declined matches and native Back restores the exact preview', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rateapp-install-confirmed', 'yes'))
  const games = [889, 890].map((id, i) => ({
    id, title: i ? 'Call of Duty: Black Ops' : 'Call of Duty: Modern Warfare',
    genres: ['Шутер'], year: 2019, releaseDate: '2019-10-25', developer: 'Infinity Ward',
    platforms: ['PC'], igdbRating: 8, communityRating: 0, communityRatings: 0,
    accent: '#336699', accent2: '#223344', glyph: 'C',
  }))
  let previews = 0
  let saved = 0
  let linked = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    let data: unknown = {}
    if (path === '/api/bootstrap') data = {
      user: { id: 731, nickname: 'steam_back_qa', email: 'qa@example.test',
        avatarVersion: 0, profileTint: 'default', createdAt: '2026-11-02T00:00:00Z' },
      library: [], collections: [
        { id: 'wishlist', title: 'Хочу пройти', mark: '❤️', description: '',
          isSystem: true },
      ],
    }
    else if (path === '/api/steam/connection') data = { connected: true, steamId64: '76561198012345678' }
    else if (path === '/api/steam/overview') data = {
      steamId64: '76561198012345678', configured: true, alreadyAddedCount: 0,
      profile: { name: 'Steam QA', avatarUrl: null, profilePublic: true,
        profileUrl: 'https://steamcommunity.com/profiles/76561198012345678/' },
      gameCount: 1, canSync: true, redFlags: [], lastSyncedAt: null,
    }
    else if (path === '/api/steam/preview') {
      previews++
      data = {
        token: 'preview-12345678901234567890123456', items: [],
        unresolved: [{ appid: 809010, name: 'Call of Duty Deluxe' }],
        nextSyncAt: new Date(Date.now() + 60000).toISOString(),
      }
    }
    else if (path === '/api/games/search') data = { items: games, hasMore: false, nextOffset: null }
    else if (/^\/api\/library\/(889|890)$/.test(path) && method === 'PUT') {
      saved++
      const game = games.find(game => path.endsWith(String(game.id)))!
      data = { gameId: game.id, game, status: 'playing', platform: 'PC',
        startedAt: '2026-11-02', completedAt: null, score: null,
        atmosphereScore: null, storyScore: null, technologyScore: null,
        gameplayScore: null, review: null, steamLinked: false,
        collectionIds: [], addedAt: '2026-11-02' }
    }
    else if (path === '/api/steam/manual-match') { linked++; data = { linked: true } }
    else if (path === '/api/push/config') data = { enabled: false, publicKey: '', devices: 0 }
    else if (/^\/api\/games\/(889|890)\/details$/.test(path)) {
      data = { game: games.find(g => path.includes(String(g.id))) }
    }
    else if (/^\/api\/games\/(889|890)\/community-rating$/.test(path))
      data = { gameId: Number(path.split('/')[3]), communityRating: 0, communityRatings: 0 }
    else if (/^\/api\/games\/(889|890)\/similar$/.test(path)) data = []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })

  await page.goto('/?tab=profile')
  await page.getByRole('button', { name: 'Steam подключен, открыть настройки' }).click()
  let panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await panel.getByRole('button', { name: 'Синхронизировать' }).click()
  await expect(panel).toContainText('Нужно найти в Rate APP: 1')
  await panel.getByRole('button', { name: 'Найти в базе Rate APP: Call of Duty Deluxe' }).click()
  await expect(panel).toHaveCount(0)
  const search = page.getByRole('textbox', { name: 'Поиск по базе игр' })
  await expect(search).toHaveValue('Call of Duty Deluxe')

  for (const [index, game] of games.entries()) {
    await page.getByRole('button', { name: 'Открыть игру «' + game.title + '»' }).click()
    await page.getByRole('button', { name: 'Добавить прохождение' }).click()
    await page.locator('.choice-button--playing').click()
    await page.getByRole('button', { name: 'Сохранить в библиотеку' }).click()
    const prompt = page.getByRole('alertdialog', { name: 'Это та же игра?' })
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Call of Duty Deluxe')
    await expect(prompt).toContainText(game.title)
    await prompt.getByRole('button', { name: 'Нет, не связывать игры' }).click()
    await expect(prompt).toHaveCount(0)
    expect(linked).toBe(0)

    // Walk through actual browser history rather than selecting bottom tabs.
    for (let step = 0; step < 4 && !(await search.isVisible().catch(() => false)); step++) {
      await page.goBack()
    }
    await expect(search).toHaveValue('Call of Duty Deluxe')
    if (index === 0) await expect(page.getByRole('button', { name: 'Открыть игру «' + games[1].title + '»' })).toBeVisible()
  }
  expect(saved).toBe(2)

  await page.goBack()
  panel = page.getByRole('dialog', { name: 'Подключенный аккаунт Steam' })
  await expect(page).toHaveURL(/tab=profile/)
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Нужно найти в Rate APP: 1')
  await expect(panel).toContainText('Call of Duty Deluxe')
  expect(previews).toBe(1) // No cooldown-triggering re-preview
  await panel.getByRole('button', { name: 'Закрыть подключение Steam' }).click()
  await expect(panel).toHaveCount(0)
})
