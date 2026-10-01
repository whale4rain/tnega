import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { DEFAULT_TOOL_OFFICE_NAMES, toolOffice } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mount(): Promise<{ cwd: string, service: ToolsService, dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-tool-office-'))
  dirs.push(cwd)
  const root = new Context()
  await root.plugin(tools)
  const fiber = await root.plugin(toolOffice, { cwd })
  return { cwd, service: root.get('tools') as ToolsService, dispose: () => fiber.dispose() }
}

async function ok(service: ToolsService, name: string, input: unknown): Promise<unknown> {
  const result = await service.execute(name, input)
  expect(result.ok, result.error?.message).toBe(true)
  return result.output
}

async function fails(service: ToolsService, name: string, input: unknown): Promise<string> {
  const result = await service.execute(name, input)
  expect(result.ok).toBe(false)
  return result.error?.message ?? ''
}

const workbook = {
  sheets: [{
    name: 'Sales',
    rows: [['Region', 'Q1', 'Q2', 'Total'], ['North', 120, 80, { formula: 'SUM(B2:C2)' }]],
    styles: [{ range: 'A1:D1', style: { bold: true } }],
  }],
}

describe('office tools', () => {
  it('registers the four tools and removes them on dispose', async () => {
    const { service, dispose } = await mount()
    expect(service.list().map(tool => tool.schema.name)).toEqual(DEFAULT_TOOL_OFFICE_NAMES)
    await dispose()
    expect(service.list()).toEqual([])
  })

  it('creates, reads and edits a workbook with computed formulas', async () => {
    const { service } = await mount()
    expect(await ok(service, 'office_create', { path: 'out/sales.xlsx', spec: workbook })).toMatchObject({
      path: 'out/sales.xlsx', kind: 'xlsx', outline: { sheets: [{ name: 'Sales', range: 'A1:D2', formulas: 1 }] },
    })
    expect(await ok(service, 'office_read', { path: 'out/sales.xlsx', range: 'D2' })).toMatchObject({
      rows: [[{ formula: 'SUM(B2:C2)', value: 200 }]],
    })
    await ok(service, 'office_edit', { path: 'out/sales.xlsx', ops: [{ op: 'setCells', sheet: 'Sales', start: 'B2', rows: [[300]] }] })
    expect(await ok(service, 'office_read', { path: 'out/sales.xlsx', range: 'D2' })).toMatchObject({
      rows: [[{ formula: 'SUM(B2:C2)', value: 380 }]],
    })
  })

  it('creates and reads docx and pptx files', async () => {
    const { service } = await mount()
    await ok(service, 'office_create', {
      path: 'report.docx',
      spec: { blocks: [{ type: 'heading', level: 1, text: 'Report' }, { type: 'paragraph', text: [{ text: 'Done', bold: true }] }] },
    })
    expect(await ok(service, 'office_inspect', { path: 'report.docx' })).toMatchObject({
      kind: 'docx', outline: { headings: [{ level: 1, text: 'Report' }] },
    })
    await ok(service, 'office_create', { path: 'deck.pptx', spec: { slides: [{ title: 'Hello', bullets: ['a', 'b'] }] } })
    expect(await ok(service, 'office_read', { path: 'deck.pptx' })).toMatchObject({ total: 1, slides: [{ title: 'Hello' }] })
  })

  it('passes themes, rich styles and charts through to the files', async () => {
    const { service } = await mount()
    const created = await ok(service, 'office_create', {
      path: 'sales.xlsx',
      spec: {
        theme: { font: 'Arial', accent: '1F4E79' },
        sheets: [{
          ...workbook.sheets[0],
          merges: ['A4:D4'],
          styles: [{ range: 'A1:D1', style: { bold: true, color: 'FFFFFF', fill: '1F4E79', border: 'thin', wrap: true } }],
          charts: [{ type: 'column', categories: 'A2:A2', series: [{ values: 'B2:B2' }], at: 'F2', title: 'Q1' }],
        }],
      },
    })
    expect(created).toMatchObject({ outline: { sheets: [{ charts: [{ type: 'column', title: 'Q1', series: [{ name: 'Q1' }] }] }] } })
    await ok(service, 'office_edit', { path: 'sales.xlsx', ops: [{ op: 'addChart', sheet: 'Sales', chart: { type: 'pie', categories: 'A2:A2', series: [{ values: 'D2:D2' }], at: 'F20' } }, { op: 'autoFilter', sheet: 'Sales', range: null }] })
    expect(await ok(service, 'office_inspect', { path: 'sales.xlsx' })).toMatchObject({ outline: { sheets: [{ charts: [{ type: 'column' }, { type: 'pie' }] }] } })

    const chart = { type: 'line', title: 'Trend', categories: ['Jan', 'Feb'], series: [{ name: 'Visits', values: [3, null] }] }
    await ok(service, 'office_create', { path: 'report.docx', spec: { theme: { accent: '1F4E79' }, page: { orientation: 'landscape' }, pageNumbers: true, blocks: [{ type: 'chart', chart }] } })
    expect(await ok(service, 'office_inspect', { path: 'report.docx' })).toMatchObject({ outline: { charts: 1 } })
    await ok(service, 'office_create', { path: 'deck.pptx', spec: { theme: { font: 'Arial' }, slideNumbers: true, slides: [{ title: 'Trend', chart }] } })
    expect(await ok(service, 'office_read', { path: 'deck.pptx' })).toMatchObject({ slides: [{ charts: [{ type: 'line', title: 'Trend' }] }] })
  })

  it('reports invalid chart and style fields with their path', async () => {
    const { service } = await mount()
    expect(await fails(service, 'office_create', { path: 'a.pptx', spec: { slides: [{ chart: { type: 'radar', categories: [], series: [] } }] } }))
      .toContain('spec.slides[0].chart.type must be one of')
    expect(await fails(service, 'office_create', { path: 'a.xlsx', spec: { sheets: [{ name: 'S', styles: [{ range: 'A1', style: { border: 'dotted' } }] }] } }))
      .toContain('spec.sheets[0].styles[0].style.border')
    expect(await fails(service, 'office_create', { path: 'a.docx', spec: { page: { size: 'A3' }, blocks: [] } })).toContain('spec.page.size')
  })

  it('refuses to overwrite unless asked', async () => {
    const { service } = await mount()
    await ok(service, 'office_create', { path: 'a.xlsx', spec: workbook })
    expect(await fails(service, 'office_create', { path: 'a.xlsx', spec: workbook })).toContain('already exists')
    await ok(service, 'office_create', { path: 'a.xlsx', spec: workbook, overwrite: true })
  })

  it('reports invalid specs with the field path', async () => {
    const { service } = await mount()
    expect(await fails(service, 'office_create', { path: 'a.xlsx', spec: { sheets: [{ name: 'S', rows: [[{ value: 1 }]] }] } }))
      .toContain('spec.sheets[0].rows[0][0].formula')
    expect(await fails(service, 'office_create', { path: 'a.docx', spec: { blocks: [{ type: 'heading', level: 9, text: 'x' }] } }))
      .toContain('spec.blocks[0].level')
    expect(await fails(service, 'office_edit', { path: 'a.xlsx', ops: [{ op: 'explode' }] })).toContain('ops[0].op must be one of')
    expect(await fails(service, 'office_create', { path: 'notes.txt', spec: {} })).toContain('unsupported office file type')
  })

  it('leaves the file unchanged when an edit fails', async () => {
    const { cwd, service } = await mount()
    await ok(service, 'office_create', { path: 'a.xlsx', spec: workbook })
    const before = await readFile(join(cwd, 'a.xlsx'))
    expect(await fails(service, 'office_edit', {
      path: 'a.xlsx',
      ops: [{ op: 'setCells', sheet: 'Sales', start: 'A1', rows: [['x']] }, { op: 'deleteSheet', sheet: 'Missing' }],
    })).toContain('no sheet named "Missing"')
    expect(await readFile(join(cwd, 'a.xlsx'))).toEqual(before)
    expect(await readdir(cwd)).toEqual(['a.xlsx'])
  })

  it('keeps paths inside the workspace and rejects non-office files', async () => {
    const { cwd, service } = await mount()
    expect(await fails(service, 'office_create', { path: '../escape.xlsx', spec: workbook })).toContain('escapes the workspace')
    await writeFile(join(cwd, 'fake.xlsx'), 'not a zip')
    expect(await fails(service, 'office_read', { path: 'fake.xlsx' })).toContain('not a readable xlsx workbook')
    expect(await fails(service, 'office_edit', { path: 'deck.pptx', ops: [] })).toContain('supports .xlsx only')
  })
})
