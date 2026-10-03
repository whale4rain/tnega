/* global process, URL */
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const tokens = await readFile(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8')
const color = name => {
  const values = [...tokens.matchAll(new RegExp(`--wx-${name}:\\s*(#[0-9a-f]+)`, 'gi'))]
  if (!values.length) throw new Error(`Missing weather color ${name}`)
  return values.at(-1)[1]
}
const cloud = '<path d="M7 18a5 5 0 0 1-1-10 8 8 0 0 1 15-1 6 6 0 0 1 4 11Z"/>'
const icons = {
  rain: `<g fill="${color('rain')}">${cloud}<path d="m10 21-3 6a2 2 0 0 0 4 1l2-7Zm10 0-3 6a2 2 0 0 0 4 1l2-7Z"/></g>`,
  storm: `<g fill="${color('storm')}">${cloud}</g><path fill="${color('bolt')}" d="m17 16-8 9h6l-3 7 12-13h-7l3-3Z"/>`,
  snow: `<g fill="${color('snow')}">${cloud}<circle cx="10" cy="24" r="2.4"/><circle cx="16" cy="28" r="2.4"/><circle cx="22" cy="24" r="2.4"/></g>`,
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
