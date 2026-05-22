import type { ExportGraph, ExportTrace, ExportNetLabel, ExportNetDeclaration } from '../types/exportGraph'

const compileTrace = (trace: ExportTrace): string => {
  return `<trace from="${trace.from}" to="${trace.to}" />`
}

const compileNet = (net: ExportNetDeclaration): string => {
  const role = String(net.role || '').trim()
  const scope = String(net.scope || '').trim()
  const roleAttr = role ? ` role="${role}"` : ''
  const scopeAttr = scope ? ` scope="${scope}"` : ''
  return `<net name="${net.name}"${roleAttr}${scopeAttr} />`
}

const compileNetLabel = (label: ExportNetLabel): string => {
  const schX = Number(label.schX)
  const schY = Number(label.schY)
  const schXAttr = Number.isFinite(schX) ? ` schX={${Math.round(schX * 1000) / 1000}}` : ''
  const schYAttr = Number.isFinite(schY) ? ` schY={${Math.round(schY * 1000) / 1000}}` : ''
  const netRoleRaw = String(label.netRole || '').trim()
  const netRoleAttr = netRoleRaw ? ` netRole="${netRoleRaw}"` : ''
  return `<netlabel net="${label.net}"${schXAttr}${schYAttr}${netRoleAttr} />`
}

export const compileExportGraphToTSXNodes = (graph: ExportGraph): string[] => {
  const out: string[] = []
  graph.nodes.forEach((node) => {
    if (node.kind === 'net') {
      out.push(compileNet(node))
      return
    }
    if (node.kind === 'trace') {
      out.push(compileTrace(node))
      return
    }
    if (node.kind === 'netlabel') {
      out.push(compileNetLabel(node))
    }
  })
  return out
}
