import { describe, expect, it } from 'vitest'

import { DisposableList, composeError } from '../src/index.js'

describe('DisposableList', () => {
  it('pushes values in order and removes them with the returned disposer', () => {
    const list = new DisposableList<{ id: number }>()
    const a = { id: 1 }
    const b = { id: 2 }
    const c = { id: 3 }

    list.push(a)
    const removeB = list.push(b)
    list.push(c)

    expect(list.length).toBe(3)
    expect([...list].map(item => item.id)).toEqual([1, 2, 3])

    expect(removeB()).toBe(true)
    expect(list.length).toBe(2)
    expect([...list].map(item => item.id)).toEqual([1, 3])
  })

  it('deletes a value by identity and reports absent values', () => {
    const list = new DisposableList<object>()
    const a = {}
    const b = {}

    list.push(a)
    expect(list.delete(a)).toBe(true)
    expect(list.delete(a)).toBe(false)
    expect(list.delete(b)).toBe(false)
    expect(list.length).toBe(0)
  })

  it('clear returns values in reverse order and resets the list', () => {
    const list = new DisposableList<{ id: number }>()
    list.push({ id: 1 })
    list.push({ id: 2 })
    list.push({ id: 3 })

    expect(list.clear().map(item => item.id)).toEqual([3, 2, 1])
    expect(list.length).toBe(0)
    expect([...list]).toEqual([])
    expect(list.clear()).toEqual([])
  })

  it('unshift prepends values and keeps disposer semantics', () => {
    const list = new DisposableList<{ id: number }>()
    const a = { id: 1 }
    const b = { id: 2 }
    list.push(a)
    list.unshift(b)

    expect([...list].map(item => item.id)).toEqual([2, 1])
    expect(list.delete(b)).toBe(true)
    expect([...list].map(item => item.id)).toEqual([1])
  })

  it('supports iteration and repeated cleanup', () => {
    const list = new DisposableList<symbol>()
    const a = Symbol('a')
    const b = Symbol('b')
    list.push(a)
    list.push(b)

    const seen: symbol[] = []
    for (const value of list) seen.push(value)
    expect(seen).toEqual([a, b])

    list.clear()
    list.clear()
    expect(list.length).toBe(0)
  })
})

describe('composeError', () => {
  it('returns synchronous values unchanged', () => {
    expect(composeError(() => 42)).toBe(42)
  })

  it('rethrows the same synchronous error', () => {
    const error = new Error('sync boom')
    expect(() => composeError(() => {
      throw error
    })).toThrow('sync boom')
  })

  it('rejects with the same asynchronous error', async () => {
    const error = new Error('async boom')
    await expect(composeError(async () => {
      throw error
    })).rejects.toBe(error)
  })

  it('wraps non-error rejections into an Error', async () => {
    await expect(composeError(async () => {
      throw 'plain reason'
    })).rejects.toBeInstanceOf(Error)
  })
})
