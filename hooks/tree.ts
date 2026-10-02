import type { Branch, FileNode, FileTree, Theme } from '../types'
import { stronger } from './icons'

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number; isLink: boolean }
export type Row = { node: FileNode; depth: number; open: boolean }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const DEFAULT_THEME: Theme = {
  fg: '#cacccc',
  accent: '#cacccc',
  muted: '#707880',
  urgent: '#a55555',
  selection: '#2a2e3a',
}

export function emptyTree(root: string): FileTree {
  return {
    root,
    nodes: [],
    expanded: [],
    cursor: '',
    selected: '',
    query: '',
    showHidden: true,
    git: {},
    diff: {},
    ignored: [],
    untrackedDirs: [],
    top: '',
    branch: null,
    changed: 0,
    flash: [],
    flashDim: [],
    flashOn: false,
    flashTones: {},
  }
}

export function parseTheme(toml: string): Theme {
  const get = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"(#[0-9a-fA-F]{6})"`, 'm'))?.[1]
  return {
    fg: get('foreground') ?? get('color7') ?? DEFAULT_THEME.fg,
    accent: get('accent') ?? get('color4') ?? DEFAULT_THEME.accent,
    muted: get('muted') ?? get('color8') ?? DEFAULT_THEME.muted,
    urgent: get('red') ?? get('color1') ?? DEFAULT_THEME.urgent,
    selection: get('selection') ?? DEFAULT_THEME.selection,
  }
}

export function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function toNodes(dir: string, list: Entry[]): FileNode[] {
  return list
    .map(e => ({
      id: join(dir, e.name),
      parent: dir,
      name: e.name,
      kind: e.isLink ? ('link' as const) : e.kind === 'dir' ? ('dir' as const) : ('file' as const),
      hidden: e.name.startsWith('.'),
      mtime: e.mtimeMs,
      loaded: false,
    }))
    .sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || collator.compare(a.name, b.name))
}

export function replaceChildren(nodes: FileNode[], dir: string, kids: FileNode[]): FileNode[] {
  const keep = new Map(nodes.filter(n => n.parent === dir).map(n => [n.id, n]))
  const fresh = kids.map(k => {
    const old = keep.get(k.id)
    return old && old.kind === 'dir' && k.kind === 'dir' ? { ...k, loaded: old.loaded } : k
  })
  const freshIds = new Set(fresh.map(k => k.id))
  const gone = [...keep.keys()].filter(id => !freshIds.has(id))
  const out = nodes.filter(n => n.parent !== dir && !gone.some(g => n.id.startsWith(g + '/')))
  return [...out.map(n => (n.id === dir ? { ...n, loaded: true } : n)), ...fresh]
}

export type GitStatus = {
  git: Record<string, string>
  ignored: string[]
  untrackedDirs: string[]
  branch: Branch | null
  untrackedFiles: string[]
  changed: number
}

export function parseBranch(record: string): Branch {
  const body = record.replace(/^## /, '')
  if (body.startsWith('HEAD (no branch)')) return { head: 'detached', upstream: '', ahead: 0, behind: 0 }
  const head = body.match(/^(?:No commits yet on |Initial commit on )?([^.\s[]+)/)?.[1] ?? body
  const upstream = body.match(/\.\.\.(\S+)/)?.[1] ?? ''
  const ahead = Number(body.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(body.match(/behind (\d+)/)?.[1] ?? 0)
  return { head, upstream, ahead, behind }
}

export function parseGit(stdout: string, top: string): GitStatus {
  const git: Record<string, string> = {}
  const ignored: string[] = []
  const untrackedDirs: string[] = []
  const untrackedFiles: string[] = []
  let branch: Branch | null = null
  let changed = 0
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] ?? ''
    if (rec.startsWith('## ')) {
      branch = parseBranch(rec)
      continue
    }
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    const raw = rec.slice(3)
    const path = join(top, raw.replace(/\/$/, ''))
    if (xy[0] === 'R' || xy[0] === 'C') i++
    if (xy === '!!') {
      ignored.push(path)
      continue
    }
    if (xy === '??') {
      if (raw.endsWith('/')) untrackedDirs.push(path)
      else untrackedFiles.push(path)
    }
    const letter =
      xy === '??'
        ? '?'
        : /U/.test(xy) || xy === 'AA' || xy === 'DD'
          ? 'U'
          : (['D', 'M', 'R', 'C', 'A', 'T'].find(c => xy.includes(c)) ?? '')
    if (!letter) continue
    changed += 1
    git[path] = stronger(git[path], letter)
    let dir = dirname(path)
    while (dir.length >= top.length && dir !== '/') {
      git[dir] = stronger(git[dir], letter)
      if (dir === top) break
      dir = dirname(dir)
    }
  }
  return { git, ignored, untrackedDirs, branch, untrackedFiles, changed }
}

export function parseNumstat(stdout: string, top: string, into: Record<string, [number, number]>): void {
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] ?? ''
    if (!rec) continue
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s)
    if (!m) continue
    let path = m[3] ?? ''
    if (path === '') {
      i += 2
      path = parts[i] ?? ''
    }
    if (!path) continue
    const add = m[1] === '-' ? 0 : Number(m[1])
    const del = m[2] === '-' ? 0 : Number(m[2])
    const abs = join(top, path)
    const prev = into[abs] ?? [0, 0]
    into[abs] = [prev[0] + add, prev[1] + del]
  }
}

export function rollUp(diff: Record<string, [number, number]>, top: string): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = { ...diff }
  for (const [path, [add, del]] of Object.entries(diff)) {
    let dir = dirname(path)
    while (dir.length >= top.length && dir !== '/') {
      const prev = out[dir] ?? [0, 0]
      out[dir] = [prev[0] + add, prev[1] + del]
      if (dir === top) break
      dir = dirname(dir)
    }
  }
  return out
}

export function underAny(id: string, set: Set<string>, root: string): boolean {
  if (set.size === 0) return false
  let cur = id
  while (cur.length >= root.length) {
    if (set.has(cur)) return true
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return false
}

export function ancestorsOf(id: string, root: string): string[] {
  const out: string[] = []
  let dir = dirname(id)
  while (dir.startsWith(root) && dir !== root) {
    out.push(dir)
    dir = dirname(dir)
  }
  return out
}

export function visibleRows(t: FileTree): Row[] {
  const kids = new Map<string, FileNode[]>()
  for (const n of t.nodes) {
    if (!t.showHidden && n.hidden) continue
    const list = kids.get(n.parent)
    if (list) list.push(n)
    else kids.set(n.parent, [n])
  }
  const q = t.query.trim().toLowerCase()
  let keep: Set<string> | null = null
  if (q) {
    keep = new Set()
    for (const n of t.nodes) {
      if (!n.name.toLowerCase().includes(q)) continue
      keep.add(n.id)
      for (const a of ancestorsOf(n.id, t.root)) keep.add(a)
    }
  }
  const open = new Set(t.expanded)
  const rows: Row[] = []
  const walk = (dir: string, depth: number) => {
    for (const n of kids.get(dir) ?? []) {
      if (keep && !keep.has(n.id)) continue
      const isOpen = n.kind === 'dir' && (keep ? kids.has(n.id) : open.has(n.id))
      rows.push({ node: n, depth, open: isOpen })
      if (isOpen) walk(n.id, depth + 1)
    }
  }
  walk(t.root, 0)
  return rows
}

export function stamp(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
