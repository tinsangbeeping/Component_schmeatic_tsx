export const normalizeDegrees = (degrees: number): number => {
  const normalized = degrees % 360
  return normalized < 0 ? normalized + 360 : normalized
}

export const toSvgArcAngle = (declaredAngle: number): number => normalizeDegrees(declaredAngle + 180)

export const getArcEndpoint = (
  centerX: number,
  centerY: number,
  radius: number,
  declaredAngle: number
) => {
  const radians = (toSvgArcAngle(declaredAngle) * Math.PI) / 180

  return {
    x: centerX + radius * Math.cos(radians),
    y: centerY + radius * Math.sin(radians)
  }
}
