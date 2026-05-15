import { CatalogItem } from '../types/catalog'

// Schematic Line catalog item
export const SchematicLineItem: CatalogItem = {
  metadata: {
    id: 'schematicline',
    label: 'Schematic Line',
    kind: 'part',
    category: 'Primitives',
    description: 'Draw a line in symbol',
    editablePropsSchema: {
      x1: {
        type: 'number',
        label: 'X1',
        default: 0
      },
      y1: {
        type: 'number',
        label: 'Y1',
        default: 0
      },
      x2: {
        type: 'number',
        label: 'X2',
        default: 10
      },
      y2: {
        type: 'number',
        label: 'Y2',
        default: 10
      }
    },
    defaultProps: {
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10
    }
  },
  emitTSX: (props) => {
    const { x1, y1, x2, y2 } = props
    return `<schematicline x1={${x1}} y1={${y1}} x2={${x2}} y2={${y2}} />`
  }
}

// Schematic Rectangle catalog item
export const SchematicRectItem: CatalogItem = {
  metadata: {
    id: 'schematicrect',
    label: 'Schematic Rect',
    kind: 'part',
    category: 'Primitives',
    description: 'Draw a rectangle in symbol',
    editablePropsSchema: {
      x: {
        type: 'number',
        label: 'X',
        default: 0
      },
      y: {
        type: 'number',
        label: 'Y',
        default: 0
      },
      width: {
        type: 'number',
        label: 'Width',
        default: 20
      },
      height: {
        type: 'number',
        label: 'Height',
        default: 20
      }
    },
    defaultProps: {
      x: 0,
      y: 0,
      width: 20,
      height: 20
    }
  },
  emitTSX: (props) => {
    const { x, y, width, height } = props
    const schX = Number(x) + Number(width) / 2
    const schY = Number(y) + Number(height) / 2
    return `<schematicrect schX={${schX}} schY={${schY}} width={${width}} height={${height}} />`
  }
}

// Schematic Circle catalog item
export const SchematicCircleItem: CatalogItem = {
  metadata: {
    id: 'schematiccircle',
    label: 'Schematic Circle',
    kind: 'part',
    category: 'Primitives',
    description: 'Draw a circle in symbol',
    editablePropsSchema: {
      cx: {
        type: 'number',
        label: 'Center X',
        default: 0
      },
      cy: {
        type: 'number',
        label: 'Center Y',
        default: 0
      },
      radius: {
        type: 'number',
        label: 'Radius',
        default: 10
      }
    },
    defaultProps: {
      cx: 0,
      cy: 0,
      radius: 10
    }
  },
  emitTSX: (props) => {
    const { cx, cy, radius } = props
    return `<schematiccircle center={{x: ${cx}, y: ${cy}}} radius={${radius}} />`
  }
}

// Schematic Arc catalog item
export const SchematicArcItem: CatalogItem = {
  metadata: {
    id: 'schematicarc',
    label: 'Schematic Arc',
    kind: 'part',
    category: 'Primitives',
    description: 'Draw an arc in symbol',
    editablePropsSchema: {
      cx: {
        type: 'number',
        label: 'Center X',
        default: 0
      },
      cy: {
        type: 'number',
        label: 'Center Y',
        default: 0
      },
      radius: {
        type: 'number',
        label: 'Radius',
        default: 10
      },
      startAngle: {
        type: 'number',
        label: 'Start Angle',
        default: 0
      },
      endAngle: {
        type: 'number',
        label: 'End Angle',
        default: 90
      }
    },
    defaultProps: {
      cx: 0,
      cy: 0,
      radius: 10,
      startAngle: 0,
      endAngle: 90
    }
  },
  emitTSX: (props) => {
    const { cx, cy, radius, startAngle, endAngle } = props
    return `<schematicarc center={{x: ${cx}, y: ${cy}}} radius={${radius}} startAngleDegrees={${startAngle}} endAngleDegrees={${endAngle}} direction="clockwise" />`
  }
}

// Schematic Path catalog item
export const SchematicPathItem: CatalogItem = {
  metadata: {
    id: 'schematicpath',
    label: 'Schematic Path',
    kind: 'part',
    category: 'Primitives',
    description: 'Draw a path in symbol',
    editablePropsSchema: {
      d: {
        type: 'string',
        label: 'Path Data',
        default: 'M 0 0 L 10 10'
      }
    },
    defaultProps: {
      d: 'M 0 0 L 10 10'
    }
  },
  emitTSX: (props) => {
    const { d } = props
    return `<schematicpath d="${d}" />`
  }
}

// Schematic Text catalog item
export const SchematicTextItem: CatalogItem = {
  metadata: {
    id: 'schematictext',
    label: 'Schematic Text',
    kind: 'part',
    category: 'Primitives',
    description: 'Draw text in symbol',
    editablePropsSchema: {
      text: {
        type: 'string',
        label: 'Text',
        default: 'Label'
      },
      x: {
        type: 'number',
        label: 'X',
        default: 0
      },
      y: {
        type: 'number',
        label: 'Y',
        default: 0
      }
    },
    defaultProps: {
      text: 'Label',
      x: 0,
      y: 0
    }
  },
  emitTSX: (props) => {
    const { text, x, y } = props
    return `<schematictext text="${text}" schX={${x}} schY={${y}} />`
  }
}
