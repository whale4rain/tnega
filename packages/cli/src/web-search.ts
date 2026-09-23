import type { ToolDefinition } from '@tnega/tools'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** A DeepSeek native search call; only structured source blocks become tool output. */
export function webSearchTool(apiKey: string | undefined): ToolDefinition {
  return {
    schema: {
      name: 'web_search',
      description: 'Search the public web for current information. Returns cited source titles and URLs. Requires a DeepSeek search credential.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
      },
    },
    async execute(input, options) {
      const args = record(input)
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (!query) throw new TypeError('query is required')
      if (!apiKey) throw new Error('web_search requires DEEPSEEK_API_KEY or a DeepSeek model credential')
      const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          max_tokens: 2048,
          messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for: ${query}` }] }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!response.ok) throw new Error(`web_search provider returned HTTP ${response.status}`)
      const payload = record(await response.json())
      const blocks = Array.isArray(payload?.content) ? payload.content : []
      const sources: Array<{ title: string; url: string; publishedAt?: string }> = []
      const seen = new Set<string>()
      for (const value of blocks) {
        const block = record(value)
        if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
        for (const item of block.content) {
          const source = record(item)
          if (source?.type !== 'web_search_result' || typeof source.url !== 'string'
            || seen.has(source.url)) continue
          seen.add(source.url)
          sources.push({
            title: typeof source.title === 'string' ? source.title : source.url,
            url: source.url,
            ...(typeof source.page_age === 'string' ? { publishedAt: source.page_age } : {}),
          })
        }
      }
      if (!sources.length) throw new Error('web_search provider returned no structured search results')
      return { sources: sources.slice(0, 8) }
    },
  }
}
