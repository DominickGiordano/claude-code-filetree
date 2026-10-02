import type { Act, ContextMap, FileTree, Touch } from '../types'
import { dirname, inside } from './tree'

const CHARS_PER_TOKEN = 4
const IMAGE_PX_PER_TOKEN = 750

export const FILTERS = ['all', 'context', 'touched'] as const

export function emptyContext(): ContextMap {
  return { files: {}, agents: {}, filter: 'all' }
}

export function field(o: object, key: string): string {
  const v = (o as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

export function weigh(input: object, result: { result?: unknown; text?: string }): number {
  const r = result.result as { type?: string; file?: { dimensions?: { displayWidth?: number; displayHeight?: number } } } | undefined
  if (r?.type === 'image') {
    const d = r.file?.dimensions
    return Math.ceil(((d?.displayWidth ?? 0) * (d?.displayHeight ?? 0)) / IMAGE_PX_PER_TOKEN)
  }
  const read = typeof result.text === 'string' ? result.text.length : JSON.stringify(result.result ?? '').length
  const wrote = ['old_string', 'new_string', 'content', 'new_source'].map(k => field(input, k)).join('').length
  return Math.ceil((read + wrote) / CHARS_PER_TOKEN)
}

export function lineOf(tool: string, input: object, result: unknown): number {
  if (tool === 'Read') return Number((input as { offset?: number }).offset) || 1
  if (tool !== 'Edit') return 1
  return (result as { structuredPatch?: { newStart?: number }[] } | undefined)?.structuredPatch?.[0]?.newStart || 1
}

export function noted(files: Record<string, Touch>, paths: string[], actor: string, how: Act, at: number, line: number | undefined, tokens: number, live: boolean): Record<string, Touch> {
  const out = { ...files }
  for (const p of paths) {
    const prev = out[p]
    out[p] = {
      line: line ?? prev?.line ?? 1,
      tokens: (prev?.live ? prev.tokens : 0) + (live ? tokens : 0),
      live: Boolean(prev?.live) || live,
      by: { ...prev?.by, [actor]: { ...prev?.by?.[actor], [how]: at } },
    }
  }
  return out
}

export type Writer = { command: string; since: number }

export function attribute(hits: string[], writers: Writer[], files: Record<string, Touch>): Map<string, number> {
  const out = new Map<string, number>()
  const since = Math.min(...writers.map(w => w.since))
  for (const p of hits) {
    const base = p.slice(p.lastIndexOf('/') + 1)
    const named = writers.flatMap((w, i) => (w.command.includes(base) ? [i] : []))
    if (named.length === 1) out.set(p, named[0] ?? -1)
    else if (Object.values(files[p]?.by ?? {}).some(h => Math.max(h.edited ?? 0, h.wrote ?? 0) >= since)) continue
    else out.set(p, writers.length === 1 ? 0 : -1)
  }
  return out
}

export function forgotten(files: Record<string, Touch>): Record<string, Touch> {
  return Object.fromEntries(Object.entries(files).map(([p, f]) => [p, { ...f, tokens: 0, live: false }]))
}

export function rollWeights(files: Record<string, Touch>, root: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [path, f] of Object.entries(files)) {
    if (!f.live || !f.tokens || !inside(root, path)) continue
    out[path] = (out[path] ?? 0) + f.tokens
    for (let dir = dirname(path); path !== root && inside(root, dir); dir = dirname(dir)) {
      out[dir] = (out[dir] ?? 0) + f.tokens
      if (dir === root) break
    }
  }
  return out
}

export function onlyShown(c: ContextMap): Set<string> | undefined {
  if (c.filter === 'all') return undefined
  return new Set(Object.entries(c.files).filter(([, f]) => c.filter === 'touched' || f.live).map(([p]) => p))
}

export function weight(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return tokens < 100_000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(tokens / 1000)}k`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function detail(name: string, f: Touch, now: number): string {
  const acts = Object.entries(f.by ?? {})
    .map(([who, hows]) => {
      const recent = (Object.entries(hows) as [Act, number][]).sort((a, b) => b[1] - a[1])
      const at = recent[0]?.[1] ?? 0
      return { at, text: `${recent.map(([how]) => how).join('+')} by ${who} ${ago(now - at)}` }
    })
    .sort((a, b) => b.at - a.at)
  return [name, ...(f.live ? [`≈${weight(f.tokens)} in context (main)`] : []), ...acts.map(a => a.text)].join(' · ')
}

export function emptyNote(t: FileTree, c: ContextMap): string {
  const q = t.query.trim()
  const scope = c.filter === 'context' ? '≈ in context' : 'touched this session'
  if (q) return c.filter === 'all' ? `no matches for "${q}"` : `no matches for "${q}" among files ${scope}`
  if (c.filter === 'all') return !t.showHidden && t.nodes.some(n => n.parent === t.root && n.hidden) ? 'only hidden files here; show hidden to see them' : 'empty'
  const only = [...(onlyShown(c) ?? [])]
  if (only.length === 0) return c.filter === 'context' ? 'nothing ≈ in context' : 'nothing touched this session'
  const here = only.filter(p => p !== t.root && inside(t.root, p))
  if (here.length === 0) return `${only.length} ${scope}, all outside this folder`
  if (!t.showHidden && here.some(p => p.slice(t.root.length).split('/').some(seg => seg.startsWith('.')))) return `files ${scope} are hidden; show hidden to see them`
  return `${here.length} ${scope}, none in the tree (deleted or not loaded)`
}

export function editorArgv(setting: string, path: string, line: number): string[] {
  const words = setting.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || setting.trim() === 'auto') return ['code', '-g', `${path}:${line}`]
  if (words.some(w => w.includes('{path}'))) return words.map(w => w.replaceAll('{path}', path).replaceAll('{line}', String(line)))
  return [...words, path]
}

export function mentionText(path: string, cwd: string, before: string, after: string): string {
  const rel = path !== cwd && inside(cwd, path) ? path.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1) : path
  const ref = /[\s"'`]/.test(rel) ? `@"${rel.replace(/["\\]/g, '\\$&')}"` : `@${rel}`
  return `${before && !/\s$/.test(before) ? ' ' : ''}${ref}${/^\s/.test(after) ? '' : ' '}`
}
