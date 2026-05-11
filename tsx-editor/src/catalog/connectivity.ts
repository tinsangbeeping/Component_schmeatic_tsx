import { CatalogItem } from '../types/catalog'

// Trace (wire) catalog item
export const TraceItem: CatalogItem = {
  metadata: {
    id: 'trace',
    label: 'Trace (Wire)',
    kind: 'part',
    category: 'Connectivity',
    description: 'Connect two points',
    editablePropsSchema: {
      from: {
        type: 'string',
        label: 'From',
        default: '.R1 > .pin1'
      },
      to: {
        type: 'string',
        label: 'To',
        default: '.R2 > .pin2'
      }
    },
    defaultProps: {
      from: '.R1 > .pin1',
      to: '.R2 > .pin2'
    }
  },
  emitTSX: (props) => {
    const { from, to } = props
    return `<trace from="${from}" to="${to}" />`
  }
}

// Net Label catalog item
export const NetLabelItem: CatalogItem = {
  metadata: {
    id: 'netlabel',
    label: 'Net Label',
    kind: 'part',
    category: 'Connectivity',
    description: 'Label a net',
    editablePropsSchema: {
      net: {
        type: 'string',
        label: 'Net Name',
        default: 'VCC'
      },
      schX: {
        type: 'number',
        label: 'X Position',
        default: 0
      },
      schY: {
        type: 'number',
        label: 'Y Position',
        default: 0
      }
    },
    defaultProps: {
      net: 'VCC',
      schX: 0,
      schY: 0
    }
  },
  // Valid tscircuit tag: <netlabel net="NAME" />
  // schX/schY are editor-internal positioning; position is not part of tscircuit netlabel spec.
  emitTSX: (props) => {
    const { net } = props
    return `<netlabel net="${net}" />`
  }
}

// Net catalog item
export const NetItem: CatalogItem = {
  metadata: {
    id: 'net',
    label: 'Net',
    kind: 'part',
    category: 'Connectivity',
    description: 'Define a named net',
    editablePropsSchema: {
      name: {
        type: 'string',
        label: 'Net Name',
        default: 'VCC'
      }
    },
    defaultProps: {
      name: 'VCC'
    }
  },
  // 'net' is an internal editor placeholder for named nets.
  // tscircuit nets are implicit via trace selectors (net.NAME) and netlabel tags.
  // This item must NOT emit any JSX into exported tscircuit files.
  emitTSX: (_props) => ''
}

// Jumper catalog item
export const JumperItem: CatalogItem = {
  metadata: {
    id: 'jumper',
    label: 'Jumper',
    kind: 'part',
    category: 'Connectivity',
    description: 'Jumper connection',
    editablePropsSchema: {
      name: {
        type: 'string',
        label: 'Name',
        default: 'JP1'
      },
      schX: {
        type: 'number',
        label: 'X Position',
        default: 0
      },
      schY: {
        type: 'number',
        label: 'Y Position',
        default: 0
      }
    },
    defaultProps: {
      name: 'JP1',
      schX: 0,
      schY: 0
    }
  },
  // <jumper> is not a valid tscircuit JSX tag.
  // Physical jumpers should be represented as a two-pin passive component
  // with traces connecting each side; the editor treats this as a connectivity
  // aid only and does not emit it in tscircuit output.
  emitTSX: (_props) => ''
}

// Solder Jumper catalog item
export const SolderJumperItem: CatalogItem = {
  metadata: {
    id: 'solderjumper',
    label: 'Solder Jumper',
    kind: 'part',
    category: 'Connectivity',
    description: 'Solder bridge jumper',
    editablePropsSchema: {
      name: {
        type: 'string',
        label: 'Name',
        default: 'SJ1'
      },
      schX: {
        type: 'number',
        label: 'X Position',
        default: 0
      },
      schY: {
        type: 'number',
        label: 'Y Position',
        default: 0
      }
    },
    defaultProps: {
      name: 'SJ1',
      schX: 0,
      schY: 0
    }
  },
  emitTSX: (props) => {
    const { name, schX, schY } = props
    return `<solderjumper name="${name}" schX={${schX}} schY={${schY}} />`
  }
}
