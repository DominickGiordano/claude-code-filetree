import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, FileNode, FileTree, Theme } from '../types'
import { BRANCH_ICON, type GitAction, gitActions, TONES } from './git'
import type { RowSpec, RowsProps, Seg } from './rows'
import { CHEVRON_CLOSED, CHEVRON_OPEN, fileIcon, GIT_COLOR } from './icons'
import {
  ancestorsOf,
  DEFAULT_THEME,
  dirname,
  emptyTree,
  join,
  parseGit,
  parseNumstat,
  parseTheme,
  replaceChildren,
  rollUp,
  stamp,
  toNodes,
  underAny,
  visibleRows,
} from './tree'

const TREE = { plugin: 'filetree', key: 'tree' } as const
const THEME = { plugin: 'filetree', key: 'theme' } as const
const PHASE = { plugin: 'filetree', key: 'phase' } as const
const ACTIVITY = { plugin: 'filetree', key: 'activity' } as const
const BUSY = { plugin: 'filetree', key: 'busy' } as const
const PANE = 'filetree'
const BRANCH_ROW = '#branch'
const FLASH_TICKS = 30
const FLASH_MS = 90
const DOUBLE_MS = 450
const FIND_LIMIT = 200
const UNTRACKED_COUNT_LIMIT = 100
const UNTRACKED_MAX_BYTES = 512 * 1024
const ACTIVITY_TTL_MS = 45_000
const UNTRACKED_DIRS_LIMIT = 10
const ADD_COLOR = '#98c379'
const DEL_COLOR = '#e06c75'
const THEME_FILE = '.local/state/omarchy/current/theme/colors.toml'
const PRUNE = ['.git', 'node_modules', 'target', '.venv', '__pycache__', 'dist', '.next']

let blink: Timer | null = null
let busyTimer: Timer | null = null
let generation = 0
let lastPress = { key: '', at: 0 }
let plain = false
let follow = true
let scanning: Promise<void> | null = null
let scanAgain = false
let gitRun: Promise<void> | null = null
let gitAgain = false
let activityId = 0

function shimmerColor(i: number, phase: number, len: number, dim: boolean, tone: string): string {
  const band = ((phase * 1.6) % (len + 8)) - 4
  const d = Math.abs(i - band)
  const set = TONES[tone] ?? TONES.orange
  const palette = (dim ? set?.dim : set?.bright) ?? ['#f97316']
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#f97316'
}

function lighten(hex: string): string {
  const v = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => Math.min(255, ((v >> shift) & 255) + 14)
  return `#${[16, 8, 0].map(x => ch(x).toString(16).padStart(2, '0')).join('')}`
}

async function get($: EngineInterface): Promise<FileTree> {
  return (await $.state.get(TREE)).value ?? emptyTree('')
}

async function put($: EngineInterface, fn: (t: FileTree) => FileTree): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const cur = await $.state.get(TREE)
    const done = await $.state.set(TREE, fn(cur.value ?? emptyTree('')), { ifVersion: cur.version })
    if (done.isSet) return
  }
}

function patch($: EngineInterface, fn: (t: FileTree) => Partial<FileTree>) {
  return put($, t => ({ ...t, ...fn(t) }))
}

async function activities($: EngineInterface): Promise<Activity[]> {
  return (await $.state.get(ACTIVITY)).value ?? []
}

async function setActivities($: EngineInterface, fn: (list: Activity[]) => Activity[]): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const cur = await $.state.get(ACTIVITY)
    const done = await $.state.set(ACTIVITY, fn(cur.value ?? []).slice(-6), { ifVersion: cur.version })
    if (done.isSet) return
  }
}

async function list($: EngineInterface, dir: string): Promise<FileNode[]> {
  try {
    const entries = await $.fs.list(dir)
    const resolved = await Promise.all(
      entries.map(async e => {
        if (!e.isLink) return { name: e.name, kind: e.kind, mtimeMs: e.mtimeMs, isLink: false }
        try {
          const link = await $.fs.stat(join(dir, e.name), { resolve: true })
          const target = link.realPath ? await $.fs.stat(link.realPath) : link
          return target.kind === 'dir'
            ? { name: e.name, kind: 'dir' as const, mtimeMs: target.mtimeMs, isLink: false }
            : { name: e.name, kind: 'file' as const, mtimeMs: target.mtimeMs, isLink: true }
        } catch {
          return { name: e.name, kind: 'other' as const, mtimeMs: 0, isLink: true }
        }
      }),
    )
    return toNodes(dir, resolved)
  } catch {
    return []
  }
}

async function loadDirs($: EngineInterface, dirs: string[]): Promise<Map<string, FileNode[]>> {
  const listed = new Map<string, FileNode[]>()
  for (const dir of dirs) listed.set(dir, await list($, dir))
  await patch($, t => {
    let nodes = t.nodes
    for (const [dir, kids] of listed) nodes = replaceChildren(nodes, dir, kids)
    return { nodes }
  })
  return listed
}

async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 20_000) {
  return $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs, env: { GIT_OPTIONAL_LOCKS: '0' } })
}

async function detectRepo($: EngineInterface): Promise<void> {
  const t = await get($)
  if (!t.root) return
  let top = ''
  try {
    const run = await git($, t.root, ['rev-parse', '--show-toplevel'], 5_000)
    top = run.exitCode === 0 ? run.stdout.trim() : ''
  } catch {
    top = ''
  }
  await patch($, cur => (cur.root === t.root ? { top } : {}))
}

async function countLines($: EngineInterface, path: string): Promise<number> {
  try {
    const st = await $.fs.stat(path)
    if (st.kind !== 'file' || st.size > UNTRACKED_MAX_BYTES) return 0
    const text = String(await $.fs.read(path))
    if (text.includes('\0')) return 0
    return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

async function readGit($: EngineInterface): Promise<void> {
  const t = await get($)
  if (!t.root || !t.top) return
  const root = t.root
  const top = t.top
  try {
    const status = await git($, root, ['status', '--porcelain=v1', '-b', '-z', '--ignored=traditional', '--untracked-files=normal', '--', '.'])
    if (status.exitCode !== 0) return
    const parsed = parseGit(status.stdout, top)
    const diff: Record<string, [number, number]> = {}
    const head = await git($, root, ['diff', 'HEAD', '--numstat', '-z', '--', '.'])
    if (head.exitCode === 0) parseNumstat(head.stdout, top, diff)
    else {
      const staged = await git($, root, ['diff', '--cached', '--numstat', '-z', '--', '.'])
      if (staged.exitCode === 0) parseNumstat(staged.stdout, top, diff)
      const work = await git($, root, ['diff', '--numstat', '-z', '--', '.'])
      if (work.exitCode === 0) parseNumstat(work.stdout, top, diff)
    }
    const untrackedFiles = [...parsed.untrackedFiles]
    for (const dir of parsed.untrackedDirs.slice(0, UNTRACKED_DIRS_LIMIT)) {
      if (untrackedFiles.length >= UNTRACKED_COUNT_LIMIT) break
      const others = await git($, root, ['ls-files', '-o', '--exclude-standard', '-z', '--', dir], 5_000)
      if (others.exitCode !== 0) continue
      for (const rel of others.stdout.split('\0').filter(Boolean).slice(0, UNTRACKED_COUNT_LIMIT - untrackedFiles.length)) untrackedFiles.push(join(root, rel))
    }
    const counted = await Promise.all(untrackedFiles.slice(0, UNTRACKED_COUNT_LIMIT).map(async p => [p, await countLines($, p)] as const))
    for (const [p, n] of counted) if (n > 0) diff[p] = [n, 0]
    await patch($, cur =>
      cur.root === root
        ? {
            git: parsed.git,
            ignored: parsed.ignored,
            untrackedDirs: parsed.untrackedDirs,
            branch: parsed.branch,
            changed: parsed.changed,
            diff: rollUp(diff, root),
          }
        : {},
    )
  } catch {
    return
  }
}

function refreshGit($: EngineInterface): Promise<void> {
  if (gitRun) {
    gitAgain = true
    return gitRun
  }
  gitRun = readGit($).finally(() => {
    gitRun = null
    if (gitAgain) {
      gitAgain = false
      void refreshGit($)
    }
  })
  return gitRun
}

async function reset($: EngineInterface, root: string, focus = false): Promise<void> {
  const keepHidden = (await get($)).showHidden
  generation += 1
  blink?.cancel()
  blink = null
  await put($, () => ({ ...emptyTree(root), showHidden: keepHidden }))
  const title = `Files: ${root.split('/').pop() || root}`
  if (focus) await $.ui.open({ id: PANE, title, focus: true })
  else await $.ui.open({ id: PANE, title })
  await loadDirs($, [root])
  await detectRepo($)
  await refreshGit($)
}

function isLoaded(t: FileTree, dir: string): boolean {
  return dir === t.root ? t.nodes.some(n => n.parent === dir) : Boolean(t.nodes.find(n => n.id === dir)?.loaded)
}

async function revealPaths($: EngineInterface, paths: string[]): Promise<void> {
  for (let pass = 0; pass < 32; pass++) {
    const t = await get($)
    const need = new Set<string>()
    for (const p of paths) {
      for (const dir of [t.root, ...ancestorsOf(p, t.root).reverse()]) {
        if (!isLoaded(t, dir)) {
          need.add(dir)
          break
        }
      }
    }
    if (need.size === 0) return
    await loadDirs($, [...need])
  }
}

async function markerPath($: EngineInterface): Promise<string> {
  const base = (await $.env.get('XDG_RUNTIME_DIR')) || (await $.env.get('TMPDIR')) || '/tmp'
  return `${base.replace(/\/$/, '')}/claude-filetree.marker`
}

async function changedSince($: EngineInterface, root: string, marker: string): Promise<string[]> {
  const prune = PRUNE.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name]))
  try {
    const run = await $.process.run(['find', root, '-xdev', '(', ...prune, ')', '-prune', '-o', '-newer', marker, '-print'], {
      timeoutMs: 8_000,
    })
    return run.stdout.split('\n').filter(p => p && p !== root && p !== marker)
  } catch {
    return []
  }
}

async function flash($: EngineInterface, tones: Record<string, string>): Promise<void> {
  const unique = Object.keys(tones)
  if (unique.length === 0) return
  const mine = ++generation
  blink?.cancel()
  blink = null
  await patch($, cur => {
    const open = new Set(cur.expanded)
    const bright = new Set(unique)
    const dim = new Set<string>()
    const all: Record<string, string> = cur.flashOn ? { ...cur.flashTones } : {}
    if (cur.flashOn) {
      for (const id of cur.flash) bright.add(id)
      for (const id of cur.flashDim) dim.add(id)
    }
    for (const id of unique) {
      const tone = tones[id] ?? 'orange'
      all[id] = tone
      if (id === BRANCH_ROW) continue
      const chain = ancestorsOf(id, cur.root)
      if (!chain.some(a => !open.has(a))) continue
      for (const a of chain) {
        if (!open.has(a)) {
          dim.add(a)
          all[a] = all[a] ?? tone
        }
        open.add(a)
      }
    }
    for (const id of bright) dim.delete(id)
    const last = unique.filter(id => id !== BRANCH_ROW).pop()
    return {
      flash: [...bright],
      flashDim: [...dim],
      flashOn: true,
      flashTones: all,
      expanded: [...open],
      cursor: last ?? cur.cursor,
    }
  })
  if (generation !== mine) return
  await $.state.set(PHASE, 0)
  let ticks = 0
  const timer = $.clock.every(FLASH_MS, () => {
    if (generation !== mine) {
      timer.cancel()
      return
    }
    ticks += 1
    if (ticks >= FLASH_TICKS) {
      timer.cancel()
      blink = null
      void patch($, () => ({ flash: [], flashDim: [], flashOn: false, flashTones: {} }))
      return
    }
    void $.state.set(PHASE, ticks)
  })
  blink = timer
}

async function followCwd($: EngineInterface): Promise<boolean> {
  if (!follow) return false
  const cwd = await $.session.cwd()
  const t = await get($)
  if (t.root === cwd) return false
  await reset($, cwd)
  return true
}

type Pending = { actions: GitAction[]; ids: number[]; before: Record<string, string>; ahead: number; marker: string }

async function startGit($: EngineInterface, actions: GitAction[]): Promise<number[]> {
  const now = await $.clock.now()
  const ids = actions.map(() => ++activityId)
  await setActivities($, cur => [
    ...cur.filter(a => now - a.at < ACTIVITY_TTL_MS),
    ...actions.map((a, i) => ({
      id: ids[i] ?? 0,
      kind: a.kind,
      label: a.running,
      state: 'running' as const,
      detail: '',
      at: now,
      tone: a.tone,
      nerd: a.icon.nerd,
      plain: a.icon.plain,
    })),
  ])
  if (!busyTimer) {
    let tick = 0
    const timer = $.clock.every(FLASH_MS, () => {
      tick += 1
      void (async () => {
        const running = (await activities($)).some(a => a.state === 'running')
        if (!running) {
          timer.cancel()
          if (busyTimer === timer) busyTimer = null
          return
        }
        await $.state.set(BUSY, tick)
      })()
    })
    busyTimer = timer
  }
  return ids
}

async function finishGit($: EngineInterface, p: Pending, ok: boolean, output: string): Promise<void> {
  const t = await get($)
  const details: Record<string, string> = {}
  if (ok && t.top) {
    if (p.actions.some(a => a.verb === 'commit')) {
      try {
        const log = await git($, t.root, ['log', '-1', '--format=%h %s'], 5_000)
        if (log.exitCode === 0) details.commit = log.stdout.trim()
      } catch {
        details.commit = ''
      }
    }
    const url = output.match(/https:\/\/github\.com\/[^\s)]+/)?.[0]
    if (url) details.url = url
  }
  const now = await $.clock.now()
  const after = await get($)
  await setActivities($, cur =>
    cur.map(a => {
      const i = p.ids.indexOf(a.id)
      if (i < 0) return a
      const action = p.actions[i]
      if (!action) return a
      const detail =
        action.verb === 'commit'
          ? (details.commit ?? '')
          : action.verb === 'push'
            ? after.branch
              ? `${after.branch.head}${after.branch.upstream ? ` → ${after.branch.upstream}` : ''}`
              : ''
            : action.kind.startsWith('gh ')
              ? (details.url ?? '')
              : ''
      return { ...a, state: ok ? 'done' : 'failed', label: ok ? action.done : `${action.verb} failed`, detail, at: now }
    }),
  )
}

async function afterBash($: EngineInterface, p: Pending | null, marker: string, initRepo: boolean): Promise<void> {
  if (await followCwd($)) return
  const t = await get($)
  if (!t.root) return
  if (initRepo) await detectRepo($)
  else if (!t.top) {
    try {
      await $.fs.stat(join(t.root, '.git'))
      await detectRepo($)
    } catch {
      return
    }
  }
  await refreshGit($)
  const fresh = await get($)
  const ignored = new Set(fresh.ignored)
  const hits = marker ? (await changedSince($, t.root, marker)).filter(x => !underAny(x, ignored, t.root)).slice(0, FIND_LIMIT) : []
  await revealPaths($, hits)
  const loaded = await get($)
  const dirs = [loaded.root, ...loaded.nodes.filter(n => n.kind === 'dir' && n.loaded).map(n => n.id)]
  const before = new Map(loaded.nodes.map(n => [n.id, n.mtime]))
  const listed = await loadDirs($, dirs)
  const changed: string[] = []
  for (const kids of listed.values()) {
    for (const k of kids) {
      if (k.kind === 'dir') continue
      const old = before.get(k.id)
      if (old === undefined || old !== k.mtime) changed.push(k.id)
    }
  }
  const final = await get($)
  const present = new Set(final.nodes.map(n => n.id))
  const tones: Record<string, string> = {}
  const touchTone = p?.actions.find(a => !['commit', 'push', 'add'].includes(a.verb))?.tone ?? 'orange'
  for (const id of [...hits.filter(x => present.has(x)), ...changed]) if (!underAny(id, ignored, t.root)) tones[id] = touchTone
  if (p) {
    if (p.actions.some(a => a.verb === 'commit' || a.verb === 'add')) {
      const tone = 'green'
      for (const [path, letter] of Object.entries(p.before)) {
        if (final.git[path] === letter) continue
        if (!present.has(path) || final.nodes.find(n => n.id === path)?.kind === 'dir') continue
        tones[path] = tone
      }
    }
    const pushLike = p.actions.find(a => ['push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'tag'].includes(a.verb) || a.kind.startsWith('gh '))
    if (pushLike) tones[BRANCH_ROW] = pushLike.tone
    if (p.actions.some(a => a.verb === 'commit')) tones[BRANCH_ROW] = tones[BRANCH_ROW] ?? 'green'
  }
  await flash($, tones)
}

function scheduleScan($: EngineInterface, p: Pending | null, marker: string, initRepo: boolean): void {
  if (scanning) {
    scanAgain = true
    return
  }
  scanning = afterBash($, p, marker, initRepo).finally(() => {
    scanning = null
    if (scanAgain) {
      scanAgain = false
      scheduleScan($, null, marker, false)
    }
  })
}

async function touched($: EngineInterface, paths: string[], tone = 'orange'): Promise<void> {
  if (await followCwd($)) return
  const t = await get($)
  const inside = paths.filter(p => p === t.root || p.startsWith(t.root + '/'))
  if (inside.length === 0) return
  const have = new Set(t.nodes.map(n => n.id))
  const missing = new Set<string>()
  for (const p of inside) {
    for (const x of [p, ...ancestorsOf(p, t.root)]) if (x !== t.root && !have.has(x)) missing.add(dirname(x))
  }
  const parents = [...missing].filter(d => d === t.root || have.has(d) || missing.has(d)).sort((a, b) => a.length - b.length)
  if (parents.length) await loadDirs($, parents)
  await revealPaths($, inside)
  await loadDirs($, [...new Set(inside.map(dirname))])
  await refreshGit($)
  const tones: Record<string, string> = {}
  for (const p of inside) tones[p] = tone
  await flash($, tones)
}

async function launch($: EngineInterface, argv: string[]): Promise<void> {
  try {
    await $.process.run(['setsid', '-f', ...argv], { timeoutMs: 10_000 })
  } catch {
    $.ui.toast(`could not start ${argv[0] ?? ''}`)
  }
}

async function toggle($: EngineInterface, n: FileNode): Promise<void> {
  if (n.kind === 'dir' && !n.loaded) await loadDirs($, [n.id])
  await patch($, t => {
    const open = new Set(t.expanded)
    if (n.kind === 'dir') open.has(n.id) ? open.delete(n.id) : open.add(n.id)
    return { expanded: [...open], cursor: n.id, selected: n.kind === 'dir' ? t.selected : n.id }
  })
}

async function press($: EngineInterface, n: FileNode): Promise<void> {
  const now = await $.clock.now()
  const isDouble = lastPress.key === n.id && now - lastPress.at < DOUBLE_MS
  lastPress = { key: isDouble ? '' : n.id, at: now }
  if (!isDouble) {
    await toggle($, n)
    return
  }
  await openNode($, n)
}

async function openNode($: EngineInterface, n: FileNode): Promise<void> {
  if (n.kind === 'dir') {
    follow = false
    await reset($, n.id)
  } else await launch($, ['gio', 'open', n.id])
}

function shortPath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'filetree', description: 'Show the file tree; args: [path] (no path follows the cwd)' })
    void (async () => {
      try {
        const nerd = await $.process.run(['fc-list', ':charset=f04eb', 'family'], { timeoutMs: 5_000 })
        plain = nerd.stdout.trim().length === 0
      } catch {
        plain = true
      }
      try {
        await $.state.set(THEME, parseTheme(String(await $.fs.read(`${(await $.env.get('HOME')) ?? ''}/${THEME_FILE}`))))
      } catch {
        await $.state.set(THEME, DEFAULT_THEME)
      }
      const t = await get($)
      if (t.flashOn) await patch($, () => ({ flash: [], flashDim: [], flashOn: false, flashTones: {} }))
      await setActivities($, cur => cur.map(a => (a.state === 'running' ? { ...a, state: 'failed', label: `${a.kind} interrupted` } : a)))
      const cwd = await $.session.cwd()
      if (!t.root || t.nodes.length === 0 || (follow && t.root !== cwd)) await reset($, cwd)
      else await $.ui.open({ id: PANE, title: `Files: ${t.root.split('/').pop() || t.root}` })
    })()
    return next(e)
  })

  on('command.run', { command: 'filetree' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    const cwd = await $.session.cwd()
    follow = !arg
    const root = arg ? (arg.startsWith('/') ? arg : `${cwd}/${arg}`).replace(/\/$/, '') : cwd
    await reset($, root, true)
    return { text: `File tree on ${shortPath(root)}${follow ? ' (follows the cwd)' : ''}.` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit' && e.tool !== 'Bash') return next(e)
    let marker = ''
    let pending: Pending | null = null
    const command = e.tool === 'Bash' ? e.command : ''
    if (e.tool === 'Bash') {
      try {
        marker = await markerPath($)
        await $.fs.write(marker, '')
      } catch {
        marker = ''
      }
      const actions = gitActions(command)
      if (actions.length) {
        const t = await get($)
        const ids = await startGit($, actions)
        pending = { actions, ids, before: { ...t.git }, ahead: t.branch?.ahead ?? 0, marker }
      }
    }
    const result = await next(e)
    const failed = Boolean(result.deny || result.isError)
    if (pending) {
      const output = !failed && e.tool === 'Bash' && result.result && typeof result.result === 'object' && 'stdout' in result.result ? String(result.result.stdout) : ''
      await finishGit($, pending, !failed, output)
    }
    if (failed) return result
    if (e.tool === 'Bash') {
      const initRepo = Boolean(pending?.actions.some(a => a.init)) || /\bgit\s+(init|clone)\b/.test(command)
      scheduleScan($, pending, marker, initRepo)
    } else {
      const file =
        'file_path' in e && typeof e.file_path === 'string'
          ? e.file_path
          : 'notebook_path' in e && typeof e.notebook_path === 'string'
            ? e.notebook_path
            : ''
      if (file) void touched($, [file])
    }
    return result
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'rows' || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { press?: unknown; key?: unknown; ctrl?: unknown; shift?: unknown }
    const t = await get($)
    if (typeof data.press === 'string') {
      const n = t.nodes.find(x => x.id === data.press)
      if (!n) return {}
      if (data.ctrl || data.shift) await openNode($, n)
      else await press($, n)
      return {}
    }
    if (typeof data.key !== 'string') return {}
    const rows = visibleRows(t)
    const at = rows.findIndex(r => r.node.id === t.cursor)
    const cur = rows[at]?.node
    const move = (d: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + d))]
      return target ? patch($, () => ({ cursor: target.node.id })) : Promise.resolve()
    }
    if (data.key === 'up' || data.key === 'k') await move(-1)
    else if (data.key === 'down' || data.key === 'j') await move(1)
    else if (data.key === 'pageup') await move(-10)
    else if (data.key === 'pagedown') await move(10)
    else if (cur && (data.key === 'right' || data.key === 'l') && cur.kind === 'dir' && !t.expanded.includes(cur.id)) await toggle($, cur)
    else if (cur && (data.key === 'left' || data.key === 'h')) {
      if (cur.kind === 'dir' && t.expanded.includes(cur.id)) await toggle($, cur)
      else if (cur.parent !== t.root) await patch($, () => ({ cursor: cur.parent }))
    } else if (cur && data.key === 'return') await (cur.kind === 'file' ? openNode($, cur) : toggle($, cur))
    else if (cur && data.key === ' ') await toggle($, cur)
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    const t = await get($)
    const context = [...(e.context ?? [])]
    const n = t.selected ? t.nodes.find(x => x.id === t.selected) : undefined
    if (n) context.push(`The user has this file selected in the file tree; "this" or "it" in the prompt likely refers to it: ${n.id}`)
    const mentions = [...e.text.matchAll(/@([^\s"'`]+)/g)]
      .map(m => (m[1] ?? '').replace(/[.,;:!?)]+$/, ''))
      .filter(Boolean)
      .map(p => (p.startsWith('/') ? p : join(t.root, p.replace(/^\.\//, ''))))
      .filter(p => p === t.root || p.startsWith(t.root + '/'))
    if (mentions.length) {
      void (async () => {
        const found: string[] = []
        for (const p of mentions) {
          try {
            await $.fs.stat(p)
            found.push(p.replace(/\/$/, ''))
          } catch {
            continue
          }
        }
        if (found.length) await touched($, found, 'cyan')
      })()
    }
    return next(context.length ? { ...e, context } : e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
    const t = await get($)
    const theme: Theme = (await $.state.get(THEME)).value ?? DEFAULT_THEME
    const phase = t.flashOn ? ((await $.state.get(PHASE)).value ?? 0) : 0
    const busy = (await $.state.get(BUSY)).value ?? 0
    const now = await $.clock.now()
    const recent = (await activities($)).filter(a => a.state === 'running' || now - a.at < ACTIVITY_TTL_MS).slice(-3).reverse()
    const bright = new Set(t.flashOn ? t.flash : [])
    const dimmed = new Set(t.flashOn ? t.flashDim : [])
    const ignored = new Set(t.ignored)
    const untracked = new Set(t.untrackedDirs)
    const width = Math.max(24, e.props.bodyColumns)
    const rows = visibleRows(t)
    const fixed = 5 + recent.length + (t.selected ? 1 : 0)
    const room = Math.max(5, (e.props.scroll?.bodyRows ?? 40) - fixed)
    const isLit = (id: string) => bright.has(id) || dimmed.has(id)
    const focus = t.flashOn ? ([...t.flash].reverse().find(id => id !== BRANCH_ROW) ?? t.cursor) : t.cursor
    const at = Math.max(0, rows.findIndex(r => r.node.id === focus))
    const lit = t.flashOn ? rows.findIndex(r => isLit(r.node.id)) : -1
    const cap = Math.max(1, Math.floor(room / 3))
    let from = Math.max(0, Math.min(lit >= 0 && at - lit < room - 2 ? Math.max(0, lit - 1) : at - Math.floor(room / 2), rows.length - room))
    let pinned = t.flashOn ? rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap) : []
    if (pinned.length) {
      const rest = Math.max(3, room - pinned.length)
      from = Math.max(0, Math.min(at - Math.floor(rest / 2), rows.length - rest))
      pinned = rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap)
    }
    const shown = rows.slice(from, from + room - pinned.length)
    const totals: [number, number] = t.top ? (t.diff[t.root] ?? [0, 0]) : [0, 0]
    const changedFiles = t.top ? t.changed : 0
    const header = t.top ? `${t.top.split('/').pop() ?? t.top}${t.root.slice(t.top.length)}` : t.root.split('/').pop() || t.root

    const shimmerText = (text: string, tone: string, dim: boolean, bold: boolean) => (
      <Text bold={bold}>
        {[...text].map((ch, i, all) => (
          <Text color={shimmerColor(i, phase, all.length, dim, tone)}>{ch}</Text>
        ))}
      </Text>
    )

    const rowSpec = (r: (typeof rows)[number]): RowSpec => {
      const n = r.node
      const own = t.git[n.id]
      const status = own ?? (underAny(dirname(n.id), untracked, t.root) ? '?' : undefined)
      const isIgnored = !status && underAny(n.id, ignored, t.root)
      const gitColor = status === 'D' || status === 'U' ? theme.urgent : status ? (GIT_COLOR[status] ?? theme.muted) : undefined
      const isBright = bright.has(n.id)
      const isDim = !isBright && dimmed.has(n.id)
      const tone = t.flashTones[n.id] ?? 'orange'
      const iconColor = isIgnored ? theme.muted : (gitColor ?? (n.hidden ? theme.muted : n.kind === 'dir' ? theme.accent : theme.muted))
      const nameColor = isIgnored ? theme.muted : (gitColor ?? (n.hidden ? theme.muted : theme.fg))
      const loc = t.diff[n.id]
      const meta = loc ? '' : n.kind === 'file' ? stamp(n.mtime) : ''
      const locText = loc ? `${loc[0] ? ` +${loc[0]}` : ''}${loc[1] ? ` -${loc[1]}` : ''}` : ''
      const badge = status ? ` ${status}` : isIgnored ? (plain ? ' ⊘' : ' \u{f05e}') : '  '
      const cols = Math.max(4, width - r.depth * 2 - 6 - (meta ? meta.length + 1 : 0) - locText.length - badge.length)
      const name = n.name.length > cols ? n.name.slice(0, cols - 1) + '…' : n.name
      const caret = n.kind === 'dir' ? (plain ? (r.open ? '▾' : '▸') : r.open ? CHEVRON_OPEN : CHEVRON_CLOSED) + ' ' : '  '
      const isRepo = n.kind === 'dir' && n.id === t.top
      const glyph = plain ? (n.kind === 'dir' ? '■' : '·') : fileIcon(n, r.open, isRepo)
      const left: Seg[] = [
        { t: '  '.repeat(r.depth) },
        { t: caret, c: theme.muted },
        { t: glyph + ' ', c: isBright || isDim ? shimmerColor(-1, phase, name.length, isDim, tone) : iconColor },
      ]
      if (isBright || isDim) for (const [i, ch] of [...name].entries()) left.push({ t: ch, c: shimmerColor(i, phase, name.length, isDim, tone), b: isBright })
      else left.push({ t: name, c: nameColor, b: n.id === t.selected, s: status === 'D' && n.kind !== 'dir' })
      const right: Seg[] = []
      if (meta) right.push({ t: ` ${meta}`, c: theme.muted })
      if (loc && loc[0] > 0) right.push({ t: ` +${loc[0]}`, c: ADD_COLOR })
      if (loc && loc[1] > 0) right.push({ t: ` -${loc[1]}`, c: DEL_COLOR })
      right.push({ t: badge, c: status ? gitColor : theme.muted, b: true })
      return { id: n.id, left, right }
    }

    const note = (text: string): RowSpec => ({ id: '', left: [{ t: text, c: theme.muted }], right: [] })
    const specs: RowSpec[] = [
      ...(rows.length === 0 ? [note('empty')] : []),
      ...pinned.map(rowSpec),
      ...(pinned.length > 0 ? [note('  ⋮')] : []),
      ...(from > 0 && pinned.length === 0 ? [note(`… ${from} above`)] : []),
      ...shown.map(rowSpec),
      ...(from + shown.length < rows.length ? [note(`… ${rows.length - from - shown.length} below`)] : []),
    ]

    const branchRow = () => {
      if (!t.top || !t.branch) return null
      const b = t.branch
      const isFlash = bright.has(BRANCH_ROW)
      const tone = t.flashTones[BRANCH_ROW] ?? 'teal'
      const label = b.head
      return (
        <Box flexDirection="row">
          <Text color={isFlash ? (TONES[tone]?.solid ?? theme.accent) : theme.accent}>{(plain ? BRANCH_ICON.plain : BRANCH_ICON.nerd) + ' '}</Text>
          {isFlash ? shimmerText(label, tone, false, true) : <Text bold color={theme.fg}>{label}</Text>}
          {b.ahead > 0 && <Text color={TONES.teal?.solid}>{` ↑${b.ahead}`}</Text>}
          {b.behind > 0 && <Text color={TONES.blue?.solid}>{` ↓${b.behind}`}</Text>}
          {b.upstream && <Text color={theme.muted}>{` ${b.upstream}`}</Text>}
          <Box flexGrow={1} />
          {totals[0] > 0 && <Text color={ADD_COLOR}>{` +${totals[0]}`}</Text>}
          {totals[1] > 0 && <Text color={DEL_COLOR}>{` -${totals[1]}`}</Text>}
          <Text color={theme.muted}>{changedFiles ? ` ${changedFiles} changed` : ' clean'}</Text>
        </Box>
      )
    }

    const activityRow = (a: Activity) => {
      const kindVerb = a.kind.replace(/^(git|gh) /, '')
      const tone = a.state === 'failed' ? 'red' : a.tone
      const color = TONES[tone]?.solid ?? theme.accent
      const icon = plain ? a.plain : a.nerd
      const mark = a.state === 'running' ? (plain ? '…' : '\u{f110}') : a.state === 'done' ? '✓' : '✗'
      return (
        <Box flexDirection="row">
          <Text color={color}>{icon + ' '}</Text>
          {a.state === 'running' ? (
            <Text bold>
              {[...`${a.label}…`].map((ch, i, all) => (
                <Text color={shimmerColor(i, busy, all.length, false, tone)}>{ch}</Text>
              ))}
            </Text>
          ) : (
            <Text bold color={color}>
              {a.label}
            </Text>
          )}
          <Text color={theme.muted} wrap="truncate-end">
            {a.detail ? `  ${a.detail}` : a.state === 'running' ? `  ${kindVerb}` : ''}
          </Text>
          <Box flexGrow={1} />
          <Text color={color}>{` ${mark}`}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" minHeight={Math.max(1, (e.props.scroll?.bodyRows ?? 1) - 1)}>
        <Box flexDirection="row">
          <Text bold color={theme.accent} wrap="truncate-start">
            {header}
          </Text>
          <Box flexGrow={1} />
          <Box flexDirection="row" gap={2}>
            <Button
              key="up"
              plain
              dimColor
              label={plain ? '↑' : '\u{f005d}'}
              onPress={() =>
                void (async () => {
                  follow = false
                  await reset($, dirname(t.root))
                })()
              }
            />
            <Button
              key="cwd"
              plain
              dimColor={!follow}
              label={plain ? '⌖' : '\u{f01a4}'}
              onPress={() =>
                void (async () => {
                  follow = true
                  await reset($, await $.session.cwd())
                })()
              }
            />
            <Button
              key="refresh"
              plain
              dimColor
              label={plain ? '↻' : '\u{f0450}'}
              onPress={() =>
                void (async () => {
                  const cur = await get($)
                  await loadDirs($, [cur.root, ...cur.nodes.filter(n => n.kind === 'dir' && n.loaded).map(n => n.id)])
                  await detectRepo($)
                  await refreshGit($)
                })()
              }
            />
            <Button
              key="hidden"
              plain
              dimColor={!t.showHidden}
              label={plain ? (t.showHidden ? '◉' : '○') : t.showHidden ? '\u{f0208}' : '\u{f0209}'}
              onPress={() => void patch($, cur => ({ showHidden: !cur.showHidden }))}
            />
            <Button key="collapse" plain dimColor label={plain ? '⊟' : '\u{eac5}'} onPress={() => void patch($, () => ({ expanded: [] }))} />
            {t.selected && (
              <Button key="unselect" plain label={plain ? '✕' : '\u{f0156}'} onPress={() => void patch($, () => ({ selected: '' }))} />
            )}
            <Text> </Text>
          </Box>
        </Box>
        {branchRow()}
        {!t.top && <Text color={theme.muted}>{plain ? '± ' : '\u{e702} '}no git repo · git status starts after git init</Text>}
        {recent.map(activityRow)}
        <Input
          key="q"
          label="/ "
          placeholder="search"
          submitLabel="filter"
          autoFocus
          onInput={(v: string) => void patch($, () => ({ query: v }))}
          onSubmit={(v: string) => void patch($, () => ({ query: v }))}
        />
        <Client
          key="rows"
          module="./rows.tsx"
          props={{ rows: JSON.parse(JSON.stringify(specs)) as RowSpec[], active: t.cursor, activeBg: theme.selection, hoverBg: lighten(theme.selection) } satisfies RowsProps}
        />
        <Box flexGrow={1} />
        {t.selected && (
          <Text dimColor wrap="truncate-start">
            selected: {t.selected.startsWith(t.root + '/') ? t.selected.slice(t.root.length + 1) : shortPath(t.selected)}
          </Text>
        )}
      </Box>
    )
  })
}
