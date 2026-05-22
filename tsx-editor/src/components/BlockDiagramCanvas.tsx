import React, { useMemo } from 'react'
import type { DiagramBlock, DiagramEdge } from '../types/blockDiagram'

type Props = {
  blocks: DiagramBlock[]
  edges: DiagramEdge[]
  selectedBlockIds: string[]
  onSelectBlock: (blockId: string, additive: boolean) => void
  onMoveBlock: (blockId: string, x: number, y: number) => void
  onRenameBlock?: (blockId: string, title: string) => void
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
  onRenameBlock,
}) => {
  const blockById = useMemo(
    () => new Map(blocks.map((block) => [block.id, block])),
    [blocks],
  )

  const onMouseDownBlock = (e: React.MouseEvent, block: DiagramBlock) => {
    if (isNetHub(block)) return

    e.stopPropagation()
    onSelectBlock(block.id, e.ctrlKey || e.metaKey)

    const startX = e.clientX
    const startY = e.clientY
    const originalX = block.x
    const originalY = block.y

    const onMove = (ev: MouseEvent) => {
      onMoveBlock(block.id, originalX + ev.clientX - startX, originalY + ev.clientY - startY)
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
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'auto',
          background: '#1e1e1e',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: canvasWidth,
            height: canvasHeight,
          }}
        >
          <svg
            width={canvasWidth}
            height={canvasHeight}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
            }}
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
                  title={block.memberComponentIds.join(', ')}
                  style={{
                    position: 'absolute',
                    left: block.x,
                    top: block.y,
                    width: block.width,
                    height: block.height,
                    borderRadius: 999,
                    background: '#facc15',
                    border: '2px solid #eab308',
                    boxShadow: '0 0 10px rgba(250,204,21,0.45)',
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
                  border: selected
                    ? '2px solid #ffffff'
                    : `2px solid ${block.color}`,
                  boxShadow: selected
                    ? '0 0 0 3px rgba(255,255,255,0.18)'
                    : '0 8px 22px rgba(0,0,0,0.25)',
                  color: '#f1f5f9',
                  cursor: 'move',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  textAlign: 'center',
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
                    width: '100%',
                    textAlign: 'center',
                  }}
                >
                  <span
                    contentEditable
                    suppressContentEditableWarning
                    onMouseDown={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const next = e.currentTarget.textContent?.trim()

                      if (next && next !== block.title) {
                        onRenameBlock?.(block.id, next)
                      }
                    }}
                    style={{
                      outline: 'none',
                      cursor: 'text',
                      textAlign: 'center',
                      width: '100%',
                      display: 'inline-block',
                    }}
                  >
                    {block.title}
                  </span>
                </div>

                <div
                  style={{
                    fontSize: 11,
                    color: '#a3a3a3',
                    marginTop: 5,
                    lineHeight: 1.25,
                    width: '100%',
                    textAlign: 'center',
                  }}
                >
                  {block.subtitle || block.kind}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
}


