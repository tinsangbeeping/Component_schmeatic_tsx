import type { DiagramBlock, DiagramEdge, RawBlock, RawEdge } from '../../types/blockDiagram'

const BLOCK_W = 190
const BLOCK_H = 82

function colorFor(kind: string) {
  if (kind === 'supply') return '#7c3aed'
  if (kind === 'active') return '#2563eb'
  if (kind === 'passive') return '#16a34a'
  if (kind === 'connector') return '#f97316'
  return '#6b7280'
}

export function createInitialDiagramState(rawBlocks: RawBlock[], rawEdges: RawEdge[]) {
  const blocks: DiagramBlock[] = rawBlocks.map((block, index) => {
    const isHub = block.kind === 'connector' && block.memberTypes.includes('Net Hub')

    return {
      id: block.id,
      title: block.title,
      subtitle: block.subtitle,
      kind: block.kind,
      childBlockIds: [],
      rawBlockIds: [block.id],
      memberComponentIds: block.memberComponentIds,
      x: 80 + (index % 4) * 240,
      y: 80 + Math.floor(index / 4) * 150,
      width: isHub ? 120 : BLOCK_W,
      height: isHub ? 58 : BLOCK_H,
      color: colorFor(block.kind),
    }
  })

  const edges: DiagramEdge[] = rawEdges.map((edge) => ({ ...edge }))

  return { blocks, edges, selectedBlockIds: [] }
}

export function autoLayoutDiagram(blocks: DiagramBlock[], edges: DiagramEdge[]) {
  if (blocks.length === 0) return blocks

  const degree = new Map<string, number>()
  blocks.forEach((block) => degree.set(block.id, 0))

  edges.forEach((edge) => {
    degree.set(edge.sourceBlockId, (degree.get(edge.sourceBlockId) || 0) + 1)
    degree.set(edge.targetBlockId, (degree.get(edge.targetBlockId) || 0) + 1)
  })

  const textOf = (block: DiagramBlock) =>
    `${block.title} ${block.subtitle || ''}`.toLowerCase()

  const scoreBlock = (block: DiagramBlock) => {
    const text = textOf(block)
    let score = degree.get(block.id) || 0

    if (text.includes('mcu')) score += 150
    if (text.includes('microcontroller')) score += 150
    if (text.includes('ic')) score += 110
    if (text.includes('chip')) score += 100
    if (text.includes('controller')) score += 100
    if (text.includes('subcircuit')) score += 90

    if (text.includes('switch')) score -= 50
    if (text.includes('led')) score -= 50
    if (text.includes('indicator')) score -= 30

    return score
  }

  const center = [...blocks].sort((a, b) => scoreBlock(b) - scoreBlock(a))[0]
  const centerX = 520
  const centerY = 260

  const left: DiagramBlock[] = []
  const right: DiagramBlock[] = []
  const top: DiagramBlock[] = []
  const bottom: DiagramBlock[] = []

  for (const block of blocks) {
    if (block.id === center.id) continue

    const text = textOf(block)

    if (text.includes('switch') || text.includes('input') || text.includes('button')) {
      left.push(block)
    } else if (
      text.includes('led') ||
      text.includes('indicator') ||
      text.includes('output') ||
      text.includes('diode')
    ) {
      right.push(block)
    } else if (
      text.includes('supply') ||
      text.includes('power') ||
      text.includes('vcc') ||
      text.includes('vdd') ||
      text.includes('vin')
    ) {
      top.push(block)
    } else {
      bottom.push(block)
    }
  }

  const result: DiagramBlock[] = [{ ...center, x: centerX, y: centerY }]

  const placeVertical = (items: DiagramBlock[], x: number, yCenter: number) => {
    const spacing = 130
    const startY = yCenter - ((items.length - 1) * spacing) / 2

    items.forEach((block, index) => {
      result.push({ ...block, x, y: startY + index * spacing })
    })
  }

  const placeHorizontal = (items: DiagramBlock[], xCenter: number, y: number) => {
    const spacing = 240
    const startX = xCenter - ((items.length - 1) * spacing) / 2

    items.forEach((block, index) => {
      result.push({ ...block, x: startX + index * spacing, y })
    })
  }

  placeVertical(left, centerX - 340, centerY)
  placeVertical(right, centerX + 340, centerY)
  placeHorizontal(top, centerX, centerY - 170)
  placeHorizontal(bottom, centerX, centerY + 170)

  return result
}

export function moveDiagramBlock(blocks: DiagramBlock[], blockId: string, x: number, y: number) {
  return blocks.map((block) => (block.id === blockId ? { ...block, x, y } : block))
}

export function renameDiagramBlock(blocks: DiagramBlock[], blockId: string, title: string) {
  return blocks.map((block) => (block.id === blockId ? { ...block, title } : block))
}

export function rebuildDiagramEdges(blocks: DiagramBlock[], rawEdges: RawEdge[]) {
  const rawToVisible = new Map<string, string>()

  blocks.forEach((block) => {
    block.rawBlockIds.forEach((rawId) => rawToVisible.set(rawId, block.id))
  })

  const acc = new Map<string, DiagramEdge>()

  rawEdges.forEach((edge) => {
    const source = rawToVisible.get(edge.sourceBlockId)
    const target = rawToVisible.get(edge.targetBlockId)

    if (!source || !target || source === target) return

    const [a, b] = source < target ? [source, target] : [target, source]
    const key = `${a}__${b}`
    const existing = acc.get(key)

    if (!existing) {
      acc.set(key, {
        id: key,
        sourceBlockId: a,
        targetBlockId: b,
        labels: [...edge.labels],
        strength: edge.strength,
      })
    } else {
      existing.strength += edge.strength
      edge.labels.forEach((label) => {
        if (!existing.labels.includes(label)) existing.labels.push(label)
      })
    }
  })

  return [...acc.values()]
}

export function mergeDiagramBlocks(
  blocks: DiagramBlock[],
  rawEdges: RawEdge[],
  selectedBlockIds: string[],
  title: string,
) {
  const selected = blocks.filter((block) => selectedBlockIds.includes(block.id))

  if (selected.length < 2) {
    return { blocks, edges: rebuildDiagramEdges(blocks, rawEdges) }
  }

  const selectedSet = new Set(selectedBlockIds)
  const childBlockIds = selected.flatMap((block) =>
    block.childBlockIds.length ? block.childBlockIds : [block.id],
  )
  const rawBlockIds = selected.flatMap((block) => block.rawBlockIds)
  const memberComponentIds = selected.flatMap((block) => block.memberComponentIds)
  const minX = Math.min(...selected.map((block) => block.x))
  const minY = Math.min(...selected.map((block) => block.y))

  const merged: DiagramBlock = {
    id: `merged-${Date.now()}`,
    title,
    subtitle: `${selected.length} grouped blocks`,
    kind: 'active',
    childBlockIds,
    rawBlockIds,
    memberComponentIds,
    x: minX,
    y: minY,
    width: BLOCK_W + 30,
    height: BLOCK_H + 12,
    color: '#9333ea',
  }

  const nextBlocks = [...blocks.filter((block) => !selectedSet.has(block.id)), merged]

  return {
    blocks: nextBlocks,
    edges: rebuildDiagramEdges(nextBlocks, rawEdges),
  }
}

export function ungroupDiagramBlock(
  blocks: DiagramBlock[],
  rawBlocks: RawBlock[],
  rawEdges: RawEdge[],
  blockId: string,
) {
  const target = blocks.find((block) => block.id === blockId)

  if (!target || target.rawBlockIds.length <= 1) {
    return { blocks, edges: rebuildDiagramEdges(blocks, rawEdges) }
  }

  const rawMap = new Map(rawBlocks.map((block) => [block.id, block]))

  const restored = target.rawBlockIds
    .map((rawId, index): DiagramBlock | null => {
      const raw = rawMap.get(rawId)
      if (!raw) return null

      const isHub = raw.kind === 'connector' && raw.memberTypes.includes('Net Hub')

      return {
        id: raw.id,
        title: raw.title,
        subtitle: raw.subtitle,
        kind: raw.kind,
        childBlockIds: [],
        rawBlockIds: [raw.id],
        memberComponentIds: raw.memberComponentIds,
        x: target.x + (index % 2) * 230,
        y: target.y + Math.floor(index / 2) * 130,
        width: isHub ? 120 : BLOCK_W,
        height: isHub ? 58 : BLOCK_H,
        color: colorFor(raw.kind),
      }
    })
    .filter((block): block is DiagramBlock => block !== null)

  const nextBlocks = [...blocks.filter((block) => block.id !== blockId), ...restored]

  return {
    blocks: nextBlocks,
    edges: rebuildDiagramEdges(nextBlocks, rawEdges),
  }
}
