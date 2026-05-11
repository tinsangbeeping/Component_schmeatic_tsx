export type FsMap = Record<string, string>

export interface WorkspaceExport {
  version: 1
  name: string
  files: FsMap
}

const DEFAULT_MAIN_TSX = `export default () => (
  <board width="50mm" height="50mm">
    {/* Add components here */}
  </board>
)
`

export function createDefaultWorkspaceFsMap(name = 'My Project'): FsMap {
  return {
    'schematics/main.tsx': DEFAULT_MAIN_TSX,
    'subcircuits/index.ts': '',
    'symbols/index.ts': '',
    'editor/meta.json': JSON.stringify(
      {
        netAnchors: {},
        symbolRegistry: {},
        componentRegistry: {},
        layout: {}
      },
      null,
      2
    ),
    'project.json': JSON.stringify(
      {
        name,
        version: 1
      },
      null,
      2
    )
  }
}

export function ensureWorkspaceFsMapDefaults(fsMap: FsMap, name = 'My Project'): FsMap {
  const normalized = { ...fsMap }

  // Legacy migrations
  if (normalized['main.tsx'] && !normalized['schematics/main.tsx']) {
    normalized['schematics/main.tsx'] = normalized['main.tsx']
  }

  Object.entries(normalized).forEach(([path, content]) => {
    if (path.startsWith('patches/') && path.endsWith('.tsx')) {
      normalized[path.replace('patches/', 'subcircuits/')] = content
    }
  })

  return {
    ...createDefaultWorkspaceFsMap(name),
    ...normalized
  }
}

export function exportWorkspaceJson(name: string, fsMap: FsMap): WorkspaceExport {
  return {
    version: 1,
    name,
    files: { ...fsMap }
  }
}

export function importWorkspaceJson(payload: string): WorkspaceExport {
  const parsed = JSON.parse(payload) as Partial<WorkspaceExport>

  if (parsed.version !== 1) {
    throw new Error('Unsupported workspace export version')
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Workspace export missing valid name')
  }

  if (!parsed.files || typeof parsed.files !== 'object') {
    throw new Error('Workspace export missing files')
  }

  return {
    version: 1,
    name: parsed.name,
    files: ensureWorkspaceFsMapDefaults(parsed.files as FsMap, parsed.name)
  }
}
