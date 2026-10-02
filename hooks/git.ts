import { isAbsolute, posix } from './tree'

export type GitAction = {
  kind: string
  verb: string
  running: string
  done: string
  tone: string
  icon: { nerd: string; plain: string }
  init?: boolean
}

const ICON = {
  commit: { nerd: '\u{f417}', plain: '●' },
  push: { nerd: '\u{f0552}', plain: '↑' },
  pull: { nerd: '\u{f0553}', plain: '↓' },
  branch: { nerd: '\u{f418}', plain: '⑂' },
  merge: { nerd: '\u{f419}', plain: '⑃' },
  pr: { nerd: '\u{f407}', plain: '⇄' },
  github: { nerd: '\u{f408}', plain: '◎' },
  stash: { nerd: '\u{f01bc}', plain: '≡' },
  undo: { nerd: '\u{f054c}', plain: '↶' },
  tag: { nerd: '\u{f412}', plain: '⌖' },
  git: { nerd: '\u{e702}', plain: '±' },
}

export const TONES: Record<string, { bright: string[]; dim: string[]; solid: string }> = {
  orange: { bright: ['#f97316', '#fb923c', '#fdba74', '#ffedd5'], dim: ['#8a4316', '#a3562a', '#bd7444', '#d29267'], solid: '#f97316' },
  green: { bright: ['#22c55e', '#4ade80', '#86efac', '#dcfce7'], dim: ['#14532d', '#166534', '#2f7a47', '#4f9a66'], solid: '#4ade80' },
  teal: { bright: ['#14b8a6', '#2dd4bf', '#5eead4', '#ccfbf1'], dim: ['#0f5e57', '#16786f', '#2a9488', '#4fb3a8'], solid: '#2dd4bf' },
  blue: { bright: ['#3b82f6', '#60a5fa', '#93c5fd', '#dbeafe'], dim: ['#1e3a8a', '#1d4ed8', '#3b6fd1', '#6b93dc'], solid: '#60a5fa' },
  purple: { bright: ['#a855f7', '#c084fc', '#d8b4fe', '#f3e8ff'], dim: ['#581c87', '#6b21a8', '#8b47c4', '#a874d6'], solid: '#c084fc' },
  cyan: { bright: ['#06b6d4', '#22d3ee', '#67e8f9', '#cffafe'], dim: ['#155e75', '#0e7490', '#2b8ea3', '#5aa9b8'], solid: '#22d3ee' },
  red: { bright: ['#ef4444', '#f87171', '#fca5a5', '#fee2e2'], dim: ['#7f1d1d', '#991b1b', '#b54040', '#c96a6a'], solid: '#f87171' },
}

const GIT_VERBS: Record<string, Omit<GitAction, 'kind'>> = {
  commit: { verb: 'commit', running: 'committing', done: 'committed', tone: 'green', icon: ICON.commit },
  push: { verb: 'push', running: 'pushing', done: 'pushed', tone: 'teal', icon: ICON.push },
  pull: { verb: 'pull', running: 'pulling', done: 'pulled', tone: 'blue', icon: ICON.pull },
  fetch: { verb: 'fetch', running: 'fetching', done: 'fetched', tone: 'blue', icon: ICON.pull },
  checkout: { verb: 'checkout', running: 'checking out', done: 'checked out', tone: 'blue', icon: ICON.branch },
  switch: { verb: 'switch', running: 'switching', done: 'switched', tone: 'blue', icon: ICON.branch },
  branch: { verb: 'branch', running: 'branching', done: 'branched', tone: 'blue', icon: ICON.branch },
  merge: { verb: 'merge', running: 'merging', done: 'merged', tone: 'purple', icon: ICON.merge },
  rebase: { verb: 'rebase', running: 'rebasing', done: 'rebased', tone: 'purple', icon: ICON.merge },
  'cherry-pick': { verb: 'cherry-pick', running: 'cherry-picking', done: 'cherry-picked', tone: 'purple', icon: ICON.merge },
  stash: { verb: 'stash', running: 'stashing', done: 'stashed', tone: 'orange', icon: ICON.stash },
  reset: { verb: 'reset', running: 'resetting', done: 'reset', tone: 'red', icon: ICON.undo },
  restore: { verb: 'restore', running: 'restoring', done: 'restored', tone: 'red', icon: ICON.undo },
  revert: { verb: 'revert', running: 'reverting', done: 'reverted', tone: 'red', icon: ICON.undo },
  add: { verb: 'add', running: 'staging', done: 'staged', tone: 'green', icon: ICON.git },
  rm: { verb: 'rm', running: 'removing', done: 'removed', tone: 'red', icon: ICON.git },
  mv: { verb: 'mv', running: 'moving', done: 'moved', tone: 'orange', icon: ICON.git },
  tag: { verb: 'tag', running: 'tagging', done: 'tagged', tone: 'purple', icon: ICON.tag },
  init: { verb: 'init', running: 'initialising', done: 'initialised', tone: 'green', icon: ICON.git, init: true },
  clone: { verb: 'clone', running: 'cloning', done: 'cloned', tone: 'blue', icon: ICON.pull, init: true },
}

const GH_VERBS: Record<string, Omit<GitAction, 'kind'>> = {
  'pr create': { verb: 'pr create', running: 'opening PR', done: 'opened PR', tone: 'purple', icon: ICON.pr },
  'pr merge': { verb: 'pr merge', running: 'merging PR', done: 'merged PR', tone: 'purple', icon: ICON.merge },
  'pr checkout': { verb: 'pr checkout', running: 'checking out PR', done: 'checked out PR', tone: 'blue', icon: ICON.pr },
  'pr comment': { verb: 'pr comment', running: 'commenting on PR', done: 'commented on PR', tone: 'purple', icon: ICON.pr },
  'pr review': { verb: 'pr review', running: 'reviewing PR', done: 'reviewed PR', tone: 'purple', icon: ICON.pr },
  'repo clone': { verb: 'repo clone', running: 'cloning', done: 'cloned', tone: 'blue', icon: ICON.github, init: true },
  'release create': { verb: 'release create', running: 'releasing', done: 'released', tone: 'purple', icon: ICON.tag },
  'issue create': { verb: 'issue create', running: 'opening issue', done: 'opened issue', tone: 'purple', icon: ICON.github },
}

const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'grep', 'describe', 'config', 'remote', 'reflog', 'shortlog', 'help', 'version', 'check-ignore'])

function segments(command: string): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let tok = ''
  let quote = ''
  let has = false
  const endTok = () => {
    if (has) cur.push(tok)
    tok = ''
    has = false
  }
  const endSeg = () => {
    endTok()
    if (cur.length) out.push(cur)
    cur = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''
    if (quote) {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) tok += command[++i]
      else tok += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < command.length) {
      tok += command[++i]
      has = true
    } else if (ch === ' ' || ch === '\t') endTok()
    else if (ch === '\n' || ch === ';') endSeg()
    else if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
      tok += ch
      has = true
    } else if (ch === '&' || ch === '|') {
      if (command[i + 1] === ch) i++
      endSeg()
    } else {
      tok += ch
      has = true
    }
  }
  endSeg()
  return out
}

function stripGlobals(tokens: string[]): string[] {
  const out = [...tokens]
  if (out[0] === 'env') out.shift()
  while (out.length && /^[A-Z_][A-Z0-9_]*=/.test(out[0] ?? '')) out.shift()
  return out
}

export function gitActions(command: string): GitAction[] {
  const out: GitAction[] = []
  for (const raw of segments(command)) {
    const tokens = stripGlobals(raw)
    const head = tokens[0]?.split('/').pop()
    if (head === 'git') {
      let i = 1
      while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) {
        if (tokens[i] === '-C' || tokens[i] === '-c') i++
        i++
      }
      const verb = tokens[i] ?? ''
      if (READ_ONLY_GIT.has(verb)) continue
      if (verb === 'stash' && ['list', 'show'].includes(tokens[i + 1] ?? '')) continue
      if (verb === 'branch' && (tokens.length <= i + 1 || tokens.slice(i + 1).every(t => t.startsWith('-')))) continue
      const rest = tokens.slice(i + 1)
      if (verb === 'tag' && (rest.length === 0 || rest.some(t => /^(-l|--list|-n\d*|--contains|--points-at|--merged|--no-merged|-v|--verify)$/.test(t)))) continue
      const spec = verb === 'checkout' && rest.includes('--') ? GIT_VERBS.restore : GIT_VERBS[verb]
      if (spec) out.push({ kind: `git ${verb}`, ...spec })
    } else if (head === 'gh') {
      const pair = `${tokens[1] ?? ''} ${tokens[2] ?? ''}`
      const spec = GH_VERBS[pair]
      if (spec) out.push({ kind: `gh ${pair}`, ...spec })
    }
  }
  return out
}

export const BRANCH_ICON = ICON.branch

const READERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'fdfind', 'cat', 'head', 'tail', 'bat', 'less', 'more', 'ls', 'eza', 'tree', 'wc', 'sed', 'awk', 'jq'])
const PATTERN_FIRST = new Set(['rg', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'jq'])
const OUTPUT_PATHS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'fdfind'])

function tidy(path: string): string {
  const s = path.replace(/\/+$/, '')
  return s === '' ? '/' : /^[A-Za-z]:$/.test(s) && isAbsolute(`${s}/`) ? `${s}/` : s
}

export function resolve(cwd: string, p: string, home = ''): string {
  let path = posix(p)
  if (home && (path === '~' || path.startsWith('~/'))) path = home + path.slice(1)
  if (isAbsolute(path)) return tidy(path)
  const parts = posix(cwd).replace(/\/+$/, '').split('/')
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return tidy(parts.join('/'))
}

const WRITE_FLAGS = /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls|x|X|-exec|-exec-batch)$/

export function readOnly(command: string): boolean {
  const bare = ` ${command}`.replace(/\d*>&\d/g, ' ').replace(/(\d*|&)>>?\s*\/dev\/null/g, ' ')
  if (/[^>]>[^>&]|>>/.test(bare)) return false
  return segments(command).every(raw => {
    const tokens = stripGlobals(raw)
    const head = tokens[0]?.split('/').pop() ?? ''
    if (head === 'cd' || head === 'echo' || head === 'printf' || head === 'true' || head === 'pwd') return true
    if (head === 'git') return gitActions(tokens.join(' ')).length === 0
    if (head === 'sed') return !tokens.some(t => /^-i/.test(t))
    if (head === 'find' || head === 'fd' || head === 'fdfind') return !tokens.some(t => WRITE_FLAGS.test(t))
    return READERS.has(head)
  })
}

export function readTargets(command: string, sessionCwd: string, stdout: string, home = ''): string[] {
  let cwd = sessionCwd
  const out = new Set<string>()
  let listsPaths = false
  for (const raw of segments(command)) {
    const tokens = stripGlobals(raw).map(t => posix(t.replace(/^["']|["']$/g, '')))
    const head = tokens[0]?.split('/').pop() ?? ''
    if (head === 'cd' && tokens[1]) {
      cwd = resolve(cwd, tokens[1], home)
      continue
    }
    if (!READERS.has(head)) continue
    if (head === 'sed' && tokens.some(t => /^-i/.test(t))) continue
    if (OUTPUT_PATHS.has(head)) listsPaths = true
    const args = tokens.slice(1)
    let skipPattern = PATTERN_FIRST.has(head) && !args.some(t => t === '-e' || t === '-f' || t === '--files')
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? ''
      if (a.startsWith('-')) {
        if (/^-(e|f|g|t|T|m|A|B|C|-glob|-type|-max-count|name|iname|maxdepth|mindepth)$/.test(a)) i++
        continue
      }
      if (skipPattern) {
        skipPattern = false
        continue
      }
      if (/[*?<>|]/.test(a)) continue
      out.add(resolve(cwd, a, home))
    }
  }
  if (listsPaths) {
    for (const line of stdout.split('\n').slice(0, 400)) {
      const path = posix(line).match(/^((?:[A-Za-z]:)?[^:\0]+?)(?::\d+[:-]|$|:)/)?.[1]?.trim()
      if (path && !path.includes(' ')) out.add(resolve(cwd, path, home))
    }
  }
  return [...out].slice(0, 60)
}
