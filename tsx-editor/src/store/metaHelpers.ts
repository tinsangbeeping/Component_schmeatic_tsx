import { FSMap } from '../types/catalog'
import type { WorkspaceComponentRegistry, WorkspaceSymbolRegistry } from '../types/project'

export interface NetAnchorPosition {
  schX: number
  schY: number
}

export interface EditorMeta {
  netAnchors: Record<string, Record<string, NetAnchorPosition>>
  symbolRegistry?: WorkspaceSymbolRegistry
  componentRegistry?: WorkspaceComponentRegistry
}

const DEFAULT_META: EditorMeta = { netAnchors: {} }

export const loadEditorMeta = (fsMap: FSMap): EditorMeta => {
  try {
    const raw = fsMap['editor/meta.json']
    if (!raw) return { ...DEFAULT_META, netAnchors: {} }
    const parsed = JSON.parse(raw)
    return {
      netAnchors: parsed.netAnchors && typeof parsed.netAnchors === 'object' ? parsed.netAnchors : {},
      symbolRegistry: parsed.symbolRegistry && typeof parsed.symbolRegistry === 'object' ? parsed.symbolRegistry : {},
      componentRegistry: parsed.componentRegistry && typeof parsed.componentRegistry === 'object' ? parsed.componentRegistry : {}
    }
  } catch {
    return { ...DEFAULT_META, netAnchors: {}, symbolRegistry: {}, componentRegistry: {} }
  }
}

export const saveEditorMeta = (fsMap: FSMap, meta: EditorMeta): FSMap => ({
  ...fsMap,
  'editor/meta.json': JSON.stringify(meta, null, 2)
})

export const getNetAnchor = (
  meta: EditorMeta,
  filePath: string,
  canonicalNetName: string
): NetAnchorPosition | null => {
  const byFile = meta.netAnchors[filePath]
  if (!byFile) return null
  return byFile[canonicalNetName] ?? null
}

export const setNetAnchor = (
  meta: EditorMeta,
  filePath: string,
  canonicalNetName: string,
  pos: NetAnchorPosition
): EditorMeta => ({
  ...meta,
  netAnchors: {
    ...meta.netAnchors,
    [filePath]: {
      ...(meta.netAnchors[filePath] ?? {}),
      [canonicalNetName]: pos
    }
  }
})
