import React, { useMemo, useRef, useState, useCallback } from 'react'
import type { DiagramBlock, DiagramEdge } from '../types/blockDiagram'

const MIN_SCALE = 0.1
const MAX_SCALE = 4
const ZOOM_FACTOR = 0.0012

type Props = {
  blocks: DiagramBlock[]
  edges: DiagramEdge[]
  selectedBlockIds: string[]
  onSelectBlock: (blockId: string, additive: boolean) => void
  onMoveBlock: (blockId: string, x: number, y: number) => void
}

function isNetHub(block?: DiagramBlock) {
  return !!block && block.kind === 'connector' && block.memberComponentIds.length === 0
}

export const BlockDiagramCanvas: React.FC<Props> = ({
  blocks,
  edges,
  selectedBlockIds,
  onSelectBlock,
  onMoveBlock,
}) => {
  const blockById = useMemo(
    () => new Map(blocks.map((block) => [block.id, block])),
    [blocks],
  )

  const [scale, setScale] = useState(1)
  const [offsetX, setOffsetX] = useState(0)
  const [offsetY, setOffsetY] = useState(0)
  const outerRef = useRef<HTMLDivElement>(null)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 })

  const resetView = () => {
    setScale(1)
    setOffsetX(0)
    setOffsetY(0)
  }

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = outerRef.current!.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const delta = -e.deltaY * ZOOM_FACTOR
    setScale((prev) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta * prev))
      const ratio = next / prev
      setOffsetX((ox) => mouseX - ratio * (mouseX - ox))
      setOffsetY((oy) => mouseY - ratio * (mouseY - oy))
      return next
    })
  }, [])

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    // Only pan on direct background click (not block drag)
    if ((e.target as HTMLElement) !== e.currentTarget) return
    isPanningRef.current = true
    panStartRef.current = { x: e.clientX, y: e.clientY, ox: offsetX, oy: offsetY }

    const onMove = (ev: MouseEvent) => {
      if (!isPanningRef.current) return
      setOffsetX(panStartRef.current.ox + ev.clientX - panStartRef.current.x)
      setOffsetY(panStartRef.current.oy + ev.clientY - panStartRef.current.y)
    }

    const onUp = () => {
      isPanningRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onMouseDownBlock = (e: React.MouseEvent, block: DiagramBlock) => {
    if (isNetHub(block)) return

    e.stopPropagation()
    onSelectBlock(block.id, e.ctrlKey || e.metaKey)

    const startX = e.clientX
    const startY = e.clientY
    const originalX = block.x
    const originalY = block.y

    const onMove = (ev: MouseEvent) => {
      onMoveBlock(
        block.id,
        originalX + (ev.clientX - startX) / scale,
        originalY + (ev.clientY - startY) / scale,
      )
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const canvasWidth = Math.max(1200, ...blocks.map((block) => block.x + block.width + 160), 1200)
  const canvasHeight = Math.max(700, ...blocks.map((block) => block.y + block.height + 160), 700)

  return (
    <div
      ref={outerRef}
      onWheel={onWheel}
      onMouseDown={onBackgroundMouseDown}
      style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#1e1e1e', cursor: 'grab' }}
    >
      {/* Reset view button */}
      <button
        onClick={resetView}
        title="Back to origin (reset zoom & pan)"
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 10,
          background: '#2d2d2d',
          border: '1px solid #555',
          color: '#ccc',
          borderRadius: 6,
          padding: '4px 10px',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        ⌖ Reset View
      </button>

      {/* Zoom indicator */}
      <div
        style={{
          position: 'absolute',
          bottom: 10,
          right: 10,
          zIndex: 10,
          background: '#2d2d2d',
          border: '1px solid #444',
          color: '#888',
          borderRadius: 4,
          padding: '2px 8px',
          fontSize: 11,
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        {Math.round(scale * 100)}%
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
          transformOrigin: '0 0',
        }}
      >
      <div style={{ position: 'relative', width: canvasWidth, height: canvasHeight }}>
        <svg
          width={canvasWidth}
          height={canvasHeight}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          {edges.map((edge) => {
            const a = blockById.get(edge.sourceBlockId)
            const b = blockById.get(edge.targetBlockId)
            if (!a || !b) return null

            const ax = a.x + a.width / 2
            const ay = a.y + a.height / 2
            const bx = b.x + b.width / 2
            const by = b.y + b.height / 2
            const label = edge.labels.slice(0, 2).join(', ')

            return (
              <g key={edge.id}>
                <line
                  x1={ax}
                  y1={ay}
                  x2={bx}
                  y2={by}
                  stroke="#6ea8fe"
                  strokeWidth={Math.min(4, Math.max(2, edge.strength))}
                  opacity={0.85}
                />

                {label && (
                  <text
                    x={(ax + bx) / 2}
                    y={(ay + by) / 2 - 6}
                    fill="#cbd5e1"
                    fontSize="11"
                    textAnchor="middle"
                  >
                    {label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {blocks.map((block) => {
          const selected = selectedBlockIds.includes(block.id)
          const hub = isNetHub(block)

          if (hub) {
            return (
              <div
                key={block.id}
                title={block.title}
                style={{
                  position: 'absolute',
                  left: block.x + block.width / 2 - 6,
                  top: block.y + block.height / 2 - 6,
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: '#fbbf24',
                  border: '2px solid #1e1e1e',
                  pointerEvents: 'none',
                  boxShadow: '0 0 0 2px rgba(251,191,36,0.2)',
                }}
              />
            )
          }

          return (
            <div
              key={block.id}
              onMouseDown={(e) => onMouseDownBlock(e, block)}
              title={block.memberComponentIds.join(', ')}
              style={{
                position: 'absolute',
                left: block.x,
                top: block.y,
                width: block.width,
                height: block.height,
                borderRadius: 14,
                background: '#252526',
                border: selected ? '2px solid #ffffff' : `2px solid ${block.color}`,
                boxShadow: selected
                  ? '0 0 0 3px rgba(255,255,255,0.18)'
                  : '0 8px 22px rgba(0,0,0,0.25)',
                color: '#f1f5f9',
                cursor: 'move',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                padding: '10px 12px',
                userSelect: 'none',
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 800,
                  color: '#fff',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {block.title}
              </div>

              <div
                style={{
                  fontSize: 11,
                  color: '#a3a3a3',
                  marginTop: 5,
                  lineHeight: 1.25,
                }}
              >
                {block.subtitle || block.kind}
              </div>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}
