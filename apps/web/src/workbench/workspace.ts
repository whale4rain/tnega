export function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
