type ChipSide = 'left' | 'right' | 'top' | 'bottom'

export interface CustomChipPinPlacement {
  name: string
  side: ChipSide
  order: number
  x: number
  y: number
  labelX: number
  labelY: number
  textAnchor: 'start' | 'end' | 'middle'
}

export interface CustomChipLayout {
  width: number
  height: number
  bodyX: number
  bodyY: number
  bodyWidth: number
  bodyHeight: number
  pinFontSize: number
  titleFontSize: number
  subtitleFontSize: number
  title: string
  subtitle: string
  pins: CustomChipPinPlacement[]
}

const toFinite = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const estimateTextWidth = (text: string, fontSize: number): number => {
  return Math.max(0, text.length) * fontSize * 0.56
}

const parsePinSlots = (props: Record<string, any>) => {
  const legacyCount = Math.max(2, toFinite(props.pinCount, 8))
  const leftCount = Math.max(0, toFinite(props.leftPins, Math.ceil(legacyCount / 2)))
  const rightCount = Math.max(0, toFinite(props.rightPins, Math.floor(legacyCount / 2)))
  const topCount = Math.max(0, toFinite(props.topPins, 0))
  const bottomCount = Math.max(0, toFinite(props.bottomPins, 0))

  const namedMap = new Map<string, string>()
  const rawNames = String(props.pinNames || '').trim()

  if (rawNames.includes('=')) {
    rawNames
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const [slot, ...rest] = entry.split('=')
        const slotKey = slot.trim().toUpperCase()
        const pinLabel = rest.join('=').trim()
        if (slotKey && pinLabel) {
          namedMap.set(slotKey, pinLabel)
        }
      })
  }

  const legacyNames = !rawNames.includes('=')
    ? rawNames.split(',').map((value) => value.trim()).filter(Boolean)
    : []
  let legacyCursor = 0

  const hasExplicitSideConfig =
    props.leftPins !== undefined
    || props.rightPins !== undefined
    || props.topPins !== undefined
    || props.bottomPins !== undefined
    || rawNames.includes('=')

  const nextLegacyName = (fallback: string) => {
    if (legacyCursor < legacyNames.length) {
      const name = legacyNames[legacyCursor]
      legacyCursor += 1
      return name
    }
    return fallback
  }

  const getName = (slotKey: string, fallback: string) => {
    if (namedMap.has(slotKey)) return namedMap.get(slotKey) as string
    return nextLegacyName(fallback)
  }

  if (!hasExplicitSideConfig) {
    const leftPins = Array.from({ length: Math.ceil(legacyCount / 2) }, (_, i) => `pin${i + 1}`)
    const rightPins = Array.from({ length: Math.floor(legacyCount / 2) }, (_, i) => `pin${Math.ceil(legacyCount / 2) + i + 1}`)
    return {
      left: leftPins,
      right: rightPins,
      top: [] as string[],
      bottom: [] as string[]
    }
  }

  return {
    left: Array.from({ length: leftCount }, (_, i) => getName(`L${i + 1}`, `L${i + 1}`)),
    right: Array.from({ length: rightCount }, (_, i) => getName(`R${i + 1}`, `R${i + 1}`)),
    top: Array.from({ length: topCount }, (_, i) => getName(`U${i + 1}`, `U${i + 1}`)),
    bottom: Array.from({ length: bottomCount }, (_, i) => getName(`D${i + 1}`, `D${i + 1}`))
  }
}

const distribute = (count: number, start: number, end: number): number[] => {
  if (count <= 0) return []
  if (count === 1) return [(start + end) / 2]
  const span = end - start
  return Array.from({ length: count }, (_, i) => start + (span * i) / (count - 1))
}

export const buildCustomChipLayout = (props: Record<string, any>, fallbackName?: string): CustomChipLayout => {
  const slots = parsePinSlots(props)
  const pinFontSize = 10
  const titleFontSize = 12
  const subtitleFontSize = 10

  const title = String(props.name || fallbackName || 'Chip').trim() || 'Chip'
  const subtitleRaw = String(props.manufacturerPartNumber || props.componentType || '').trim()
  const subtitle = subtitleRaw

  const sideRows = Math.max(slots.left.length, slots.right.length)
  const topBottomCols = Math.max(slots.top.length, slots.bottom.length)

  const leftLabelWidth = slots.left.reduce((max, label) => Math.max(max, estimateTextWidth(label, pinFontSize)), 0)
  const rightLabelWidth = slots.right.reduce((max, label) => Math.max(max, estimateTextWidth(label, pinFontSize)), 0)

  const bodyPadX = 18
  const bodyPadY = 14
  const pinPitch = 18
  const pinStub = 10
  const outerPad = 8
  const labelGap = 8

  const titleBlockHeight = subtitle ? 34 : 22
  const bodyHeightFromPins = sideRows > 0
    ? bodyPadY * 2 + (sideRows - 1) * pinPitch
    : 72
  const bodyHeight = Math.max(72, bodyHeightFromPins, titleBlockHeight + 22)

  const bodyWidthFromTopBottom = topBottomCols > 1
    ? bodyPadX * 2 + (topBottomCols - 1) * pinPitch
    : 104
  const bodyWidthFromTitle = Math.max(
    estimateTextWidth(title, titleFontSize),
    subtitle ? estimateTextWidth(subtitle, subtitleFontSize) : 0
  ) + bodyPadX * 2
  const bodyWidth = Math.max(104, bodyWidthFromTopBottom, bodyWidthFromTitle)

  const leftGutter = Math.max(12, leftLabelWidth + labelGap)
  const rightGutter = Math.max(12, rightLabelWidth + labelGap)

  const bodyX = outerPad + leftGutter + pinStub
  const bodyY = outerPad

  const width = Math.ceil(bodyX + bodyWidth + pinStub + rightGutter + outerPad)
  const height = Math.ceil(bodyY + bodyHeight + outerPad)

  const yStart = bodyY + bodyPadY
  const yEnd = bodyY + bodyHeight - bodyPadY
  const xStart = bodyX + bodyPadX
  const xEnd = bodyX + bodyWidth - bodyPadX

  const leftY = distribute(slots.left.length, yStart, yEnd)
  const rightY = distribute(slots.right.length, yStart, yEnd)
  const topX = distribute(slots.top.length, xStart, xEnd)
  const bottomX = distribute(slots.bottom.length, xStart, xEnd)

  const pins: CustomChipPinPlacement[] = []

  slots.left.forEach((name, i) => {
    const y = leftY[i] ?? (bodyY + bodyHeight / 2)
    pins.push({
      name,
      side: 'left',
      order: i,
      x: bodyX,
      y,
      labelX: bodyX - 6,
      labelY: y + 3,
      textAnchor: 'end'
    })
  })

  slots.right.forEach((name, i) => {
    const y = rightY[i] ?? (bodyY + bodyHeight / 2)
    pins.push({
      name,
      side: 'right',
      order: i,
      x: bodyX + bodyWidth,
      y,
      labelX: bodyX + bodyWidth + 6,
      labelY: y + 3,
      textAnchor: 'start'
    })
  })

  slots.top.forEach((name, i) => {
    const x = topX[i] ?? (bodyX + bodyWidth / 2)
    pins.push({
      name,
      side: 'top',
      order: i,
      x,
      y: bodyY,
      labelX: x,
      labelY: bodyY - 5,
      textAnchor: 'middle'
    })
  })

  slots.bottom.forEach((name, i) => {
    const x = bottomX[i] ?? (bodyX + bodyWidth / 2)
    pins.push({
      name,
      side: 'bottom',
      order: i,
      x,
      y: bodyY + bodyHeight,
      labelX: x,
      labelY: bodyY + bodyHeight + 12,
      textAnchor: 'middle'
    })
  })

  return {
    width,
    height,
    bodyX,
    bodyY,
    bodyWidth,
    bodyHeight,
    pinFontSize,
    titleFontSize,
    subtitleFontSize,
    title,
    subtitle,
    pins
  }
}
