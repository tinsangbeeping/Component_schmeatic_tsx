import React, { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '../store/editorStore'
import { buildRawBlockGraph } from '../lib/parts/blockDiagramConverter'
import {
  autoLayoutDiagram,
  createInitialDiagramState,
  mergeDiagramBlocks,
  moveDiagramBlock,
  rebuildDiagramEdges,
  renameDiagramBlock,
  ungroupDiagramBlock,
} from '../lib/parts/blockDiagramEditor'
import { BlockDiagramCanvas } from './BlockDiagramCanvas'
import type { BlockDiagramState } from '../types/blockDiagram'

export const BlockDiagramEditorPage: React.FC = () => {
  const placedComponents = useEditorStore((state) => state.placedComponents)
  const wires = useEditorStore((state) => state.wires)
  const setActiveFilePath = useEditorStore((state) => state.setActiveFilePath)

  const rawGraph = useMemo(
    () => buildRawBlockGraph(placedComponents, wires),
    [placedComponents, wires],
  )

  const [diagram, setDiagram] = useState<BlockDiagramState>(() =>
    createInitialDiagramState(rawGraph.rawBlocks, rawGraph.rawEdges),
  )
  const [showHierarchy, setShowHierarchy] = useState(false)

  useEffect(() => {
    const next = createInitialDiagramState(rawGraph.rawBlocks, rawGraph.rawEdges)

    setDiagram({
      ...next,
      blocks: autoLayoutDiagram(next.blocks, next.edges),
    })
  }, [rawGraph])

  const selectedBlocks = useMemo(
    () => diagram.blocks.filter((block) => diagram.selectedBlockIds.includes(block.id)),
    [diagram.blocks, diagram.selectedBlockIds],
  )

  const onSelectBlock = (blockId: string, additive: boolean) => {
    setDiagram((prev) => {
      if (additive) {
        const already = prev.selectedBlockIds.includes(blockId)

        return {
          ...prev,
          selectedBlockIds: already
            ? prev.selectedBlockIds.filter((id) => id !== blockId)
            : [...prev.selectedBlockIds, blockId],
        }
      }

      return {
        ...prev,
        selectedBlockIds: [blockId],
      }
    })
  }

  const onMoveBlock = (blockId: string, x: number, y: number) => {
    setDiagram((prev) => ({
      ...prev,
      blocks: moveDiagramBlock(prev.blocks, blockId, x, y),
    }))
  }

  const onMerge = () => {
    const title =
      selectedBlocks.length > 0
        ? selectedBlocks.map((block) => block.title).slice(0, 2).join(' + ')
        : 'Merged Block'

    setDiagram((prev) => {
      const result = mergeDiagramBlocks(prev.blocks, rawGraph.rawEdges, prev.selectedBlockIds, title)

      return {
        blocks: result.blocks,
        edges: result.edges,
        selectedBlockIds: result.blocks.length ? [result.blocks[result.blocks.length - 1].id] : [],
      }
    })
  }

  const onUngroup = () => {
    if (diagram.selectedBlockIds.length !== 1) return

    const blockId = diagram.selectedBlockIds[0]

    setDiagram((prev) => {
      const result = ungroupDiagramBlock(prev.blocks, rawGraph.rawBlocks, rawGraph.rawEdges, blockId)

      return {
        blocks: result.blocks,
        edges: result.edges,
        selectedBlockIds: [],
      }
    })
  }

  const onRename = () => {
    if (diagram.selectedBlockIds.length !== 1) return

    const blockId = diagram.selectedBlockIds[0]
    const current = diagram.blocks.find((block) => block.id === blockId)

    if (!current) return

    const nextTitle = window.prompt('Rename block', current.title)
    if (!nextTitle) return

    setDiagram((prev) => ({
      ...prev,
      blocks: renameDiagramBlock(prev.blocks, blockId, nextTitle),
    }))
  }

  const onAutoLayout = () => {
    setDiagram((prev) => ({
      ...prev,
      blocks: autoLayoutDiagram(prev.blocks, prev.edges),
    }))
  }

  const onResetFromSchematic = () => {
    const next = createInitialDiagramState(rawGraph.rawBlocks, rawGraph.rawEdges)

    setDiagram({
      ...next,
      blocks: autoLayoutDiagram(next.blocks, next.edges),
    })
  }

  const onRebuildEdges = () => {
    setDiagram((prev) => ({
      ...prev,
      edges: rebuildDiagramEdges(prev.blocks, rawGraph.rawEdges),
    }))
  }

  const visibleBlocks = useMemo(
    () => (showHierarchy ? diagram.blocks : diagram.blocks.filter((block) => block.layer === 'block')),
    [diagram.blocks, showHierarchy],
  )

  const visibleBlockIds = useMemo(
    () => new Set(visibleBlocks.map((block) => block.id)),
    [visibleBlocks],
  )

  const visibleEdges = useMemo(
    () =>
      diagram.edges.filter(
        (edge) =>
          visibleBlockIds.has(edge.sourceBlockId) &&
          visibleBlockIds.has(edge.targetBlockId),
      ),
    [diagram.edges, visibleBlockIds],
  )

  const visibleSelectedBlockIds = useMemo(
    () => diagram.selectedBlockIds.filter((id) => visibleBlockIds.has(id)),
    [diagram.selectedBlockIds, visibleBlockIds],
  )

  const onOpenBlock = (blockId: string) => {
    const block = diagram.blocks.find((candidate) => candidate.id === blockId)
    if (!block) return

    const subcircuitComponent = placedComponents.find((component) =>
      block.memberComponentIds.includes(component.id) && component.catalogId === 'subcircuit-instance',
    )

    const subcircuitPath =
      subcircuitComponent?.props?.subcircuitPath || subcircuitComponent?.props?.filePath

    if (typeof subcircuitPath === 'string' && subcircuitPath) {
      setActiveFilePath(subcircuitPath)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 400 }}>
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid #3e3e3e',
          background: '#252526',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ color: '#e0e0e0', fontSize: 14, fontWeight: 700 }}>
            Block Diagram Editor
          </div>

          <div style={{ color: '#999', fontSize: 11, marginTop: 2 }}>
            {diagram.blocks.length} visible blocks • {diagram.edges.length} visible edges •{' '}
            {rawGraph.rawBlocks.length} raw blocks • {rawGraph.rawNets.length} electrical nets
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btnStyle} onClick={onAutoLayout}>
            Auto layout
          </button>

          <button style={btnStyle} onClick={onMerge} disabled={diagram.selectedBlockIds.length < 2}>
            Merge selected
          </button>

          <button
            style={btnStyle}
            onClick={onUngroup}
            disabled={
              diagram.selectedBlockIds.length !== 1 ||
              !(diagram.blocks.find((b) => b.id === diagram.selectedBlockIds[0])?.childBlockIds.length)
            }
          >
            Ungroup
          </button>

          <button style={btnStyle} onClick={onRename} disabled={diagram.selectedBlockIds.length !== 1}>
            Rename
          </button>

          <button style={btnStyle} onClick={onRebuildEdges}>
            Rebuild edges
          </button>

          <button style={btnStyle} onClick={onResetFromSchematic}>
            Reset from schematic
          </button>

          <button style={btnStyle} onClick={() => setShowHierarchy((value) => !value)}>
            {showHierarchy ? 'Hide hierarchy' : 'Show hierarchy'}
          </button>
        </div>
      </div>

      <BlockDiagramCanvas
        blocks={visibleBlocks}
        edges={visibleEdges}
        selectedBlockIds={visibleSelectedBlockIds}
        onSelectBlock={onSelectBlock}
        onMoveBlock={onMoveBlock}
        onOpenBlock={onOpenBlock}
      />

      <div
        style={{
          borderTop: '1px solid #3e3e3e',
          padding: '8px 12px',
          background: '#252526',
          color: '#999',
          fontSize: 11,
        }}
      >
        Selected: {diagram.selectedBlockIds.length} • Visible parts: {rawGraph.debug.visibleComponents} •
        Carrier parts: {rawGraph.debug.carrierComponents} • Isolated raw blocks:{' '}
        {rawGraph.debug.isolatedBlocks}
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 4,
  background: '#333',
  color: '#eee',
  border: '1px solid #4a4a4a',
  cursor: 'pointer',
  fontSize: 11,
}
