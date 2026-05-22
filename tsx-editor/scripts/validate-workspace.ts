/**
 * Step 2 workspace-level validation.
 *
 * Verifies full workspace import/export roundtrip:
 * - folder/file presence: schematics/, symbols/, subcircuits/, editor/
 * - nets preserved
 * - ports preserved
 * - editor metadata preserved
 * - no crash while parsing schematic/subcircuit TSX
 * - strict workspace equality after re-import
 */

import JSZip from 'jszip'
import {
  createDefaultWorkspaceFsMap,
  exportWorkspaceJson,
  importWorkspaceJson,
  type FsMap,
  type WorkspaceExport
} from '../src/store/workspaceFs'
import { minimalImportExportTestUtils } from '../src/store/editorStore'
import { useEditorStore } from '../src/store/editorStore'
import { buildProjectFileTree } from '../src/utils/projectManager'
import {
  buildComponentUsage,
  buildDependencyGraph,
  buildImportedProjectState,
  buildSubcircuitRegistry,
  extractAllSubcircuits,
  extractAllSymbols,
  extractBatchFilesFromZip,
  validateImports
} from '../src/utils/projectManager'
import { classifyFilePath } from '../src/utils/fileClassification'
import { layoutCircuit } from '../src/utils/elkLayout'

interface WorkspaceState {
  id: string
  name: string
  fsMap: FsMap
  activeFilePath: string
}

const SCHEMATIC_MAIN = 'schematics/main.tsx'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function stableObject<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {}
  Object.keys(obj).sort().forEach((k) => {
    const value = obj[k]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[k] = stableObject(value)
    } else if (Array.isArray(value)) {
      out[k] = value.map((v) => (v && typeof v === 'object' ? stableObject(v) : v))
    } else {
      out[k] = value
    }
  })
  return out as T
}

function workspacesEqual(a: WorkspaceState, b: WorkspaceState): boolean {
  const left = stableObject({
    name: a.name,
    activeFilePath: a.activeFilePath,
    fsMap: a.fsMap
  })
  const right = stableObject({
    name: b.name,
    activeFilePath: b.activeFilePath,
    fsMap: b.fsMap
  })
  return JSON.stringify(left) === JSON.stringify(right)
}

async function run(): Promise<void> {
  console.log('\n🔍 validate-workspace.ts (Step 2 + Step 3A)\n')

  // 1) Create a test workspace
  const fsMap = createDefaultWorkspaceFsMap('test1')

  // 2) Add exactly one schematic, one symbol, one subcircuit
  fsMap[SCHEMATIC_MAIN] = `import { EFR_t1 } from "../subcircuits/EFR_t1"

export default () => (
  <board width="50mm" height="50mm">
    {/* // schX={120} */}
    {/* // schY={120} */}
    <chip name="U1" pinCount={8} schRotation="0deg" />

    {/* // schX={60} */}
    {/* // schY={80} */}
    <net name="VIN" schRotation="0deg" />

    {/* // schX={220} */}
    {/* // schY={80} */}
    <net name="VOUT" schRotation="0deg" />

    {/* // schX={180} */}
    {/* // schY={200} */}
    <EFR_t1 name="X1" schRotation="0deg" />

    <trace from=".U1 > .pin1" to="net.VIN" />
    <trace from=".U1 > .pin8" to="net.VOUT" />
    <trace from=".X1 > .VIN" to="net.VIN" />
    <trace from=".X1 > .VOUT" to="net.VOUT" />
  </board>
)
`

  fsMap['symbols/TestSymbol.tsx'] = `export default function TestSymbol(props: { name: string; schX?: number; schY?: number }) {
  return (
    <chip
      {...props}
      symbol={
        <symbol>
          <line x1="-5" y1="0" x2="5" y2="0" stroke="black" />
          <port name="IN" schX={-8} schY={0} />
          <port name="OUT" schX={8} schY={0} />
        </symbol>
      }
    />
  )
}
`

  fsMap['subcircuits/EFR_t1.tsx'] = `export const ports = ["VIN", "VOUT"] as const

export function EFR_t1(props: { name: string; schX?: number; schY?: number }) {
  const x = props.schX ?? 0
  const y = props.schY ?? 0
  return (
    <subcircuit name={props.name}>
      {/* // schX={x + 100} */}
      {/* // schY={y + 100} */}
      <resistor name="R1" resistance="1k" schRotation="0deg" />

      <trace from=".R1 > .pin1" to="net.VIN" />
      <trace from=".R1 > .pin2" to="net.VOUT" />
    </subcircuit>
  )
}
`

  fsMap['editor/meta.json'] = JSON.stringify(
    {
      netAnchors: {
        [SCHEMATIC_MAIN]: {
          VIN: { schX: 60, schY: 80 },
          VOUT: { schX: 220, schY: 80 }
        }
      },
      layout: {
        lastViewport: { x: 0, y: 0, zoom: 1 }
      }
    },
    null,
    2
  )

  const originalWorkspace: WorkspaceState = {
    id: 'test1',
    name: 'test1',
    fsMap,
    activeFilePath: SCHEMATIC_MAIN
  }

  // 3) Simulate placing/components + connecting nets by parsing files (no crash expected)
  const parsedMain = minimalImportExportTestUtils.parseImportedTSXToCanvas(fsMap[SCHEMATIC_MAIN], SCHEMATIC_MAIN)
  const parsedSub = minimalImportExportTestUtils.parseImportedTSXToCanvas(fsMap['subcircuits/EFR_t1.tsx'], 'subcircuits/EFR_t1.tsx')
  assert(parsedMain.components.length > 0, 'main schematic parse should produce components')
  assert(parsedMain.wires.length > 0, 'main schematic parse should produce wires')
  assert(parsedSub.components.some(c => c.name === 'R1'), 'subcircuit parse should include R1')

  const visualOnlySchematic = `export default () => (
  <board width="50mm" height="50mm">
    <net name="GND" role="ground" scope="global" />
    <netlabel net="GND" schX={10} schY={10} />
    <netlabel net="GND" schX={40} schY={10} />
    <schematicline x1={0} y1={0} x2={10} y2={0} />
    <schematicarc center={{ x: 10, y: 10 }} radius={5} startAngleDegrees={0} endAngleDegrees={90} direction="clockwise" />
  </board>
)`
  const visualOnlyParsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(visualOnlySchematic, SCHEMATIC_MAIN)
  const visualOnlyExport = minimalImportExportTestUtils.exportCanvasToTSX(
    SCHEMATIC_MAIN,
    visualOnlyParsed.components,
    visualOnlyParsed.wires
  )
  assert(visualOnlyParsed.wires.length === 0, 'visual-only net labels and primitives must not create electrical wires')
  assert((visualOnlyExport.match(/<net name="GND"/g) || []).length === 1, 'repeated GND labels should export one invisible electrical net')
  assert((visualOnlyExport.match(/<netlabel net="GND"/g) || []).length === 2, 'repeated GND labels should remain separate visual labels')
  assert(!visualOnlyExport.includes('<trace'), 'visual-only labels/primitives must not export traces')
  assert(visualOnlyExport.includes('<schematicline'), 'schematicline should be preserved as visual layout')
  assert(visualOnlyExport.includes('<schematicarc'), 'schematicarc should be preserved as visual layout')

  // Standalone single-file imports should normalize safely.
  const standaloneSubcircuitFile = `import React from "react"

export default function ImportedThing(props: { name: string; schX?: number; schY?: number }) {
  return (
    <subcircuit name={props.name}>
      <resistor name="R_single" resistance="10k" />
    </subcircuit>
  )
}`
  const normalizedMainImport = minimalImportExportTestUtils.normalizeImportedTSXContent(standaloneSubcircuitFile, SCHEMATIC_MAIN)
  const normalizedSubImport = minimalImportExportTestUtils.normalizeImportedTSXContent(standaloneSubcircuitFile, 'subcircuits/SingleImport.tsx')
  assert(normalizedMainImport.includes('<board'), 'single-file TSX import into main should stay a board schematic')
  assert(!normalizedMainImport.includes('export default function ImportedThing'), 'single-file TSX import should not overwrite main with standalone component source')
  assert(normalizedSubImport.includes('export function SingleImport'), 'single-file TSX import should be renamed to match the target file name')

  const standaloneBoardFile = `export default () => (
  <board width="40mm" height="30mm">
    <chip name="U_board" pinCount={8} />
  </board>
)`
  const normalizedBoardIntoSubcircuitPath = minimalImportExportTestUtils.normalizeImportedTSXContent(
    standaloneBoardFile,
    'subcircuits/PowerBlock.tsx'
  )
  assert(normalizedBoardIntoSubcircuitPath.includes('<board'), 'board import should remain a schematic even when the current path is under subcircuits')
  assert(!normalizedBoardIntoSubcircuitPath.includes('<subcircuit'), 'board import must not be rewritten as a subcircuit')

  // Regression: canonical advanced IC schematic import should normalize safely.
  const advancedChipSchematic = `export default () => (
  <board width="50mm" height="50mm">
    {/* Duplicate net symbols for DVDD collapsed (5 visual instances -> 1 logical <net />) */}
    {/* Duplicate net symbols for GND collapsed (4 visual instances -> 1 logical <net />) */}

    <chip
      name="U1"
      schX={28.9}
      schY={4.7}
      schRotation="0deg"
      footprint="soic14"
      pinLabels={{
        pin1: "RESETN",
        pin2: "BODEN",
        pin3: "VREGVDD",
        pin4: "AVDD",
        pin5: "IOVDD1",
        pin6: "IOVDD2",
        pin7: "IOVDD3",
        pin8: "IOVDD4",
        pin9: "VREGSW1",
        pin10: "DVDD1",
        pin11: "DECOUPLE",
        pin12: "VREGVSS1",
        pin13: "VREGVSS2",
        pin14: "VREGVSS3",
      }}
      schPinArrangement={{
        leftSide: {
          direction: "top-to-bottom",
          pins: ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6", "pin7"],
        },
        rightSide: {
          direction: "bottom-to-top",
          pins: ["pin8", "pin9", "pin10", "pin11", "pin12", "pin13", "pin14"],
        },
      }}
      pinAttributes={{
        pin3: { requiresPower: true },
        pin4: { requiresPower: true },
        pin5: { requiresPower: true },
        pin6: { requiresPower: true },
        pin7: { requiresPower: true },
        pin8: { requiresPower: true },
        pin10: { requiresPower: true },
        pin12: { requiresGround: true },
        pin13: { requiresGround: true },
        pin14: { requiresGround: true },
      }}
    />

    <net name="RESETN" schX={4.2} schY={5.6} schRotation="0deg" />
    <net name="DVDD" schX={4} schY={8.3} schRotation="0deg" />
    <net name="GND" schX={3.9} schY={12.1} schRotation="0deg" />
    <resistor name="R1" schX={7.6} schY={6.6} schRotation="0deg" resistance="10k" footprint="0805" />
    <capacitor name="C7" schX={38.3} schY={12.1} schRotation="0deg" capacitance="100nF" footprint="0805" />
    <capacitor name="C8" schX={43.6} schY={12.2} schRotation="0deg" capacitance="100nF" footprint="0805" />

    <trace from="net.RESETN" to=".U1 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin2" />
    <trace from="net.DVDD" to=".R1 > .pin1" />
    <trace from=".U1 > .pin12" to="net.GND" />
    <trace from=".C7 > .pin1" to=".U1 > .pin11" />
    <trace from="net.DVDD" to=".U1 > .pin10" />
    <trace from=".C8 > .pin1" to="net.DVDD" />
  </board>
)`

  const normalizedAdvancedImport = minimalImportExportTestUtils.normalizeImportedTSXContent(
    advancedChipSchematic,
    SCHEMATIC_MAIN
  )
  const advancedParsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(
    normalizedAdvancedImport,
    SCHEMATIC_MAIN
  )

  assert(advancedParsed.components.some(c => c.name === 'U1'), 'advanced IC schematic should parse U1')
  assert(advancedParsed.wires.length >= 7, 'advanced IC schematic should preserve numbered pin traces')
  assert(normalizedAdvancedImport.includes('schX={28.9}'), 'advanced IC schematic should preserve real schX props')
  assert(normalizedAdvancedImport.includes('schY={4.7}'), 'advanced IC schematic should preserve real schY props')
  assert(normalizedAdvancedImport.includes('pinLabels={{'), 'advanced IC schematic should preserve explicit pinLabels')
  assert(normalizedAdvancedImport.includes('schPinArrangement={{'), 'advanced IC schematic should preserve explicit schPinArrangement')
  assert(normalizedAdvancedImport.includes('pinAttributes={{'), 'advanced IC schematic should preserve explicit pinAttributes')
  assert(!normalizedAdvancedImport.includes('symbolPreset="npn-bce-template"'), 'wrong transistor preset should not appear')
  assert(!normalizedAdvancedImport.includes('footprint="soic8"'), 'mismatched SOIC-8 footprint should not appear')

  const connectionsOnlyBoard = `export default () => (
  <board width="120mm" height="80mm" schAutoLayoutEnabled>
    <net name="DVDD" />
    <net name="GND" />
    <net name="RESETN" />
    <net name="BODEN" />

    <chip
      name="U1C"
      footprint="qfn32"
      pinLabels={{
        "1": "RESETN",
        "2": "BODEN",
        "3": "VREGVDD",
        "4": "AVDD",
        "5": "IOVDD1",
        "6": "IOVDD2",
        "7": "IOVDD3",
        "8": "IOVDD4",
        "9": "VREGSW",
        "10": "DVDD",
        "11": "DECOUPLE",
        "12": "VREGVSS1",
        "13": "VREGVSS2",
        "14": "VREGVSS3",
      }}
      schPinArrangement={{
        leftSide: {
          direction: "top-to-bottom",
          pins: ["1", "2", "3", "4", "5", "6", "7", "8"],
        },
        rightSide: {
          direction: "top-to-bottom",
          pins: ["9", "10", "11", "12", "13", "14"],
        },
      }}
      connections={{
        RESETN: "RESETN",
        BODEN: "BODEN",
        VREGVDD: "DVDD",
        AVDD: "DVDD",
        IOVDD1: "DVDD",
        IOVDD2: "DVDD",
        IOVDD3: "DVDD",
        IOVDD4: "DVDD",
        DVDD: "DVDD",
        VREGVSS1: "GND",
        VREGVSS2: "GND",
        VREGVSS3: "GND",
      }}
      schX={50}
      schY={35}
    />

    <capacitor
      name="C1"
      capacitance="100nF"
      footprint="0805"
      connections={{ pin1: "DVDD", pin2: "GND" }}
      schX={80}
      schY={35}
    />

    <resistor
      name="R1"
      resistance="10k"
      footprint="0805"
      connections={{ pin1: "DVDD", pin2: "BODEN" }}
      schX={20}
      schY={25}
    />
  </board>
)`

  const parsedConnectionsOnly = minimalImportExportTestUtils.parseImportedTSXToCanvas(
    connectionsOnlyBoard,
    SCHEMATIC_MAIN
  )
  assert(parsedConnectionsOnly.components.some(c => c.name === 'U1C'), 'connections-only import should parse chip component')
  const parsedConnectionsChip = parsedConnectionsOnly.components.find(c => c.name === 'U1C')
  assert(parsedConnectionsChip?.catalogId === 'customchip', 'chip declarations with pinLabels + schPinArrangement should map to customchip for rendering')
  assert(Number(parsedConnectionsChip?.props.leftPins) === 8, 'mapped customchip should preserve left-side pin count from schPinArrangement')
  assert(Number(parsedConnectionsChip?.props.rightPins) === 6, 'mapped customchip should preserve right-side pin count from schPinArrangement')
  assert(String(parsedConnectionsChip?.props.pinNames || '').includes('L1=pin1'), 'mapped customchip should keep slot-to-pin mapping for selector compatibility')
  assert(String(parsedConnectionsChip?.props.pinNames || '').includes('R6=pin14'), 'mapped customchip should keep right slot mapping through highest declared pin')
  assert(parsedConnectionsOnly.wires.length >= 8, 'connections-only import should synthesize wires from connections objects')
  const generatedConnectionsOnly = minimalImportExportTestUtils.exportCanvasToTSX(
    SCHEMATIC_MAIN,
    parsedConnectionsOnly.components,
    parsedConnectionsOnly.wires
  )
  assert(generatedConnectionsOnly.includes('<trace from=".R1 > .pin2" to="net.BODEN" />'), 'connections-only import should emit net traces for synthesized resistor connections')
  assert(generatedConnectionsOnly.includes('<trace from=".C1 > .pin1" to="net.DVDD" />'), 'connections-only import should emit net traces for synthesized capacitor connections')

  const directShortBoard = `export default () => (
  <board width="60mm" height="40mm">
    <net name="DVDD" isForPower />
    <net name="SWDIO" />
    <trace from="net.DVDD" to="net.SWDIO" />
  </board>
)`
  const parsedDirectShort = minimalImportExportTestUtils.parseImportedTSXToCanvas(directShortBoard, SCHEMATIC_MAIN)
  const generatedDirectShort = minimalImportExportTestUtils.exportCanvasToTSX(
    SCHEMATIC_MAIN,
    parsedDirectShort.components,
    parsedDirectShort.wires
  )
  assert(!generatedDirectShort.includes('<trace from="net.DVDD" to="net.SWDIO" />'), 'power-to-signal net short should be rejected by net semantics')

  const subcircuitPortApiTsx = `export const ports = ["END", "SIGNAL"] as const

export function DEB_CIR_1(props: { name: string; schX?: number; schY?: number }) {
  const x = props.schX ?? 0
  const y = props.schY ?? 0

  return (
    <subcircuit name={props.name}>
      <port name="END" schX={x + 31.5} schY={y + 8} />
      <port name="SIGNAL" schX={x + 2.4} schY={y + 0.6} />
      <net name="END" />
      <trace from=".END > .port" to="net.END" />
    </subcircuit>
  )
}`
  const parsedPortApi = minimalImportExportTestUtils.parseImportedTSXToCanvas(
    subcircuitPortApiTsx,
    'subcircuits/DEB_CIR_1.tsx'
  )
  assert(parsedPortApi.components.some(c => c.catalogId === 'public-port' && c.name === 'END'), 'port END should keep original public API name as a public boundary port')
  assert(parsedPortApi.components.some(c => c.catalogId === 'public-port' && c.name === 'SIGNAL'), 'port SIGNAL should keep original public API name as a public boundary port')
  assert(parsedPortApi.components.some(c => c.catalogId === 'net' && c.name === 'END'), 'net END should coexist with port END without forcing rename')

  const exportedPortApi = minimalImportExportTestUtils.exportCanvasToTSX(
    'subcircuits/DEB_CIR_1.tsx',
    parsedPortApi.components,
    parsedPortApi.wires
  )
  assert(exportedPortApi.includes('<port\n      name="END"\n      schX={x + 31.5}\n      schY={y + 8}\n    />'), 'export should preserve real END port coordinates in schX/schY props')
  assert(exportedPortApi.includes('<port\n      name="SIGNAL"\n      schX={x + 2.4}\n      schY={y + 0.6}\n    />'), 'export should preserve real SIGNAL port coordinates in schX/schY props')
  assert(!exportedPortApi.includes('name="END2"'), 'export should never auto-rename END public port to END2')

  useEditorStore.getState().createWorkspace('Selector Validation WS')
  useEditorStore.getState().setFSMap({
    ...createDefaultWorkspaceFsMap('Selector Validation WS'),
    'schematics/main.tsx': `export default () => (
  <board width="120mm" height="80mm">
    <chip name="U1" pinCount={8} schX={20} schY={20} />
    <net name="DVDD" />
    <trace from=".U1 > .R3" to="net.DVDD" />
  </board>
)`,
    'subcircuits/DEB_CIR_1.tsx': subcircuitPortApiTsx,
    'schematics/BoardApi.tsx': `import { DEB_CIR_1 } from "../subcircuits/DEB_CIR_1"

export default () => (
  <board width="50mm" height="50mm">
    <DEB_CIR_1 name="DEB_CIR_12" schX={20} schY={20} />
    <resistor name="R_API" resistance="1k" schX={40} schY={20} />
    <trace from=".DEB_CIR_12 > .END" to=".R_API > .pin1" />
  </board>
)`
  })

  let didRejectInvalidSelector = false
  try {
    useEditorStore.getState().setActiveFilePath('schematics/main.tsx')
    useEditorStore.getState().generateFlatCircuitTSX()
  } catch {
    didRejectInvalidSelector = true
  }
  assert(didRejectInvalidSelector, 'export should reject invalid chip selector like .U1 > .R3 when pinCount=8 only allows .pin1..pin8')

  const selectorValidationFsMap = useEditorStore.getState().fsMap
  const repairedMainSelector = String(selectorValidationFsMap['schematics/main.tsx'] || '').replace('.U1 > .R3', '.U1 > .pin3')
  useEditorStore.getState().setFSMap({
    ...selectorValidationFsMap,
    'schematics/main.tsx': repairedMainSelector
  })

  useEditorStore.getState().setActiveFilePath('subcircuits/DEB_CIR_1.tsx')
  const flatFromSubcircuitTab = useEditorStore.getState().generateFlatCircuitTSX()
  assert(flatFromSubcircuitTab.includes('<board'), 'public export entrypoint should still resolve to a board file even when active tab is subcircuit')
  assert(!flatFromSubcircuitTab.includes('<subcircuit name={props.name}>'), 'public export entrypoint should not be a subcircuit file')

  useEditorStore.getState().setActiveFilePath('schematics/BoardApi.tsx')
  const boardApiFlat = useEditorStore.getState().generateFlatCircuitTSX()
  assert(boardApiFlat.includes('.DEB_CIR_12 > .END') || boardApiFlat.includes('.DEB_CIR_12>.END'), 'import/export should preserve DEB_CIR_1 public port API selector .END without renaming')

  const zip = new JSZip()
  zip.file('subcircuits/ZipBlock.tsx', `export const ports = ["IN", "OUT"] as const\n\nexport function ZipBlock(props: { name: string }) {\n  return <subcircuit name={props.name}></subcircuit>\n}`)
  zip.file('schematics/ZipMain.tsx', `import { ZipBlock } from "../subcircuits/ZipBlock"\n\nexport default () => <board><ZipBlock name="X1" /></board>`)
  const extractedZipFiles = await extractBatchFilesFromZip(await zip.generateAsync({ type: 'uint8array' }))
  assert(extractedZipFiles.length === 2, 'zip import should extract importable project files')
  assert(extractedZipFiles.some(file => file.fileName.endsWith('ZipBlock.tsx')), 'zip import should preserve relative project paths')

  const packageRootZip = new JSZip()
  packageRootZip.file('wrapper/ignore/Outside.tsx', `export default () => <board />`)
  packageRootZip.file('wrapper/project/package.json', JSON.stringify({ name: 'package-root-project' }))
  packageRootZip.file('wrapper/project/src/ShouldStay.tsx', `export default () => <board />`)
  const packageRootZipFiles = await extractBatchFilesFromZip(await packageRootZip.generateAsync({ type: 'uint8array' }))
  assert(packageRootZipFiles.length === 1, 'zip import should only load files below the folder containing package.json')
  assert(packageRootZipFiles[0].fileName === 'src/ShouldStay.tsx', 'zip import should strip the package.json folder as the selected project root')

  const brokenFsMap = createDefaultWorkspaceFsMap('Broken Import WS')
  brokenFsMap['schematics/Broken.tsx'] = `import { MissingBlock } from "../subcircuits/MissingBlock"\n\nexport default () => <board><MissingBlock name="X1" /></board>`
  assert(validateImports(brokenFsMap).length > 0, 'validateImports should report missing relative imports')

  const externalImportFsMap = createDefaultWorkspaceFsMap('External Import WS')
  externalImportFsMap['schematics/Test1.tsx'] = `import { resistor } from "@tscircuit/core"\n\nexport default () => <board><resistor name="R1" /></board>`
  validateImports(externalImportFsMap)

  const canonicalRelocationFsMap = createDefaultWorkspaceFsMap('Canonical Relocation WS')
  canonicalRelocationFsMap['schematics/main.tsx'] = `import { Deb_button_test2 } from "./Deb_button_test2"\n\nexport default () => <board><Deb_button_test2 name="X1" /></board>`
  canonicalRelocationFsMap['subcircuits/Deb_button_test2.tsx'] = `export function Deb_button_test2(props: { name: string }) {\n  return <subcircuit name={props.name}></subcircuit>\n}`
  validateImports(canonicalRelocationFsMap)

  const multiEntryFsMap = createDefaultWorkspaceFsMap('Multi Entry WS')
  multiEntryFsMap['schematics/PageA.tsx'] = `export default () => <board><chip name="U_A" pinCount={8} /></board>`
  multiEntryFsMap['schematics/PageB.tsx'] = `import PageBBody from "./PageBBody"\n\nexport default PageBBody`
  multiEntryFsMap['schematics/PageBBody.tsx'] = `export default () => <board><chip name="U_B" pinCount={8} /></board>`
  const multiEntryProject = buildImportedProjectState(multiEntryFsMap)
  assert(multiEntryProject.entryFiles.includes('schematics/PageA.tsx'), 'direct board page should be included in entryFiles')
  assert(multiEntryProject.entryFiles.includes('schematics/PageB.tsx'), 'default-export wrapper page should be included in entryFiles')

  const hierarchyFsMap = createDefaultWorkspaceFsMap('Hierarchy WS')
  hierarchyFsMap['schematics/main.tsx'] = `export default () => (\n  <board>\n    <sheet name="Power" src="./power.tsx" />\n  </board>\n)`
  hierarchyFsMap['schematics/power.tsx'] = `export default () => (\n  <board>\n    <net name="VCC" />\n    <net name="GND" />\n  </board>\n)`
  const hierarchyProject = buildImportedProjectState(hierarchyFsMap) as any
  const hierarchyParsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(hierarchyFsMap['schematics/main.tsx'], 'schematics/main.tsx')
  assert(hierarchyProject.rootFile === 'schematics/main.tsx', 'main.tsx should be selected as the root schematic')
  assert((hierarchyProject.hierarchy?.['schematics/main.tsx'] || []).includes('schematics/power.tsx'), 'sheet references should build a parent-child hierarchy')
  assert(hierarchyProject.dependencyGraph['schematics/main.tsx']?.imports.includes('schematics/power.tsx'), 'sheet references should participate in the dependency graph')
  assert(hierarchyParsed.components.some(c => c.catalogId === 'sheet-instance' && c.props.sheetPath === 'schematics/power.tsx'), 'sheet references should render as sheet blocks on the parent canvas')

  // 4) Export workspace JSON
  const exported: WorkspaceExport = exportWorkspaceJson(originalWorkspace.name, originalWorkspace.fsMap)
  const payload = JSON.stringify(exported, null, 2)

  // 5) Re-import workspace JSON
  const imported = importWorkspaceJson(payload)
  const importedWorkspace: WorkspaceState = {
    id: 'import1',
    name: imported.name,
    fsMap: imported.files,
    activeFilePath: SCHEMATIC_MAIN
  }

  // 6) Compare full workspace
  assert(workspacesEqual(originalWorkspace, importedWorkspace), 'workspacesEqual(original, imported) failed')

  // Mandatory checks
  assert(importedWorkspace.fsMap[SCHEMATIC_MAIN] != null, 'missing schematics/main.tsx')
  assert(importedWorkspace.fsMap['project.json'] != null, 'missing project.json')
  assert(importedWorkspace.fsMap['symbols/index.ts'] != null, 'missing symbols/index.ts')
  assert(importedWorkspace.fsMap['symbols/TestSymbol.tsx'] != null, 'missing symbol file')
  assert(importedWorkspace.fsMap['subcircuits/index.ts'] != null, 'missing subcircuits/index.ts')
  assert(importedWorkspace.fsMap['subcircuits/EFR_t1.tsx'] != null, 'missing subcircuit file')
  assert(importedWorkspace.fsMap['editor/meta.json'] != null, 'missing editor/meta.json')

  // Nets preserved
  assert(importedWorkspace.fsMap[SCHEMATIC_MAIN].includes('net.VIN'), 'VIN net not preserved')
  assert(importedWorkspace.fsMap[SCHEMATIC_MAIN].includes('net.VOUT'), 'VOUT net not preserved')

  // Ports preserved
  assert(importedWorkspace.fsMap['subcircuits/EFR_t1.tsx'].includes('"VIN"'), 'VIN port not preserved')
  assert(importedWorkspace.fsMap['subcircuits/EFR_t1.tsx'].includes('"VOUT"'), 'VOUT port not preserved')

  // Imported registries should discover linked project content.
  importedWorkspace.fsMap['subcircuits/NamedBlock.tsx'] = `export const ports = ["IN", "OUT"] as const\n\nexport function DebounceBlock(props: { name: string; schX?: number; schY?: number }) {\n  return (\n    <subcircuit name={props.name}>\n      <resistor name="R_db" resistance="10k" />\n    </subcircuit>\n  )\n}\n`
  importedWorkspace.fsMap['subcircuits/TaggedPorts.tsx'] = `export function TaggedPorts(props: { name: string; schX?: number; schY?: number }) {\n  return (\n    <subcircuit name={props.name}>\n      <port name="VIN" />\n      <port name="VOUT" />\n      <port name="GND" />\n    </subcircuit>\n  )\n}\n`
  importedWorkspace.fsMap['subcircuits/InvalidDefault.tsx'] = `export default () => (\n  <subcircuit>\n    <resistor name="R_bad" resistance="1k" />\n  </subcircuit>\n)`

  const importedSubcircuits = extractAllSubcircuits(importedWorkspace.fsMap)
  const importedSymbols = extractAllSymbols(importedWorkspace.fsMap)
  const importedEFR = importedSubcircuits.find(s => s.name === 'EFR_t1')
  const importedDebounce = importedSubcircuits.find(s => s.name === 'DebounceBlock')
  const importedTaggedPorts = importedSubcircuits.find(s => s.name === 'TaggedPorts')
  assert(!!importedEFR, 'subcircuit registry missing imported EFR_t1')
  assert((importedEFR?.ports || []).includes('VIN'), 'subcircuit registry missing VIN port')
  assert((importedEFR?.ports || []).includes('VOUT'), 'subcircuit registry missing VOUT port')
  assert(!!importedDebounce, 'subcircuit registry should use the named exported component for composition')
  assert(importedDebounce?.filePath === 'subcircuits/NamedBlock.tsx', 'subcircuit registry should preserve the real source file path')
  assert((importedTaggedPorts?.ports || []).length === 3, 'subcircuit registry should preserve multiple public ports from explicit <port /> tags')
  assert((importedTaggedPorts?.ports || []).includes('VIN') && (importedTaggedPorts?.ports || []).includes('VOUT') && (importedTaggedPorts?.ports || []).includes('GND'), 'tagged public ports should remain visible in the registry')
  assert(!importedSubcircuits.some(s => s.filePath === 'subcircuits/InvalidDefault.tsx'), 'default-export anonymous subcircuits should be rejected from the registry')
  assert(importedSymbols.some(s => s.name === 'TestSymbol'), 'symbol registry missing imported TestSymbol')

  // Metadata preserved
  const originalMeta = JSON.parse(originalWorkspace.fsMap['editor/meta.json'])
  const importedMeta = JSON.parse(importedWorkspace.fsMap['editor/meta.json'])
  assert(JSON.stringify(stableObject(originalMeta)) === JSON.stringify(stableObject(importedMeta)), 'editor metadata not preserved')

  // Step 3A checks: file tree should represent real workspace roots/files.
  const fileTree = buildProjectFileTree(importedWorkspace.fsMap)
  const rootChildren = fileTree.children || []
  const rootFolderNames = rootChildren
    .filter(node => node.type === 'folder')
    .map(node => node.name)
  const rootFileNames = rootChildren
    .filter(node => node.type === 'file')
    .map(node => node.name)

  assert(rootFolderNames.includes('schematics'), 'file tree missing schematics/ folder')
  assert(rootFolderNames.includes('subcircuits'), 'file tree missing subcircuits/ folder')
  assert(rootFolderNames.includes('symbols'), 'file tree missing symbols/ folder')
  assert(rootFolderNames.includes('raw'), 'file tree missing raw/ folder')
  assert(rootFolderNames.includes('editor'), 'file tree missing editor/ folder')
  const rawFolder = rootChildren.find(node => node.type === 'folder' && node.name === 'raw')
  const rawFiles = rawFolder?.children?.filter(node => node.type === 'file').map(node => node.name) || []
  assert(rawFiles.includes('project.json'), 'file tree missing raw/project.json')

  const editorFolder = rootChildren.find(node => node.type === 'folder' && node.name === 'editor')
  const editorFiles = editorFolder?.children?.filter(node => node.type === 'file').map(node => node.name) || []
  assert(editorFiles.includes('meta.json'), 'file tree missing editor/meta.json')

  // Step 3A checks: active file/tab switching must stay scoped per workspace.
  const state = useEditorStore.getState()
  state.createWorkspace('Step3A WS A')
  const wsA = useEditorStore.getState().activeWorkspaceId

  const wsAFsMap = createDefaultWorkspaceFsMap('Step3A WS A')
  wsAFsMap['subcircuits/BlockA.tsx'] = `export const ports = ["IN", "OUT"] as const\n\nexport function BlockA(props: { name: string; schX?: number; schY?: number }) {\n  return <subcircuit name={props.name}></subcircuit>\n}`
  useEditorStore.getState().setFSMap(wsAFsMap)
  useEditorStore.getState().setActiveFilePath('subcircuits/BlockA.tsx')

  useEditorStore.getState().createWorkspace('Step3A WS B')
  const wsB = useEditorStore.getState().activeWorkspaceId

  const wsBFsMap = createDefaultWorkspaceFsMap('Step3A WS B')
  wsBFsMap['symbols/IconB.tsx'] = `export const IconB = () => <symbol />`
  useEditorStore.getState().setFSMap(wsBFsMap)
  useEditorStore.getState().setActiveFilePath('symbols/IconB.tsx')

  useEditorStore.getState().switchWorkspace(wsA)
  const stateA = useEditorStore.getState()
  assert(stateA.activeWorkspaceId === wsA, 'failed to switch back to workspace A')
  assert(stateA.activeFilePath === 'subcircuits/BlockA.tsx', 'workspace A active file not restored')
  assert(stateA.openFilePaths.includes('subcircuits/BlockA.tsx'), 'workspace A open tabs not restored')
  assert(!stateA.openFilePaths.includes('symbols/IconB.tsx'), 'workspace A tabs leaked from workspace B')

  useEditorStore.getState().switchWorkspace(wsB)
  const stateB = useEditorStore.getState()
  assert(stateB.activeWorkspaceId === wsB, 'failed to switch to workspace B')
  assert(stateB.activeFilePath === 'symbols/IconB.tsx', 'workspace B active file not restored')
  assert(stateB.openFilePaths.includes('symbols/IconB.tsx'), 'workspace B open tabs not restored')
  assert(!stateB.openFilePaths.includes('subcircuits/BlockA.tsx'), 'workspace B tabs leaked from workspace A')

  // Step 3A file-type classification and mode checks.
  assert(classifyFilePath('schematics/main.tsx') === 'board-tsx', 'classification failed for schematics/*.tsx')
  assert(classifyFilePath('subcircuits/EFR_t1.tsx') === 'subcircuit-tsx', 'classification failed for subcircuits/*.tsx')
  assert(classifyFilePath('symbols/TestSymbol.tsx') === 'symbol-component-tsx', 'classification failed for symbols/*.tsx')
  assert(classifyFilePath('subcircuits/index.ts') === 'source-ts', 'classification failed for *.ts')
  assert(classifyFilePath('project.json') === 'json', 'classification failed for *.json')

  const store = useEditorStore.getState()
  const modeFsMap = createDefaultWorkspaceFsMap('Step3A File Modes')
  modeFsMap['schematics/main.tsx'] = fsMap[SCHEMATIC_MAIN]
  modeFsMap['editor/meta.json'] = JSON.stringify({ netAnchors: {}, layout: { title: 'meta' } }, null, 2)
  modeFsMap['project.json'] = JSON.stringify({ name: 'Step3A File Modes', version: 1, type: 'workspace' }, null, 2)
  modeFsMap['subcircuits/index.ts'] = 'export { EFR_t1 } from "./EFR_t1"\n'
  modeFsMap['subcircuits/EFR_t1.tsx'] = fsMap['subcircuits/EFR_t1.tsx']
  store.setFSMap(modeFsMap)

  useEditorStore.getState().setActiveFilePath('schematics/main.tsx')
  const schematicState = useEditorStore.getState()
  assert(schematicState.placedComponents.length > 0, 'schematic file should activate canvas mode')

  const projectJsonBefore = useEditorStore.getState().fsMap['project.json']
  useEditorStore.getState().setActiveFilePath('project.json')
  const projectJsonState = useEditorStore.getState()
  assert(projectJsonState.placedComponents.length === 0, 'project.json should not populate canvas components')
  assert(projectJsonState.wires.length === 0, 'project.json should not populate canvas wires')
  useEditorStore.getState().regenerateTSX()
  const projectJsonAfter = useEditorStore.getState().fsMap['project.json']
  assert(projectJsonAfter === projectJsonBefore, 'project.json should not be rewritten as TSX')

  const editorMetaBefore = useEditorStore.getState().fsMap['editor/meta.json']
  useEditorStore.getState().setActiveFilePath('editor/meta.json')
  const editorMetaState = useEditorStore.getState()
  assert(editorMetaState.placedComponents.length === 0, 'editor/meta.json should not populate canvas components')
  assert(editorMetaState.wires.length === 0, 'editor/meta.json should not populate canvas wires')
  useEditorStore.getState().regenerateTSX()
  const editorMetaAfter = useEditorStore.getState().fsMap['editor/meta.json']
  assert(editorMetaAfter === editorMetaBefore, 'editor/meta.json should not be rewritten as TSX')

  useEditorStore.getState().setActiveFilePath('subcircuits/index.ts')
  const sourceState = useEditorStore.getState()
  assert(sourceState.placedComponents.length === 0, 'subcircuits/index.ts should be source-only mode')
  assert(sourceState.wires.length === 0, 'subcircuits/index.ts should be source-only mode')

  // Import linkage + placement: imported registry items should be placeable and persisted in schematic TSX.
  const linkFsMap = createDefaultWorkspaceFsMap('Step3A Import Linkage')
  linkFsMap['schematics/main.tsx'] = importedWorkspace.fsMap['schematics/main.tsx']
  linkFsMap['subcircuits/index.ts'] = importedWorkspace.fsMap['subcircuits/index.ts']
  linkFsMap['subcircuits/EFR_t1.tsx'] = importedWorkspace.fsMap['subcircuits/EFR_t1.tsx']
  linkFsMap['subcircuits/NamedBlock.tsx'] = importedWorkspace.fsMap['subcircuits/NamedBlock.tsx']
  linkFsMap['symbols/index.ts'] = importedWorkspace.fsMap['symbols/index.ts']
  linkFsMap['symbols/TestSymbol.tsx'] = importedWorkspace.fsMap['symbols/TestSymbol.tsx']
  linkFsMap['editor/meta.json'] = importedWorkspace.fsMap['editor/meta.json']

  useEditorStore.getState().setFSMap(linkFsMap)
  useEditorStore.getState().setActiveFilePath('schematics/main.tsx')
  const linkedMainBefore = useEditorStore.getState().fsMap['schematics/main.tsx'] || ''
  const subBeforeCount = (linkedMainBefore.match(/<EFR_t1\b/g) || []).length
  const symbolBeforeCount = (linkedMainBefore.match(/<TestSymbol\b/g) || []).length

  useEditorStore.getState().addPlacedComponent({
    id: 'validate-sub-instance',
    catalogId: 'subcircuit-instance',
    name: 'EFR_t1_TEST',
    props: {
      subcircuitName: 'EFR_t1',
      ports: ['VIN', 'VOUT'],
      schX: 320,
      schY: 220
    },
    tsxSnippet: ''
  })
  useEditorStore.getState().addPlacedComponent({
    id: 'validate-symbol-instance',
    catalogId: 'subcircuit-instance',
    name: 'TestSymbol1',
    props: {
      subcircuitName: 'TestSymbol',
      subcircuitPath: 'symbols/TestSymbol.tsx',
      ports: ['IN', 'OUT'],
      schX: 120,
      schY: 180
    },
    tsxSnippet: ''
  })
  useEditorStore.getState().insertSubcircuitInstance('DebounceBlock', {
    schX: 420,
    schY: 260,
    filePath: 'subcircuits/NamedBlock.tsx'
  })

  const linkedMain = useEditorStore.getState().fsMap['schematics/main.tsx'] || ''
  const subAfterCount = (linkedMain.match(/<EFR_t1\b/g) || []).length
  const symbolAfterCount = (linkedMain.match(/<TestSymbol\b/g) || []).length
  assert(subAfterCount > subBeforeCount, 'placing imported subcircuit should persist to schematic')
  assert(symbolAfterCount > symbolBeforeCount, 'placing imported symbol should persist to schematic')
  assert(linkedMain.includes('import { DebounceBlock } from "../subcircuits/NamedBlock"'), 'named subcircuit insertion should import from the real backing file')
  assert(linkedMain.includes('<DebounceBlock'), 'named subcircuit insertion should compose the exported component into the board')

  // Batch import must rebuild the subcircuit registry and enable patch composition.
  useEditorStore.getState().createWorkspace('Batch Patch Flow')
  useEditorStore.getState().importFilesBatch([
    {
      fileName: 'Deb_button_test2.tsx',
      content: `export const ports = ["IN", "OUT"] as const

export function Deb_button_test2(props: { name: string; schX?: number; schY?: number }) {
  return (
    <subcircuit name={props.name}>
      <resistor name="R_btn" resistance="10k" />
    </subcircuit>
  )
}`
    },
    {
      fileName: 'Debounce_led.tsx',
      content: `export const ports = ["IN", "OUT"] as const

export function Debounce_led(props: { name: string; schX?: number; schY?: number }) {
  return (
    <subcircuit name={props.name}>
      <led name="D_led" color="red" />
    </subcircuit>
  )
}`
    },
    {
      fileName: 'MainBoard.tsx',
      content: `export default () => (
  <board width="50mm" height="50mm">
    <chip name="U_BATCH" pinCount={8} />
  </board>
)`
    }
  ])

  const batchState = useEditorStore.getState()
  const batchRegistry = buildSubcircuitRegistry(batchState.fsMap)
  assert(batchState.activeFilePath === 'schematics/MainBoard.tsx', 'batch import should activate the imported schematic entry file')
  assert(!!batchRegistry.Deb_button_test2, 'batch import should register Deb_button_test2 as a reusable subcircuit')
  assert(!!batchRegistry.Debounce_led, 'batch import should register Debounce_led as a reusable subcircuit')

  useEditorStore.getState().applyPatch({
    id: 'validate-patch',
    name: 'Validate Patch',
    components: [
      { subcircuit: 'Deb_button_test2', instanceName: 'BTN1', schX: 140, schY: 180 },
      { subcircuit: 'Debounce_led', instanceName: 'LED1', schX: 320, schY: 180 }
    ],
    wiring: [
      '<trace from=".BTN1 > .OUT" to=".LED1 > .IN" />'
    ]
  })

  const patchedMain = useEditorStore.getState().fsMap['schematics/MainBoard.tsx'] || ''
  assert(patchedMain.includes('import { Deb_button_test2 } from "../subcircuits/Deb_button_test2"'), 'patch application should import Deb_button_test2 through the registry path')
  assert(patchedMain.includes('import { Debounce_led } from "../subcircuits/Debounce_led"'), 'patch application should import Debounce_led through the registry path')
  assert(patchedMain.includes('<Deb_button_test2'), 'patch application should compose the first imported subcircuit into the board')
  assert(patchedMain.includes('<Debounce_led'), 'patch application should compose the second imported subcircuit into the board')

  // Dependency graph and component usage must track file relationships and protect delete operations.
  const depFsMap = createDefaultWorkspaceFsMap('Dependency Graph WS')
  depFsMap['schematics/MainDeps.tsx'] = `import { Deb_button_test2 } from "../subcircuits/Deb_button_test2"
import { Debounce_led } from "../subcircuits/Debounce_led"

export default () => (
  <board width="50mm" height="50mm">
    <Deb_button_test2 name="BTN1" />
    <Debounce_led name="LED1" />
    <trace from=".BTN1 > .OUT" to=".LED1 > .IN" />
  </board>
)`
  depFsMap['subcircuits/Deb_button_test2.tsx'] = `export const ports = ["IN", "OUT"] as const

export function Deb_button_test2(props: { name: string }) {
  return <subcircuit name={props.name}></subcircuit>
}`
  depFsMap['subcircuits/Debounce_led.tsx'] = `export const ports = ["IN", "OUT"] as const

export function Debounce_led(props: { name: string }) {
  return <subcircuit name={props.name}></subcircuit>
}`

  const importedProject = buildImportedProjectState(depFsMap)
  const dependencyGraph = buildDependencyGraph(depFsMap)
  const componentUsage = buildComponentUsage(depFsMap)
  assert(importedProject.entryFiles.includes('schematics/MainDeps.tsx'), 'batch import project state should register schematic entry files')
  assert(importedProject.registry.Deb_button_test2 === 'subcircuits/Deb_button_test2.tsx', 'project registry should map subcircuit export names to their real files')
  assert(dependencyGraph['schematics/MainDeps.tsx']?.imports.includes('subcircuits/Deb_button_test2.tsx'), 'dependency graph should link main schematic imports to imported subcircuits')
  assert(dependencyGraph['subcircuits/Deb_button_test2.tsx']?.usedBy.includes('schematics/MainDeps.tsx'), 'dependency graph should compute reverse usage for safe delete')
  assert(componentUsage['Deb_button_test2']?.includes('schematics/MainDeps.tsx'), 'component usage map should track where a subcircuit is instantiated')

  useEditorStore.getState().createWorkspace('Delete Guard WS')
  useEditorStore.getState().setFSMap(depFsMap)
  useEditorStore.getState().setActiveFilePath('schematics/MainDeps.tsx')
  useEditorStore.getState().deleteFile('subcircuits/Deb_button_test2.tsx')
  const deleteGuardState = useEditorStore.getState()
  assert(!!deleteGuardState.fsMap['subcircuits/Deb_button_test2.tsx'], 'safe delete should prevent removing a file that is still used by a schematic')

  // Public-port selection should expose all real pins on selected components, not only one boundary signal.
  useEditorStore.getState().createWorkspace('Public Port WS')
  const portFsMap = createDefaultWorkspaceFsMap('Public Port WS')
  portFsMap['schematics/main.tsx'] = `export default () => (
  <board width="50mm" height="50mm">
    {/* // schX={120} */}
    {/* // schY={120} */}
    <resistor name="R_PORT" resistance="1k" schRotation="0deg" />

    {/* // schX={220} */}
    {/* // schY={120} */}
    <capacitor name="C_PORT" capacitance="1uF" schRotation="0deg" />

    {/* // schX={40} */}
    {/* // schY={120} */}
    <net name="SIGNAL" schRotation="0deg" />

    <trace from="net.SIGNAL" to=".R_PORT > .pin1" />
    <trace from=".R_PORT > .pin2" to=".C_PORT > .pin1" />
  </board>
)`
  useEditorStore.getState().setFSMap(portFsMap)
  useEditorStore.getState().setActiveFilePath('schematics/main.tsx')
  const portSelectionState = useEditorStore.getState()
  const portComponentIds = portSelectionState.placedComponents
    .filter(component => component.name === 'R_PORT' || component.name === 'C_PORT')
    .map(component => component.id)
  useEditorStore.getState().beginSubcircuitPinSelection(portComponentIds)
  const candidatePins = useEditorStore.getState().subcircuitCreation.candidatePins
  assert(candidatePins.length >= 3, 'subcircuit public-port selection should include multiple pins from the selected components')
  assert(candidatePins.some(pin => pin.pinName === 'pin2'), 'non-boundary component pins should still be exposable as public ports')
  useEditorStore.getState().cancelSubcircuitPinSelection()

  // EFR import flow: relocate symbol-components, rewrite imports, prefer efr_t2_main.tsx as root,
  // remove the invalid SWD shorts, and render named nets as local anchors instead of one giant shared wire.
  useEditorStore.getState().createWorkspace('EFR Import WS')
  useEditorStore.getState().importFilesBatch([
    {
      fileName: 'EFR32BG12P332F1024GL125_Power.tsx',
      content: `import React from "react"
import type { ChipProps } from "@tscircuit/props"

const pinLabels = {
  RESETN: [1],
  BODEN: [2],
  VREGVDD: [3],
  AVDD: [4],
  IOVDD_1: [5],
  IOVDD_2: [6],
  IOVDD_3: [7],
  IOVDD_4: [8],
  VREGSW: [9],
  DVDD: [10],
  DECOUPLE: [11],
  VREGVSS_1: [12],
  VREGVSS_2: [13],
  VREGVSS_3: [14],
} as const

export default function EFR32PowerChip(
  props: ChipProps<typeof pinLabels>,
) {
  return (
    <chip
      {...props}
      pinLabels={pinLabels}
      symbol={
        <symbol>
          <port name="RESETN" schX={-21} schY={9} direction="left" />
          <port name="DVDD" schX={21} schY={4} direction="right" />
          <port name="VREGVSS_1" schX={21} schY={-4} direction="right" />
        </symbol>
      }
    />
  )
}`
    },
    {
      fileName: 'EFR32PowerConnections.tsx',
      content: `import React from "react"
import EFR32Power from "./EFR32BG12P332F1024GL125_Power"

export default function EFR32PowerConnections() {
  return (
    <board width="90mm" height="70mm">
      <EFR32Power name="U1C" schX={40} schY={30} />
      <capacitor name="C1" capacitance="100nF" schX={66} schY={27} />
      <trace from=".U1C > .DVDD" to=".C1 > .pin1" />
    </board>
  )
}`
    },
    {
      fileName: 'efr_t2.tsx',
      content: `import React from "react"
import type { ChipProps } from "@tscircuit/props"

const pinLabels = {
  pin1: "RESETN",
  pin2: "BODEN",
  pin3: "VREGVDD",
  pin4: "AVDD",
  pin5: "IOVDD_1",
  pin6: "IOVDD_2",
  pin7: "IOVDD_3",
  pin8: "IOVDD_4",
  pin9: "VREGSW",
  pin10: "DVDD",
  pin11: "DECOUPLE",
  pin12: "VREGVSS_1",
  pin13: "VREGVSS_2",
  pin14: "VREGVSS_3",
} as const

export default function EFR32Power(
  props: ChipProps<typeof pinLabels>,
) {
  return (
    <chip
      {...props}
      pinLabels={pinLabels}
      symbol={
        <symbol>
          <port name="RESETN" schX={-15} schY={9} />
          <port name="BODEN" schX={-15} schY={7} />
          <port name="VREGVDD" schX={-15} schY={4} />
          <port name="AVDD" schX={-15} schY={1} />
          <port name="IOVDD_1" schX={-15} schY={-2} />
          <port name="IOVDD_2" schX={-15} schY={-4} />
          <port name="IOVDD_3" schX={-15} schY={-6} />
          <port name="IOVDD_4" schX={-15} schY={-8} />
          <port name="VREGSW" schX={15} schY={7} />
          <port name="DVDD" schX={15} schY={4} />
          <port name="DECOUPLE" schX={15} schY={1} />
          <port name="VREGVSS_1" schX={15} schY={-4} />
          <port name="VREGVSS_2" schX={15} schY={-6} />
          <port name="VREGVSS_3" schX={15} schY={-8} />
        </symbol>
      }
    />
  )
}`
    },
    {
      fileName: 'efr_t2_main.tsx',
      content: `import React from "react"
import EFR32Power from "./efr_t2"

export default function EFR32PowerConnections() {
  return (
    <board width="95mm" height="70mm">
      <EFR32Power name="U1C" schX={48} schY={34} />
      <resistor name="R1" resistance="NR" footprint="0402" schX={15} schY={27} />
      <capacitor name="C8" capacitance="10uF" footprint="0402" schX={15} schY={45} />
      <capacitor name="C9" capacitance="10nF" footprint="0402" schX={21} schY={45} />
      <capacitor name="C10" capacitance="1uF" footprint="0402" schX={27} schY={45} />
      <capacitor name="C11" capacitance="100nF" footprint="0402" schX={33} schY={45} />
      <net name="DVDD" isForPower />
      <net name="GND" isGround />
      <net name="SWDIO" />
      <net name="SWCLK" />
      <trace from=".R1 > .pin1" to="net.DVDD" />
      <trace from=".R1 > .pin2" to=".U1C > .BODEN" />
      <trace from="net.DVDD" to=".C8 > .pin1" />
      <trace from=".C8 > .pin1" to=".C9 > .pin1" />
      <trace from=".C9 > .pin1" to=".C10 > .pin1" />
      <trace from=".C10 > .pin1" to=".C11 > .pin1" />
      <trace from=".C8 > .pin1" to=".U1C > .AVDD" />
      <trace from=".C8 > .pin1" to=".U1C > .IOVDD_1" />
      <trace from=".C8 > .pin1" to=".U1C > .IOVDD_2" />
      <trace from=".C8 > .pin1" to=".U1C > .IOVDD_3" />
      <trace from=".C8 > .pin1" to=".U1C > .IOVDD_4" />
      <trace from=".C8 > .pin2" to="net.GND" />
      <trace from=".C9 > .pin2" to="net.GND" />
      <trace from=".C10 > .pin2" to="net.GND" />
      <trace from=".C11 > .pin2" to="net.GND" />
      <trace from="net.DVDD" to="net.SWDIO" />
      <trace from="net.DVDD" to="net.SWCLK" />
    </board>
  )
}`
    }
  ])

  const efrState = useEditorStore.getState()
  const efrProject = buildImportedProjectState(efrState.fsMap)
  const efrSymbols = extractAllSymbols(efrState.fsMap)
  const efrMain = efrState.fsMap['schematics/efr_t2_main.tsx'] || ''
  const efrReference = efrState.fsMap['schematics/EFR32PowerConnections.tsx'] || ''
  const efrPrimarySymbol = efrSymbols.find(symbol => symbol.name === 'EFR32Power')

  assert(efrState.activeFilePath === 'schematics/efr_t2_main.tsx', 'EFR batch import should activate efr_t2_main.tsx as the main schematic')
  assert(efrProject.rootFile === 'schematics/efr_t2_main.tsx', 'EFR project should prefer efr_t2_main.tsx as the root schematic')
  assert(classifyFilePath('symbols/efr_t2.tsx') === 'symbol-component-tsx', 'EFR symbol file should open in source-editor mode')
  assert(!!efrState.fsMap['symbols/efr_t2.tsx'], 'EFR symbol component should relocate under symbols/')
  assert(!!efrState.fsMap['symbols/EFR32BG12P332F1024GL125_Power.tsx'], 'Secondary EFR symbol should relocate under symbols/')
  assert(!!efrPrimarySymbol && efrPrimarySymbol.filePath === 'symbols/efr_t2.tsx', 'EFR32Power should prefer efr_t2.tsx as its primary symbol component')
  assert(
    (efrPrimarySymbol?.ports || []).some(port => port.name === 'DVDD')
      && (efrPrimarySymbol?.ports || []).some(port => port.name === 'RESETN'),
    'Symbol-component ports should be extracted from the embedded <symbol>'
  )
  assert(efrMain.includes('import EFR32Power from "../symbols/efr_t2"'), 'Main EFR board import should be rewritten to the relocated symbol path')
  assert(efrReference.includes('import EFR32Power from "../symbols/EFR32BG12P332F1024GL125_Power"'), 'Reference EFR board import should be rewritten to the relocated secondary symbol path')
  assert(!efrMain.includes('<trace from="net.DVDD" to="net.SWDIO" />'), 'Invalid DVDD to SWDIO short should be removed during import')
  assert(!efrMain.includes('<trace from="net.DVDD" to="net.SWCLK" />'), 'Invalid DVDD to SWCLK short should be removed during import')
  assert(validateImports(efrState.fsMap).length === 0, 'EFR import should not leave broken relocated imports behind')

  const dvddAnchors = efrState.placedComponents.filter(component => component.catalogId === 'netport' && String(component.props.netName || component.name) === 'DVDD')
  const gndAnchors = efrState.placedComponents.filter(component => component.catalogId === 'netport' && String(component.props.netName || component.name) === 'GND')
  assert(dvddAnchors.length > 1, 'Named DVDD net should render as multiple local anchors, not one shared continuous wire hub')
  assert(gndAnchors.length > 1, 'Named GND net should render as multiple local anchors, not one shared continuous wire hub')

  // Cross-workspace availability: a created subcircuit must persist in workspace model.
  useEditorStore.getState().createWorkspace('WS Persist A')
  const wsPersistA = useEditorStore.getState().activeWorkspaceId
  useEditorStore.getState().addPlacedComponent({
    id: 'persist-chip-a',
    catalogId: 'customchip',
    name: 'U_PERSIST',
    props: { schX: 100, schY: 100, pinCount: 2, leftPins: 1, rightPins: 1, topPins: 0, bottomPins: 0 },
    tsxSnippet: ''
  })
  useEditorStore.getState().createSubcircuit('PersistedBlock', ['persist-chip-a'], [
    { componentId: 'persist-chip-a', pinName: 'L1', portName: 'IN' },
    { componentId: 'persist-chip-a', pinName: 'R1', portName: 'OUT' }
  ])

  const afterCreateState = useEditorStore.getState()
  assert(!!afterCreateState.workspaces[wsPersistA].fsMap['subcircuits/PersistedBlock.tsx'], 'created subcircuit not persisted into workspace fsMap')
  assert(afterCreateState.workspaces[wsPersistA].fsMap['subcircuits/PersistedBlock.tsx'].includes('export const ports = ["IN", "OUT"] as const'), 'created subcircuit should preserve multiple public ports in file output')

  const layoutProbe = await layoutCircuit(
    [
      {
        id: 'elk-chip',
        catalogId: 'customchip',
        name: 'U_ELK',
        props: {
          pinCount: 2,
          leftPins: 1,
          rightPins: 1,
          pinNames: 'L1=RESETN,R1=DVDD'
        }
      },
      {
        id: 'elk-r',
        catalogId: 'resistor',
        name: 'R_ELK',
        props: { schX: 0, schY: 0 }
      }
    ] as any,
    [
      {
        from: { componentId: 'elk-chip', pinName: 'DVDD' },
        to: { componentId: 'elk-r', pinName: 'pin1' }
      }
    ]
  )
  const elkRoute = layoutProbe.routes.get('edge-0') || []
  assert(layoutProbe.positions.has('elk-chip') && layoutProbe.positions.has('elk-r'), 'ELK should return node positions for declared components')
  assert(elkRoute.length >= 2, 'ELK should persist orthogonal route points for declared port-to-port edges')
  assert(elkRoute.every((point, index, points) => index === 0 || point.x === points[index - 1].x || point.y === points[index - 1].y), 'ELK routes should remain Manhattan-style between consecutive points')

  useEditorStore.getState().createWorkspace('WS Persist B')
  const wsPersistB = useEditorStore.getState().activeWorkspaceId
  const otherWorkspaceSubcircuits = Object.values(useEditorStore.getState().workspaces)
    .filter(ws => ws.id !== wsPersistB)
    .flatMap(ws => Object.keys(ws.fsMap).filter(path => path.startsWith('subcircuits/') && path.endsWith('.tsx')))
  assert(otherWorkspaceSubcircuits.includes('subcircuits/PersistedBlock.tsx'), 'created subcircuit should be discoverable from another workspace')

  console.log('✅ PASS validate-workspace')
}

run().catch((error) => {
  const failure = error instanceof Error ? error : new Error(String(error))
  console.error('❌ FAIL validate-workspace')
  console.error(failure.message)
  throw failure
})
