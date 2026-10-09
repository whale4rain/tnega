import { FileCode2, FileImage, FileSpreadsheet, FileText, Globe, Presentation, Table2, type LucideIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { errorText } from '../../lib/hooks'
import { isUnsupported, projectApi } from '../../lib/project-api'
import { formatBytes } from '../../lib/project-model'
import type { ArtifactFact } from '../../lib/project-types'
import { CodeBlock, Markdown } from '../Markdown'
import { PreviewView } from '../preview/FilePreview'

export type ArtifactKind = 'page' | 'doc' | 'slides' | 'sheet' | 'pdf' | 'image' | 'data' | 'code' | 'text'

export const ArtifactContext = createContext<((artifact: ArtifactFact) => void) | undefined>(undefined)

/** What an artifact is, for a person: a page to explore, a document to read, slides, a sheet… */
export function artifactKind(mediaType: string): ArtifactKind {
  if (/html/.test(mediaType)) return 'page'
  if (/wordprocessingml|msword/.test(mediaType)) return 'doc'
  if (/presentationml|powerpoint/.test(mediaType)) return 'slides'
  if (/spreadsheetml|ms-excel/.test(mediaType)) return 'sheet'
  if (/pdf/.test(mediaType)) return 'pdf'
  if (/^image\//.test(mediaType) && !/svg/.test(mediaType)) return 'image'
  if (/markdown/.test(mediaType)) return 'doc'
  if (/(csv|tab-separated|json)/.test(mediaType)) return 'data'
  if (/(javascript|typescript|diff|x-|svg)/.test(mediaType)) return 'code'
  return 'text'
}

export const ARTIFACT_KIND: Record<ArtifactKind, { label: string; plural: string; icon: LucideIcon }> = {
  page: { label: 'Page', plural: 'Pages', icon: Globe },
  doc: { label: 'Doc', plural: 'Docs', icon: FileText },
  slides: { label: 'Slides', plural: 'Slides', icon: Presentation },
  sheet: { label: 'Sheet', plural: 'Sheets', icon: FileSpreadsheet },
  pdf: { label: 'PDF', plural: 'PDFs', icon: FileText },
  image: { label: 'Image', plural: 'Images', icon: FileImage },
  data: { label: 'Data', plural: 'Data', icon: Table2 },
  code: { label: 'Code', plural: 'Code', icon: FileCode2 },
  text: { label: 'Text', plural: 'Text', icon: FileText },
}

/** Extensions the preview viewers recognise, for bytes that arrive without a file name. */
const EXTENSION: Partial<Record<ArtifactKind, string>> = {
  slides: 'pptx',
  sheet: 'xlsx',
  pdf: 'pdf',
  image: 'png',
}

function previewName(artifact: ArtifactFact): string | undefined {
  const kind = artifactKind(artifact.data.mediaType)
  if (kind === 'doc' && /wordprocessingml|msword/.test(artifact.data.mediaType)) return `${artifact.data.title}.docx`
  if (kind === 'image') return `${artifact.data.title}.${/jpe?g/.test(artifact.data.mediaType) ? 'jpg' : /gif/.test(artifact.data.mediaType) ? 'gif' : /webp/.test(artifact.data.mediaType) ? 'webp' : 'png'}`
  const extension = EXTENSION[kind]
  return extension ? `${artifact.data.title}.${extension}` : undefined
}

export function ArtifactIcon({ mediaType, size = 15 }: { mediaType: string; size?: number }) {
  const Icon = ARTIFACT_KIND[artifactKind(mediaType)].icon
  return <Icon size={size} aria-hidden />
}

/** Outputs attached to a message: one card each, opened in place, kept in the Library. */
export function ArtifactCards({ artifacts }: { workspace: string; projectId: string; artifacts: readonly ArtifactFact[] }) {
  const openArtifact = useContext(ArtifactContext)
  if (!artifacts.length) return null
  return (
    <div className="artifact-cards">
      {artifacts.map(artifact => (
        <button key={artifact.id} type="button" className="artifact-card" onClick={() => openArtifact?.(artifact)}>
          <span className={`artifact-card-icon kind-${artifactKind(artifact.data.mediaType)}`}><ArtifactIcon mediaType={artifact.data.mediaType} size={14} /></span>
          <span className="artifact-card-main">
            <span className="artifact-card-title">{artifact.data.title}</span>
            <span className="artifact-card-meta">{ARTIFACT_KIND[artifactKind(artifact.data.mediaType)].label} · {formatBytes(artifact.data.size)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * An artifact opened from a card or the Library. Pages run in a sandboxed
 * frame with scripts but no access to this app's origin, so a generated page
 * can be interactive without reaching the local server. Documents, slides,
 * sheets, PDFs and images use the same viewers as workspace files.
 */
export function ArtifactViewer({ workspace, projectId, artifact }: { workspace: string; projectId: string; artifact: ArtifactFact }) {
  const kind = artifactKind(artifact.data.mediaType)
  const binaryName = previewName(artifact)
  const hash = artifact.data.hash
  const load = useCallback(() => projectApi.artifactBlob(workspace, projectId, hash), [workspace, projectId, hash])
  if (binaryName) return <PreviewView workspace={workspace} path={binaryName} load={load} />
  return (
    <div className="wb-view" aria-label={`Artifact ${artifact.data.title}`}>
      <div className="wb-toolbar">
        <ArtifactIcon mediaType={artifact.data.mediaType} size={14} />
        <span className="wb-toolbar-title">{artifact.data.title}</span>
        <span className="muted small">{ARTIFACT_KIND[kind].label} · {formatBytes(artifact.data.size)}</span>
      </div>
      <div className="wb-card wb-scroll"><TextArtifact workspace={workspace} projectId={projectId} artifact={artifact} /></div>
    </div>
  )
}

function TextArtifact({ workspace, projectId, artifact }: { workspace: string; projectId: string; artifact: ArtifactFact }) {
  const [content, setContent] = useState<string | undefined>()
  const [unavailable, setUnavailable] = useState<string | undefined>()
  useEffect(() => {
    let cancelled = false
    setContent(undefined)
    setUnavailable(undefined)
    projectApi.artifact(workspace, projectId, artifact.data.hash).then(value => { if (!cancelled) setContent(value) }, reason => {
      if (cancelled) return
      setUnavailable(isUnsupported(reason)
        ? 'This server does not serve artifact content yet.'
        : errorText(reason))
    })
    return () => { cancelled = true }
  }, [workspace, projectId, artifact.data.hash])
  const kind = artifactKind(artifact.data.mediaType)
  const language = artifact.data.mediaType.split('/').pop()?.replace(/^x-/, '')
  return (
    <>
      {content === undefined && !unavailable && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w75" /></div>}
      {unavailable && (
        <div className="notice notice-info">
          <span>{unavailable}<br /><span className="mono small">sha256 {artifact.data.hash}</span></span>
        </div>
      )}
      {content !== undefined && (
        kind === 'page'
          ? <iframe className="artifact-frame" title={artifact.data.title} sandbox="allow-scripts allow-forms allow-popups" srcDoc={content} />
          : kind === 'doc'
            ? <Markdown text={content} />
            : <CodeBlock code={content} language={language} />
      )}
    </>
  )
}
