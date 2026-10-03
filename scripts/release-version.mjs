/** Stable and preview versions share one naming policy across publishing steps. */
export function releaseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.[1-9]\d*)?$/.test(version)) {
    throw new Error('version must be x.y.z or x.y.z-beta.N (N starts at 1)')
  }
  const preview = version.includes('-beta.')
  return { version, preview, feed: preview ? 'beta.yml' : 'latest.yml', npmTag: preview ? 'preview' : 'latest', releaseType: preview ? 'prerelease' : 'release' }
}
