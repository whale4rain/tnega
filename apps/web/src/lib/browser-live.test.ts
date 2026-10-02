import { describe, expect, it } from 'vitest'
import { keyInput, parseLiveFrame, pointAt } from './browser-live'

const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  keyInput({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('browser live view', () => {
  it('types characters and presses named keys and shortcuts', () => {
    expect(key('a')).toEqual({ kind: 'text', text: 'a' })
    expect(key('A', { shiftKey: true })).toEqual({ kind: 'text', text: 'A' })
    expect(key('Enter')).toEqual({ kind: 'key', key: 'Enter' })
    expect(key('a', { ctrlKey: true })).toEqual({ kind: 'key', key: 'Control+a' })
    expect(key('ArrowLeft', { shiftKey: true })).toEqual({ kind: 'key', key: 'Shift+ArrowLeft' })
    expect(key('Shift')).toBeUndefined()
  })

  it('maps pointer positions to fractions of the frame', () => {
    expect(pointAt({ clientX: 150, clientY: 75 }, { left: 100, top: 50, width: 200, height: 100 })).toEqual({ x: 0.25, y: 0.25 })
    expect(pointAt({ clientX: 0, clientY: 999 }, { left: 100, top: 50, width: 200, height: 100 })).toEqual({ x: 0, y: 1 })
  })

  it('parses frame and state events and ignores the rest', () => {
    expect(parseLiveFrame('event: frame\ndata: {"type":"frame","data":"abc","width":1280,"height":800}')).toEqual({ type: 'frame', data: 'abc', width: 1280, height: 800 })
    expect(parseLiveFrame('data: {"type":"state","url":"http://localhost:5173/","title":"App"}')).toEqual({ type: 'state', url: 'http://localhost:5173/', title: 'App' })
    expect(parseLiveFrame('data: {"type":"other"}')).toBeUndefined()
    expect(parseLiveFrame('data: not json')).toBeUndefined()
  })
})

describe('picked elements', () => {
  const element = { url: 'http://localhost:5173/', tag: 'button', selector: '#add', text: 'Add item', html: '<button id="add">Add item</button>' }

  it('labels, describes and parses back what the user picked', async () => {
    const { describePicked, pickedLabel, splitPickedContext, parsePickResult } = await import('./browser-live')
    expect(pickedLabel(element)).toBe('<button> Add item')
    const block = describePicked(element)
    expect(block.split('\n')[0]).toBe('[Selected element on http://localhost:5173/]')
    const { contexts, rest } = splitPickedContext(`${block}\n\nMake it blue`)
    expect(contexts).toEqual([{ label: '<button> Add item', text: block }])
    expect(rest).toBe('Make it blue')
    expect(splitPickedContext('just text')).toEqual({ contexts: [], rest: 'just text' })
    expect(parsePickResult({ element, image: { data: 'abc' } })).toEqual({ element, image: { mediaType: 'image/jpeg', data: 'abc' } })
    expect(parsePickResult({ cancelled: true })).toBeUndefined()
  })
})
