import { describe, expect, it, vi } from 'vitest'
import { createWebFetchPageTool, createWebSearchTool } from '../src/index.js'

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

const run = { callId: 'c1' }

describe('web_search', () => {
  it('posts the query to the Search API and returns one entry per page', async () => {
    const fetch = fakeFetch(200, { results: [
      { title: 'Tnega', url: 'https://github.com/whale4rain/tnega', summary: 'An agent harness.', snippet: 'short', site_name: 'GitHub', date: '2026-09-28T16:00:00+00:00', rerank_score: 2.1 },
      { title: 'Same page again', url: 'https://github.com/whale4rain/tnega' },
      { url: 'https://example.com/a', snippet: 'Only a snippet' },
    ] })
    const tool = createWebSearchTool({ apiKey: 'sk-test', fetch })
    const output = await tool.execute({ query: '  tnega site:github.com ', question: 'What is tnega?', count: 99 }, run)

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test')
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'tnega site:github.com', count: 20, ori_question: 'What is tnega?' })
    expect(output).toEqual({ results: [
      { title: 'Tnega', url: 'https://github.com/whale4rain/tnega', summary: 'An agent harness.', site: 'GitHub', publishedAt: '2026-09-28T16:00:00+00:00' },
      { title: 'https://example.com/a', url: 'https://example.com/a', summary: 'Only a snippet' },
    ] })
  })

  it('rejects an over-long query and explains a missing key or a failed call', async () => {
    const tool = createWebSearchTool({ apiKey: 'sk-test', fetch: fakeFetch(200, { results: [] }) })
    await expect(tool.execute({ query: 'x'.repeat(129) }, run)).rejects.toThrow('at most 128 characters')
    await expect(createWebSearchTool({}).execute({ query: 'news' }, run)).rejects.toThrow('DEEPSEEK_API_KEY')
    const broke = createWebSearchTool({ apiKey: 'sk-test', fetch: fakeFetch(402, { error: { message: 'Insufficient Balance', type: 'payment', param: null, code: 'x' } }) })
    await expect(broke.execute({ query: 'news' }, run)).rejects.toThrow('HTTP 402): the DeepSeek account balance is too low (Insufficient Balance)')
    // A 200 that is not the documented shape is a fault, not "no hits" or an empty page.
    const garbled = vi.fn<typeof globalThis.fetch>(async () => new Response('<html>oops</html>', { status: 200 }))
    await expect(createWebSearchTool({ apiKey: 'sk-test', fetch: garbled }).execute({ query: 'news' }, run)).rejects.toThrow('invalid response body')
    await expect(createWebFetchPageTool({ apiKey: 'sk-test', fetch: garbled }).execute({ url: 'https://example.com/' }, run)).rejects.toThrow('invalid response body')
    await expect(createWebSearchTool({ apiKey: 'sk-test', fetch: fakeFetch(200, {}) }).execute({ query: 'news' }, run)).rejects.toThrow('no results list')
  })
})

describe('web_fetch', () => {
  it('reads a page as Markdown through the Fetch API and caps a long one', async () => {
    const fetch = fakeFetch(200, { title: 'Guide', content: 'a'.repeat(60_010) })
    const tool = createWebFetchPageTool({ apiKey: 'sk-test', fetch })
    const output = await tool.execute({ url: 'https://api-docs.deepseek.com/guides/search/' }, run)
    expect(fetch.mock.calls[0]![0]).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ url: 'https://api-docs.deepseek.com/guides/search/' })
    expect(output).toMatchObject({ url: 'https://api-docs.deepseek.com/guides/search/', title: 'Guide', truncated: true })
    expect(JSON.stringify(output)).toHaveLength(JSON.stringify({ url: 'https://api-docs.deepseek.com/guides/search/', title: 'Guide', content: 'a'.repeat(60_000), truncated: true }).length)
  })

  it('refuses URLs the API would reject before spending a call', async () => {
    const fetch = fakeFetch(200, {})
    const tool = createWebFetchPageTool({ apiKey: 'sk-test', fetch })
    await expect(tool.execute({ url: 'file:///etc/passwd' }, run)).rejects.toThrow('unsupported protocol')
    await expect(tool.execute({ url: 'https://user:pw@example.com/' }, run)).rejects.toThrow('credentials')
    expect(fetch).not.toHaveBeenCalled()
  })
})
