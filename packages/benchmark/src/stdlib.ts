export const STDLIB = new Set([
  'abc',
  'argparse',
  'array',
  'asyncio',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'calendar',
  'cmath',
  'collections',
  'configparser',
  'concurrent',
  'contextlib',
  'contextvars',
  'copy',
  'csv',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'dis',
  'doctest',
  'enum',
  'errno',
  'fnmatch',
  'fractions',
  'functools',
  'gc',
  'glob',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'logging',
  'math',
  'marshal',
  'mmap',
  'multiprocessing',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pickle',
  'platform',
  'pprint',
  'queue',
  'random',
  're',
  'reprlib',
  'select',
  'shelve',
  'shutil',
  'signal',
  'socket',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'struct',
  'subprocess',
  'sys',
  'tarfile',
  'tempfile',
  'textwrap',
  'threading',
  'time',
  'token',
  'tokenize',
  'traceback',
  'types',
  'typing',
  'unittest',
  'unicodedata',
  'urllib',
  'uuid',
  'weakref',
  'webbrowser',
  'zlib',
  'zipfile',
  'mock',
  'pytest',
])

export function parseSourceImports(source: string): string[] {
  const modules: string[] = []
  for (const match of source.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) {
    const name = match[1]!
    modules.push(name.split('.')[0]!)
  }
  return modules
}

export function importsOnlyStdlib(
  ...sourcesAndLocal: Array<readonly string[] | string>
): boolean {
  const sources: string[] = []
  let localModules: string[] = []
  for (const entry of sourcesAndLocal) {
    if (Array.isArray(entry)) localModules = entry
    else if (typeof entry === 'string') sources.push(entry)
  }
  return sources.every(source =>
    parseSourceImports(source).every(module =>
      STDLIB.has(module) || localModules.includes(module),
    ),
  )
}
