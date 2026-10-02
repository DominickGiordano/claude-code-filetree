import type { ClientModule } from 'claude-code'

export type Seg = { t: string; c?: string; b?: boolean; s?: boolean; i?: boolean }
export type RowSpec = { id: string; left: Seg[]; right: Seg[] }
export type RowsProps = { rows: RowSpec[]; active: string; activeBg: string; hoverBg: string }
type Local = { hover: number }

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) surface.setState({ hover: -1 })
  surface.onPointer(e => {
      const row = props.rows[e.y]
      if (e.type === 'leave' || e.y < 0 || e.y >= props.rows.length) {
        if ((surface.state?.hover ?? -1) !== -1) surface.setState({ hover: -1 })
        return
      }
      if (e.type === 'move' && !e.button && (surface.state?.hover ?? -1) !== e.y) surface.setState({ hover: e.y })
      if (e.type === 'down' && row?.id) surface.post({ press: row.id, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift), button: e.button ?? 'left' })
  })
  surface.onKey(e => surface.post({ key: e.key, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) }))
  const hover = surface.state?.hover ?? -1
  return (
    <Box flexDirection="column">
      {props.rows.map((r, i) => (
        <Box
          flexDirection="row"
          backgroundColor={r.id && r.id === props.active ? props.activeBg : r.id && i === hover ? props.hoverBg : undefined}
        >
          {r.left.map(s => (
            <Text color={s.c} bold={s.b} strikethrough={s.s} italic={s.i}>
              {s.t}
            </Text>
          ))}
          <Box flexGrow={1} />
          {r.right.map(s => (
            <Text color={s.c} bold={s.b} italic={s.i}>
              {s.t}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export default Rows
