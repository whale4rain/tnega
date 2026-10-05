/* global process, URL */
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const tokens = await readFile(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8')
const color = name => {
  const values = [...tokens.matchAll(new RegExp(`--wx-${name}:\\s*(#[0-9a-f]+)`, 'gi'))]
  if (!values.length) throw new Error(`Missing weather color ${name}`)
  return values.at(-1)[1]
}
// The app icon is already the cloud, so a badge carries only the weather on a
// small dark disc: one cloud on the taskbar, legible on light and dark bars.
const disc = '<circle cx="16" cy="16" r="15" fill="#1f2531"/>'
const drop = 'c3 4.5 5 7.4 5 10a5 5 0 0 1-10 0c0-2.6 2-5.5 5-10Z'
const icons = {
  rain: `${disc}<g fill="${color('rain')}"><path d="M12 7${drop}"/><path d="M20.5 11${drop}"/></g>`,
  storm: `${disc}<path fill="${color('bolt')}" d="M18.5 5 9 18h6l-2.5 9L23 14h-6.2Z"/>`,
  snow: `${disc}<g stroke="${color('snow')}" stroke-width="2.6" stroke-linecap="round"><path d="M16 7v18M8.2 11.5l15.6 9M8.2 20.5l15.6-9"/></g>`,
}
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 32, height: 32 } })
  for (const [name, graphic] of Object.entries(icons)) {
    await page.setContent(`<body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${graphic}</svg></body>`)
    await writeFile(new URL(`../build/completion-${name}.png`, import.meta.url), await page.screenshot({ omitBackground: true }))
  }
} finally {
  await browser.close()
}
