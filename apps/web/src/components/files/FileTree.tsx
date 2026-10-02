import { asyncDataLoaderFeature, hotkeysCoreFeature, selectionFeature } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react'
import { forwardRef, useImperativeHandle } from 'react'
import { api, type DirectoryEntry } from '../../lib/api'

const ROOT = '.'
const ROOT_ENTRY: DirectoryEntry = { name: '', path: '', type: 'dir' }

export interface FileTreeHandle {
  /** Re-read every loaded directory (after the agent or the editor changed files). */
  refresh: () => void
}

/**
 * The workspace as a lazily loaded tree: a directory is listed when it is first
 * expanded. Built on headless-tree, which owns keyboard navigation, focus and
 * ARIA; this component only draws the rows.
 */
export const FileTree = forwardRef<FileTreeHandle, {
  workspace: string
  selected: string | undefined
  onOpen: (path: string) => void
}>(function FileTree({ workspace, selected, onOpen }, ref) {
  const tree = useTree<DirectoryEntry>({
    rootItemId: ROOT,
    indent: 14,
    getItemName: item => item.getItemData()?.name ?? '',
    isItemFolder: item => item.getItemData()?.type === 'dir',
    createLoadingItemData: () => ({ name: '…', path: '', type: 'file' }),
    onPrimaryAction: item => {
      const data = item.getItemData()
      if (data?.type === 'file') onOpen(data.path)
    },
    dataLoader: {
      getItem: id => id === ROOT ? ROOT_ENTRY : { name: id.slice(id.lastIndexOf('/') + 1), path: id, type: 'file' },
      getChildrenWithData: async id => {
        const { entries } = await api.fileTree(workspace, id === ROOT ? '' : id)
        return entries.map(entry => ({ id: entry.path, data: entry }))
      },
    },
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  })

  useImperativeHandle(ref, () => ({
    refresh: () => {
      for (const item of tree.getItems()) {
        if (item.isFolder() && item.isExpanded()) void item.invalidateChildrenIds(true)
      }
      void tree.getRootItem().invalidateChildrenIds(true)
    },
  }), [tree])

  const items = tree.getItems()
  return (
    <div {...tree.getContainerProps('Workspace files')} className="file-tree">
      {items.length === 0 && <div className="file-tree-empty muted small">Loading…</div>}
      {items.map(item => {
        const data = item.getItemData()
        const folder = item.isFolder()
        const level = item.getItemMeta().level
        const Icon = folder ? (item.isExpanded() ? FolderOpen : Folder) : File
        return (
          <button
            {...item.getProps()}
            key={item.getKey()}
            type="button"
            className={`file-tree-row${item.isFocused() ? ' focused' : ''}${data?.path === selected ? ' selected' : ''}`}
            style={{ paddingLeft: 6 + level * 14 }}
            title={data?.path}
          >
            <ChevronRight size={13} className={`file-tree-caret${folder ? '' : ' hidden'}${item.isExpanded() ? ' open' : ''}`} aria-hidden />
            <Icon size={14} className={`file-tree-icon${folder ? ' folder' : ''}`} aria-hidden />
            <span className="file-tree-name">{item.getItemName()}</span>
            {item.isLoading() && <span className="spinner tiny" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
})
