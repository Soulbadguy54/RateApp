import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error: Node's runtime modules are available to Vite but this frontend tsconfig omits @types/node.
import { readFileSync, writeFileSync } from 'node:fs'
// @ts-expect-error: Node's runtime modules are available to Vite but this frontend tsconfig omits @types/node.
import { fileURLToPath } from 'node:url'
import { VitePWA } from 'vite-plugin-pwa'

// The source bitmap is the user's approved frame-free icon. Embed it in SVG
// for a resolution-independent PWA icon in addition to the 192px PNG.
const publicDir = fileURLToPath(new URL('./public/', import.meta.url))
const iconPngBase64 = readFileSync(publicDir + 'rateapp-icon-192.png').toString('base64')
writeFileSync(
  publicDir + 'rateapp-icon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${iconPngBase64}"/></svg>`,
)

export default defineConfig({
  define: {
    __RATEAPP_BUILD__: JSON.stringify(
      // @ts-expect-error Environment supplied by Vercel build runtime
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ||
      // @ts-expect-error GitHub CI build sha
      process.env.GITHUB_SHA?.slice(0, 8) || 'local'
    ),
  },
  preview: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['rateapp-icon-192.png', 'rateapp-icon-512.png', 'rateapp-icon.svg', 'rateapp-loading-gamepad.avif', 'push-sw.js'],
      workbox: {
        // An old worker waiting forever to be approved can keep serving stale
        // HTML that references JS chunks deleted by a newer Vercel deployment.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api\//],
        importScripts: ['/push-sw.js'],
      },
      manifest: {
        id: '/',
        name: 'RateApp',
        short_name: 'RateApp',
        scope: '/',
        prefer_related_applications: false,
        related_applications: [
          { platform: 'webapp', url: 'https://r-app.ru/manifest.webmanifest' },
        ],
        description: 'Личная коллекция, оценки и игровой дневник',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        // Android Chromium: installed RateApp appears in the OS Share sheet.
        // Android often places URLs in `text`, not `url`.
        share_target: {
          action: '/?tab=links',
          method: 'GET',
          params: { title: 'share_title', text: 'share_text', url: 'share_url' },
        },
        icons: [
          {
            src: '/rateapp-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/rateapp-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/rateapp-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      }
    })
  ]
})
