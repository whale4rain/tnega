/** Generated persistence is not an edit to the user's project. Keep config,
 * memory, skills and project artifacts visible rather than hiding all .tnega. */
export function isRuntimeFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('.tnega/sessions/')
    || normalized.startsWith('.tnega/spill/')
    || /^\.tnega\/run-v\d+\.jsonl$/.test(normalized)
    || /^\.tnega\/projects\/[^/]+\/agents\/[^/]+\/session\.jsonl$/.test(normalized)
}
