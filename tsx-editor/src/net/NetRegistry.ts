/**
 * NetRegistry resolves net names to stable net IDs.
 *
 * Two calls to getNetId("VCC") will always return the same ID.
 * Comparison is case-insensitive ("vcc" and "VCC" are the same net).
 */
export type NetRole =
  | 'power'
  | 'ground'
  | 'analog'
  | 'digital'
  | 'spi'
  | 'i2c'
  | 'clock'
  | 'reset'
  | 'differential'
  | 'signal'
  | 'unknown'

export type PowerDistributionStrategy = 'global-label' | 'local-island' | 'continuous-rail'

export type NetSource = 'explicit-net' | 'netlabel' | 'trace' | 'connections' | 'inferred' | 'merge'

export interface NetEntry {
  id: string
  name: string
  role: NetRole
  source: NetSource
}

const normalizeNetToken = (value: string): string => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

export const inferNetRole = (name: string): NetRole => {
  const token = normalizeNetToken(String(name || ''))
  if (!token) return 'unknown'

  if (token === 'GND' || token.startsWith('AGND') || token.startsWith('DGND') || token.startsWith('VSS') || token.startsWith('VREGVSS')) return 'ground'
  if (token === 'VCC' || token === 'VDD' || token.startsWith('DVDD') || token.startsWith('IOVDD') || token.startsWith('PVDD')) return 'power'
  if (token.startsWith('AVDD') || token.startsWith('AREF') || token.startsWith('VREF') || token.startsWith('DECOUPLE') || token.startsWith('VREGSW')) return 'analog'
  if (token === 'SCL' || token === 'SDA' || token.startsWith('I2C')) return 'i2c'
  if (token === 'MOSI' || token === 'MISO' || token === 'SCK' || token === 'SCLK' || token.startsWith('CS') || token.startsWith('NSS') || token.startsWith('SPI')) return 'spi'
  if (token.startsWith('CLK') || token.endsWith('CLK') || token.startsWith('XTAL')) return 'clock'
  if (token.startsWith('RESET') || token === 'NRST' || token === 'RST') return 'reset'
  if (token.endsWith('P') || token.endsWith('N') || token.includes('DIFF')) return 'differential'
  if (token.startsWith('GPIO') || token.startsWith('SWD') || token.startsWith('JTAG')) return 'digital'
  if (token.startsWith('D')) return 'digital'
  if (token.startsWith('A')) return 'analog'
  if (token.startsWith('SIG')) return 'signal'
  return 'unknown'
}

export const inferPowerDistributionStrategy = (name: string, role?: NetRole): PowerDistributionStrategy => {
  const resolvedRole = role || inferNetRole(name)
  const token = normalizeNetToken(String(name || ''))
  if (resolvedRole === 'ground' || resolvedRole === 'power') return 'global-label'
  if (resolvedRole === 'analog' && (token.includes('VDD') || token.includes('VREF') || token.includes('REF'))) {
    return 'local-island'
  }
  return 'continuous-rail'
}

const ROLE_RANK: Record<NetRole, number> = {
  unknown: 0,
  signal: 1,
  digital: 2,
  clock: 3,
  reset: 3,
  spi: 4,
  i2c: 4,
  differential: 5,
  analog: 6,
  power: 7,
  ground: 8
}

export class NetRegistry {
  private nameToId = new Map<string, string>()
  private idToEntry = new Map<string, NetEntry>()
  private idCounter = 0

  private mergeRole(current: NetRole, incoming: NetRole): NetRole {
    if (incoming === 'unknown') return current
    if (current === 'unknown') return incoming
    return ROLE_RANK[incoming] >= ROLE_RANK[current] ? incoming : current
  }

  /** Register a net with semantic metadata (creates one if needed). */
  registerNet(name: string, options?: { role?: NetRole; source?: NetSource }): string {
    const key = String(name || '').toUpperCase()
    const incomingRole = options?.role || inferNetRole(name)
    const incomingSource = options?.source || 'inferred'

    if (!this.nameToId.has(key)) {
      const id = `net_${this.idCounter++}`
      this.nameToId.set(key, id)
      this.idToEntry.set(id, {
        id,
        name,
        role: incomingRole,
        source: incomingSource
      })
      return id
    }

    const id = this.nameToId.get(key)!
    const existing = this.idToEntry.get(id)
    if (existing) {
      this.idToEntry.set(id, {
        ...existing,
        role: this.mergeRole(existing.role, incomingRole),
        source: incomingSource
      })
    }

    return id
  }

  /** Return the canonical net ID for a given name (creates one if needed). */
  getNetId(name: string): string {
    return this.registerNet(name, { source: 'inferred' })
  }

  /** Return the canonical (display) name for a net ID. */
  getNetName(id: string): string | undefined {
    return this.idToEntry.get(id)?.name
  }

  /** Return full metadata for a net ID. */
  getNetEntry(id: string): NetEntry | undefined {
    return this.idToEntry.get(id)
  }

  /** Return net role by net ID or net name. */
  getNetRole(idOrName: string): NetRole | undefined {
    if (this.idToEntry.has(idOrName)) {
      return this.idToEntry.get(idOrName)?.role
    }

    const id = this.nameToId.get(String(idOrName || '').toUpperCase())
    if (!id) return undefined
    return this.idToEntry.get(id)?.role
  }

  /** True if a net with this name has already been registered. */
  has(name: string): boolean {
    return this.nameToId.has(name.toUpperCase())
  }

  /** All registered entries, useful for debugging. */
  entries(): NetEntry[] {
    return [...this.idToEntry.values()]
  }

  /** Reset the registry (useful between parse runs). */
  reset(): void {
    this.nameToId.clear()
    this.idToEntry.clear()
    this.idCounter = 0
  }
}
