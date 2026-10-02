/* global URL, Buffer, console, process */
// Render build/icon.svg to build/icon.png (1024px) and a multi-size build/icon.ico.
// Run: node apps/desktop/scripts/render-icon.mjs  (uses the system Edge/Chrome via playwright-core)
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const build = new URL('../build/', import.meta.url)
const svg = await readFile(new URL('icon.svg', build), 'utf8')
const channel = process.platform === 'win32' ? 'msedge' : 'chrome'
const browser = await chromium.launch({ channel, headless: true }).catch(() => chromium.launch({ headless: true }))
const page = await browser.newPage()

async function render(size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
  return page.screenshot({ omitBackground: true, type: 'png', clip: { x: 0, y: 0, width: size, height: size } })
}

await writeFile(new URL('icon.png', build), await render(1024))

// ICO with PNG-compressed layers (supported since Windows Vista).
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = []
for (const size of sizes) images.push(await render(size))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, index) => {
  const entry = 6 + index * 16
  header[entry] = size === 256 ? 0 : size
  header[entry + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(images[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += images[index].length
})
await writeFile(new URL('icon.ico', build), Buffer.concat([header, ...images]))
await browser.close()
console.log(`wrote ${fileURLToPath(new URL('icon.png', build))} and icon.ico (${sizes.join(', ')})`)
