import { FileCode2, FileText, Globe, Table2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorText } from '../../lib/hooks'
import { isUnsupported, projectApi } from '../../lib/project-api'
import { formatBytes } from '../../lib/project-model'
import type { ArtifactFact } from '../../lib/project-types'
import { Dialog } from '../Dialog'
import { CodeBlock, Markdown } from '../Markdown'

type ArtifactKind = 'page' | 'document' | 'data' | 'code' | 'text'

/** What an artifact is, for a person: a page to explore, a document to read, data or code. */
export function artifactKind(mediaType: string): ArtifactKind {
  if (/html/.test(mediaType)) return 'page'
  if (/markdown/.test(mediaType)) return 'document'
  if (/(csv|tab-separated|json)/.test(mediaType)) return 'data'
  if (/(javascript|typescript|diff|x-)/.test(mediaType)) return 'code'
  return 'text'
}

const KIND: Record<ArtifactKind, { label: string; icon: typeof FileText }> = {
  page: { label: 'Interactive page', icon: Globe },
  document: { label: 'Document', icon: FileText },
  data: { label: 'Data', icon: Table2 },
  code: { label: 'Code', icon: FileCode2 },
  text: { label: 'Text', icon: FileText },
}

export function ArtifactIcon({ mediaType, size = 15 }: { mediaType: string; size?: number }) {
  const Icon = KIND[artifactKind(mediaType)].icon
  return <Icon size={size} aria-hidden />
}

/** Outputs attached to a message: one card each, opened in place, kept in the Library. */
export function ArtifactCards({ workspace, projectId, artifacts }: { workspace: string; projectId: string; artifacts: readonly ArtifactFact[] }) {
  const [viewing, setViewing] = useState<ArtifactFact | undefined>()
  if (!artifacts.length) return null
  return (
    <div className="artifact-cards">
      {artifacts.map(artifact => (
        <button key={artifact.id} type="button" className="artifact-card" onClick={() => setViewing(artifact)}>
          <span className="artifact-card-icon"><ArtifactIcon mediaType={artifact.data.mediaType} size={16} /></span>
          <span className="artifact-card-main">
            <span className="artifact-card-title">{artifact.data.title}</span>
            <span className="artifact-card-meta">{KIND[artifactKind(artifact.data.mediaType)].label} · {formatBytes(artifact.data.size)}</span>
          </span>
        </button>
      ))}
      {viewing && <ArtifactViewer workspace={workspace} projectId={projectId} artifact={viewing} onClose={() => setViewing(undefined)} />}
    </div>
  )
}

/**
 * An artifact opened from a card or the Library. Pages run in a sandboxed
 * frame with scripts but no access to this app's origin, so a generated page
 * can be interactive without reaching the local server.
 */
export function ArtifactViewer({ workspace, projectId, artifact, onClose }: { workspace: string; projectId: string; artifact: ArtifactFact; onClose: () => void }) {
  const [content, setContent] = useState<string | undefined>()
  const [unavailable, setUnavailable] = useState<string | undefined>()
  useEffect(() => {
    projectApi.artifact(workspace, projectId, artifact.data.hash).then(setContent, reason => {
      setUnavailable(isUnsupported(reason)
        ? 'This server does not serve artifact content yet.'
        : errorText(reason))
    })
  }, [workspace, projectId, artifact.data.hash])
  const kind = artifactKind(artifact.data.mediaType)
  const language = artifact.data.mediaType.split('/').pop()?.replace(/^x-/, '')
  return (
    <Dialog title={artifact.data.title} description={`${KIND[kind].label} · ${formatBytes(artifact.data.size)}`} onClose={onClose} width={kind === 'page' ? 980 : 760}>
      {content === undefined && !unavailable && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w75" /></div>}
      {unavailable && (
        <div className="notice notice-info">
          <span>{unavailable}<br /><span className="mono small">sha256 {artifact.data.hash}</span></span>
        </div>
      )}
      {content !== undefined && (
        kind === 'page'
          ? <iframe className="artifact-frame" title={artifact.data.title} sandbox="allow-scripts allow-forms allow-popups" srcDoc={content} />
          : kind === 'document'
            ? <Markdown text={content} />
            : <CodeBlock code={content} language={language} />
      )}
    </Dialog>
  )
}
