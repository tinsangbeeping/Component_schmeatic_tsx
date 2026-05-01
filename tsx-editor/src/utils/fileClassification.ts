export type ActiveFileType =
  | 'board-tsx'
  | 'subcircuit-tsx'
  | 'symbol-component-tsx'
  | 'symbol-editor-json'
  | 'raw-source'
  | 'source-ts'
  | 'json'

export type DetectedFileKind = 'board' | 'subcircuit' | 'symbol-component' | 'raw'

export const detectFileKind = (code: string): DetectedFileKind => {
  const trimmed = code.trim()
  if (!trimmed) return 'raw'

  const hasBoard = /<board\b[\s>]/.test(trimmed)
  const hasSubcircuit = /<subcircuit\b[\s>]/.test(trimmed)
  const hasSymbolComponent = /<chip\b[\s\S]*?\bsymbol\s*=\s*\{/.test(trimmed)

  if (hasBoard || /export\s+default[\s\S]*<board\b/i.test(trimmed)) return 'board'
  if (hasSubcircuit) return 'subcircuit'
  if (hasSymbolComponent) return 'symbol-component'
  return 'raw'
}

export const inferDetectedFileKind = (filePath: string, code: string): DetectedFileKind => {
  const structuralKind = detectFileKind(code)
  if (structuralKind !== 'raw') return structuralKind

  const normalizedPath = filePath.replace(/^\/+/, '')
  if (!normalizedPath.endsWith('.tsx')) return 'raw'

  if (normalizedPath.startsWith('symbols/')) return 'symbol-component'
  if (normalizedPath.startsWith('subcircuits/')) return 'subcircuit'
  if (normalizedPath === 'main.tsx' || normalizedPath.startsWith('schematics/')) return 'board'
  if (normalizedPath.startsWith('raw/')) return 'raw'
  if (/\bexport\s+default\b/.test(code)) return 'board'

  return 'raw'
}

export const getFolderForDetectedFileKind = (kind: DetectedFileKind): 'schematics' | 'subcircuits' | 'symbols' | 'raw' => {
  if (kind === 'subcircuit') return 'subcircuits'
  if (kind === 'symbol-component') return 'symbols'
  if (kind === 'raw') return 'raw'
  return 'schematics'
}

export const classifyFilePath = (filePath: string): ActiveFileType => {
  if (/^symbols\/\.editor\/.+\.symbol\.json$/.test(filePath)) return 'symbol-editor-json'

  if (filePath.endsWith('.json')) return 'json'

  if (filePath.endsWith('.tsx')) {
    if (filePath === 'main.tsx' || filePath.startsWith('schematics/')) return 'board-tsx'
    if (filePath.startsWith('subcircuits/')) return 'subcircuit-tsx'
    if (filePath.startsWith('symbols/')) return 'symbol-component-tsx'
    return 'raw-source'
  }

  if (filePath.endsWith('.ts')) return 'source-ts'

  return 'raw-source'
}

export const isCanvasEditableFileType = (fileType: ActiveFileType): boolean => {
  return fileType === 'board-tsx' || fileType === 'subcircuit-tsx'
}
