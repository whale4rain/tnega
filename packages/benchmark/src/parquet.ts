import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

export async function downloadParquet(
  url: string,
  file: string,
  force: boolean,
): Promise<void> {
  try {
    await access(file)
    if (!force) return
  } catch {
    // file missing, download below
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

export async function readParquetRows<T>(file: string): Promise<T[]> {
  const buffer = await asyncBufferFromFile(file)
  const rows = await parquetReadObjects({ file: buffer })
  return rows as T[]
}
