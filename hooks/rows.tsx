import type { ClientModule } from 'claude-code'

export type Seg = { t: string; c?: string; b?: boolean; s?: boolean; i?: boolean; sh?: string; dim?: boolean; one?: boolean }
export type RowSpec = { id: string; left: Seg[]; right: Seg[] }
export type RowsProps = { rows: RowSpec[]; active: string; activeBg: string; hoverBg: string; tones: Record<string, { bright: string[]; dim: string[] }> }
type Local = { hover: number; phase: number; ref: { lit: boolean } }

const TICK_MS = 90

function shimmer(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.6) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#f97316'
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    const ref = { lit: false }
    surface.setState({ hover: -1, phase: 0, ref })
    surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur?.ref.lit) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  }
  const state = surface.state ?? { hover: -1, phase: 0, ref: { lit: false } }
  state.ref.lit = props.rows.some(r => r.left.some(s => s.sh))
  surface.onPointer(e => {
    const cur = surface.state ?? state
    if (e.type === 'leave' || e.y < 0 || e.y >= props.rows.length) {
      if (cur.hover !== -1) surface.setState({ ...cur, hover: -1 })
      return
    }
    if (e.type === 'move' && !e.button && cur.hover !== e.y) surface.setState({ ...cur, hover: e.y })
    const row = props.rows[e.y]
    if (e.type === 'down' && (e.button ?? 'left') === 'left' && row?.id) surface.post({ press: row.id, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) })
  })
  surface.onKey(e => surface.post({ key: e.key, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) }))
  const draw = (s: Seg) => {
    const palette = s.sh ? (s.dim ? props.tones[s.sh]?.dim : props.tones[s.sh]?.bright) : undefined
    if (!palette) {
      return (
        <Text color={s.c} bold={s.b} strikethrough={s.s} italic={s.i}>
          {s.t}
        </Text>
      )
    }
    if (s.one) {
      return (
        <Text color={shimmer(-1, state.phase, s.t.length, palette)}>
          {s.t}
        </Text>
      )
    }
    const chars = [...s.t]
    return (
      <Text bold={s.b}>
        {chars.map((ch, i) => (
          <Text color={shimmer(i, state.phase, chars.length, palette)}>{ch}</Text>
        ))}
      </Text>
    )
  }
  return (
    <Box flexDirection="column">
      {props.rows.map((r, i) => (
        <Box
          flexDirection="row"
          height={1}
          overflow="hidden"
          backgroundColor={r.id && r.id === props.active ? props.activeBg : r.id && i === state.hover ? props.hoverBg : undefined}
        >
          <Box flexShrink={1} overflow="hidden">
            {r.left.map(draw)}
          </Box>
          <Box flexGrow={1} />
          {r.right.map(draw)}
        </Box>
      ))}
    </Box>
  )
}

export default Rows
