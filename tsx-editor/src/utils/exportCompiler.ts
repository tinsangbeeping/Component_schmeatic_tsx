import type { ExportGraph, ExportTrace, ExportNetLabel } from '../types/exportGraph'

const serializeTraceRoutePoints = (routePoints: ExportTrace['routePoints']): string | null => {
  if (!Array.isArray(routePoints) || routePoints.length < 2) return null
  const normalized = routePoints
    .map(point => ({ x: Number(point.x), y: Number(point.y) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))

  if (normalized.length < 2) return null

  return normalized
    .map(point => `${Math.round(point.x * 1000) / 1000},${Math.round(point.y * 1000) / 1000}`)
    .join(';')
}

const compileTrace = (trace: ExportTrace): string => {
  const routePointsRaw = serializeTraceRoutePoints(trace.routePoints)
  const routePointsAttr = routePointsRaw ? ` routePoints="${routePointsRaw}"` : ''
  return `<trace from="${trace.from}" to="${trace.to}"${routePointsAttr} />`
}

const compileNetLabel = (label: ExportNetLabel): string => {
  return `<netlabel net="${label.net}" />`
}

export const compileExportGraphToTSXNodes = (graph: ExportGraph): string[] => {
  const out: string[] = []
  graph.nodes.forEach((node) => {
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
