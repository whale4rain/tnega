/**
 * What an Agent is doing right now, in a few words, from the tool call it just
 * made. It fills a thread's status line while the thread keeps no checklist,
 * so a working card says "Editing count.mjs" instead of only "Working".
 */
export function describeToolCall(name: string, args: unknown): string {
  const input = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}
  const text = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const short = (value: string, max = 48): string => {
    const line = value.replace(/\s+/g, ' ')
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  const file = (key = 'path'): string | undefined => {
    const path = text(key)
    return path ? short(path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')) : undefined
  }
  switch (name) {
    case 'read_file':
    case 'office_read':
    case 'office_inspect': {
      const target = file()
      return target ? `Reading ${target}` : 'Reading files'
    }
    case 'write_file':
    case 'edit_file':
    case 'office_create':
    case 'office_edit': {
      const target = file()
      return target ? `Editing ${target}` : 'Editing files'
    }
    case 'list_dir':
    case 'glob':
    case 'grep':
      return 'Searching the workspace'
    case 'shell':
    case 'job_start': {
      const command = text('command')
      return command ? `Running ${short(command, 40)}` : 'Running a command'
    }
    case 'http_get': {
      const url = text('url')
      try {
        return url ? `Fetching ${new URL(url).host}` : 'Fetching a page'
      } catch {
        return 'Fetching a page'
      }
    }
    case 'publish_artifact': {
      const title = text('title')
      return title ? `Publishing ${short(title)}` : 'Publishing an output'
    }
    case 'spawn_thread':
      return 'Starting a thread'
    case 'read_project':
      return 'Reading project memory'
    case 'write_memory':
      return 'Saving to project memory'
    default:
      return name.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase())
  }
}
