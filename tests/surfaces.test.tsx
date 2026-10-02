import { expect, mock, test } from 'claude-code/testing'

import { attribute } from '../hooks/context'

type World = { os: 'darwin' | 'linux' | 'win32'; env: Record<string, string>; cwd: string; top: string; dirs: Record<string, [string, 'file' | 'dir'][]>; status: string; numstat: string }
type Ran = string[][]
const opens: unknown[] = []

function world(on: any, w: World, ran: Ran) {
  mock.env(on, w.env)
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$: any, e: any) => {
    ran.push(['toast', String(e.text ?? e.message ?? JSON.stringify(e))])
    return { value: undefined }
  })
  on('fs.read', () => {
    throw new Error('no theme file')
  })
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
  const dirOf = (p: string) => w.dirs[p] ?? w.dirs[p.replace(/^[A-Za-z]:/, '')]
  on('fs.list', (_$: any, e: any) => {
    const kids = dirOf(norm(e.path))
    if (!kids) throw new Error(`ENOENT ${e.path}`)
    return { value: kids.map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1_700_000_000_000, isLink: false })) }
  })
  on('fs.stat', (_$: any, e: any) => {
    const p = norm(e.path)
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    const name = p.slice(p.lastIndexOf('/') + 1)
    const hit = dirOf(p) ? 'dir' : dirOf(parent)?.find(([n]) => n === name)?.[1]
    if (!hit) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: hit, size: 1, mtimeMs: name === 'a.ts' ? 1_800_000_000_500 : 1_700_000_000_000, isLink: false } }
  })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'uname') return ok(w.os === 'darwin' ? 'Darwin\n' : 'Linux\n')
    if (argv[0] === 'sh') return ok('missing\n')
    if (argv[0] === 'git') {
      const verb = argv.slice(4).find(a => !a.startsWith('-'))
      if (verb === 'rev-parse') return w.top ? ok(`\n${w.top}\n`) : { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      if (verb === 'status') return ok(w.status)
      if (verb === 'diff') return ok(w.numstat)
      if (verb === 'ls-files') {
        const files: string[] = []
        for (const [dir, kids] of Object.entries(w.dirs)) for (const [name, kind] of kids) if (kind === 'file' && dir.startsWith(w.top)) files.push(`${dir}/${name}`.slice(w.top.length + 1))
        return ok(files.join('\0'))
      }
      return ok('')
    }
    return ok('')
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  return clock
}

const paneProps = (bodyColumns: number) => ({ title: 'Files', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as any

async function texts(ui: any): Promise<string> {
  const rows = JSON.stringify(await ui.drawn({ in: 'rows' }))
  return JSON.stringify(await ui.drawn()) + rows
}

const NERD = /[\u{e000}-\u{f8ff}\u{f0000}-\u{fffff}]/u

test('macOS Claude Code app: desktop pane draws, selects, opens with open', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/proj'
  const clock = world(on, {
    os: 'darwin', env: { HOME: '/Users/k', TMPDIR: '/var/folders/x/T/' }, cwd: root, top: root,
    dirs: { [root]: [['src', 'dir'], ['README.md', 'file'], ['notes.md', 'file']], [`${root}/src`]: [['a.ts', 'file']] },
    status: '## main...origin/main\0 M src/a.ts\0?? notes.md\0', numstat: '3\t1\tsrc/a.ts\0',
  }, ran)
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'desktop', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  const shown = await texts(ui)
  for (const word of ['README.md', 'notes.md', 'src', 'main', 'origin/main']) expect(shown).toContain(word)
  expect(NERD.test(shown)).toBe(false)
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await clock.settle()
  expect(await texts(ui)).toContain('"selected: ","README.md"')
  const sent = await $.prompt.submit({ text: 'what is this?', wait: false } as any)
  expect(JSON.stringify(sent)).toContain(`${root}/README.md`)
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await clock.settle()
  expect(ran).toContainEqual(['open', `${root}/README.md`])
  expect(ran.some(a => a[0] === 'setsid' || a[0] === 'gio')).toBe(false)
  await $.tool.call({ tool: 'Bash', command: 'echo hi >> src/a.ts' } as any)
  await clock.settle()
  const finds = ran.filter(a => a[0] === 'find')
  expect(finds.length).toBeGreaterThan(0)
  expect(finds.every(f => f.includes('-newer') && !f.includes('-newermt'))).toBe(true)
  expect(ran.some(a => a[0] === 'touch' && a[1]?.startsWith('/var/folders/x/T/filetree-'))).toBe(true)
  expect(ran.some(a => a[0] === 'rm')).toBe(true)
  await ui.unmount()
})

test('macOS outside a repo: write scan uses find -newer marker, not GNU -newermt', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/scratch'
  const clock = world(on, { os: 'darwin', env: { HOME: '/Users/k' }, cwd: root, top: '', dirs: { [root]: [['a.ts', 'file']] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'echo hi > a.ts' } as any)
  await clock.settle()
  const find = ran.find(a => a[0] === 'find')
  expect(find).toBeDefined()
  expect(find).toContain('-newer')
  expect(find).not.toContain('-newermt')
})

test('Windows: backslash paths shimmer, open uses cmd start, no find or sh', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = 'C:/Users/k/proj'
  const clock = world(on, {
    os: 'win32', env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\k' }, cwd: 'C:\\Users\\k\\proj', top: root,
    dirs: { [root]: [['src', 'dir'], ['README.md', 'file']], [`${root}/src`]: [['a.ts', 'file']] },
    status: '## main\0 M src/a.ts\0', numstat: '1\t0\tsrc/a.ts\0',
  }, ran)
  await $.session.start({ cwd: 'C:\\Users\\k\\proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  expect(await texts(ui)).toContain('README.md')
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\k\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as any)
  await clock.settle()
  const shown = await texts(ui)
  expect(shown).toContain('a.ts')
  expect(shown).toContain('+1')
  await $.tool.call({ tool: 'Bash', command: 'echo x >> src/a.ts' } as any)
  await clock.settle()
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await clock.settle()
  expect(ran).toContainEqual(['cmd', '/c', 'start', '', 'C:\\Users\\k\\proj\\README.md'])
  expect(ran.some(a => ['find', 'sh', 'uname', 'setsid', 'touch'].includes(a[0] ?? ''))).toBe(false)
  await ui.unmount()
})

test('Linux unchanged: GNU find -newermt outside a repo, xdg-open detached', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a\\b.txt', 'file'], ['c.txt', 'file']] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  expect(await texts(ui)).toContain('a\\\\b.txt')
  await $.tool.call({ tool: 'Bash', command: 'echo hi > c.txt' } as any)
  await clock.settle()
  const find = ran.find(a => a[0] === 'find')
  expect(find).toContain('-newermt')
  expect(ran.some(a => a[0] === 'touch')).toBe(false)
  await ui.post({ press: `${root}/c.txt` }, { in: 'rows' })
  await ui.post({ press: `${root}/c.txt` }, { in: 'rows' })
  await clock.settle()
  const opener = ran.find(a => a[0] === 'setsid')
  expect(opener?.slice(0, 3)).toEqual(['setsid', '-f', 'sh'])
  expect(opener?.at(-1)).toBe(`${root}/c.txt`)
  await ui.unmount()
})

test('macOS app: every header button and the search box work on the desktop surface', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/proj'
  const clock = world(on, {
    os: 'darwin', env: { HOME: '/Users/k' }, cwd: root, top: root,
    dirs: { [root]: [['src', 'dir'], ['.env', 'file'], ['README.md', 'file']], [`${root}/src`]: [['a.ts', 'file']], '/Users/k': [['proj', 'dir']] },
    status: '## main\0', numstat: '',
  }, ran)
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'desktop', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  expect(await texts(ui)).toContain('.env')
  await ui.press({ key: 'hidden' })
  await clock.settle()
  expect(await texts(ui)).not.toContain('.env')
  await ui.press({ key: 'hidden' })
  await ui.input({ key: 'q', text: 'a.ts' })
  await clock.settle()
  const jumped = await texts(ui)
  expect(jumped).toContain('a.ts')
  expect(jumped).toContain('"value":""')
  await ui.press({ key: 'collapse' })
  await clock.settle()
  expect(await texts(ui)).not.toContain(`"id":"${root}/src/a.ts"`)
  await ui.press({ key: 'up' })
  await clock.settle()
  expect(await texts(ui)).toContain('"proj"')
  await ui.press({ key: 'cwd' })
  await clock.settle()
  expect(await texts(ui)).toContain('README.md')
  await ui.unmount()
})

test('outside a repo only git rev-parse runs, never status, diff or ls-files', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['c.txt', 'file']] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'echo hi > c.txt' } as any)
  await $.tool.call({ tool: 'Edit', file_path: `${root}/c.txt`, old_string: 'a', new_string: 'b' } as any)
  await clock.settle()
  const gits = ran.filter(a => a[0] === 'git').map(a => a.slice(4).find(x => !x.startsWith('-')))
  expect(gits.length).toBeGreaterThan(0)
  expect(gits.every(v => v === 'rev-parse')).toBe(true)
})

test('NotebookEdit refreshes git and lists the notebook folder', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['nb', 'dir']], [`${root}/nb`]: [['a.ipynb', 'file']] }, status: '## main\0 M nb/a.ipynb\0', numstat: '4\t2\tnb/a.ipynb\0' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  const before = ran.filter(a => a[0] === 'git' && a.includes('status')).length
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${root}/nb/a.ipynb`, new_source: 'x' } as any)
  await clock.settle()
  expect(ran.filter(a => a[0] === 'git' && a.includes('status')).length).toBeGreaterThan(before)
  const shown = await texts(ui)
  expect(shown).toContain('a.ipynb')
  expect(shown).toContain('+4')
  await ui.unmount()
})

test('long trees scroll: wheel, scrollbar drag, and a click does not jump the view', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/big'
  const names = Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, 'file'] as [string, 'file'])
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: names }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const props = { ...paneProps(60), scroll: { offset: 0, bodyRows: 20 } }
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props })
  await clock.settle()
  const rowsOf = async () => ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props
  let p = await rowsOf()
  expect(p.bar).toBeDefined()
  expect(p.rows[0].id).toBe(`${root}/f00.txt`)
  expect(JSON.stringify(p.rows)).not.toContain('below')
  await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 1 } as any)
  await clock.settle()
  p = await rowsOf()
  expect(p.rows[0].id).toBe(`${root}/f03.txt`)
  await ui.post({ scrollTo: 1 }, { in: 'rows' })
  await clock.settle()
  p = await rowsOf()
  expect(p.rows.at(-1).id).toBe(`${root}/f59.txt`)
  const first = p.rows[0].id
  await ui.post({ press: p.rows[5].id }, { in: 'rows' })
  await clock.settle()
  p = await rowsOf()
  expect(p.rows[0].id).toBe(first)
  expect(p.active).toBe(p.rows[5].id)
  await ui.unmount()
})

test('watches only git metadata, copies paths, clears search, Home and End', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['.git', 'dir'], ['a.txt', 'file'], ['b.txt', 'file'], ['c.txt', 'file']], [`${root}/.git`]: [['index', 'file'], ['HEAD', 'file']] }, status: '## main\0', numstat: '' }, ran)
  const copied: string[] = []
  on('ui.copy', (_$: any, e: any) => {
    copied.push(e.text)
    return { value: true }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const started = await $.classic.SessionStart({ source: 'startup', cwd: root } as any)
  expect((started as any).watchPaths).toEqual([`${root}/.git/index`, `${root}/.git/HEAD`])
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  await ui.post({ copy: `${root}/b.txt` }, { in: 'rows' })
  await ui.post({ copy: `${root}/b.txt`, shift: true }, { in: 'rows' })
  await clock.settle()
  expect(copied).toEqual(['b.txt', `${root}/b.txt`])
  await ui.input({ key: 'q', text: 'b', kind: 'change' })
  await clock.settle()
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.press({ key: 'clear' })
  await clock.settle()
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  await ui.post({ key: 'end' }, { in: 'rows' })
  await clock.settle()
  const rowsOf = async () => ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props
  expect((await rowsOf()).active).toBe(`${root}/c.txt`)
  await ui.post({ key: 'home' }, { in: 'rows' })
  await clock.settle()
  expect((await rowsOf()).active).toBe(`${root}/.git`)
  const before = ran.filter(a => a.includes('status')).length
  await $.classic.FileChanged({ file_path: `${root}/.git/index`, event: 'change' } as any)
  await clock.advance(400)
  expect(ran.filter(a => a.includes('status')).length).toBeGreaterThan(before)
  await ui.unmount()
})

test('sidebar only: no pane in the default layout, and an inline pane closes itself', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a.txt', 'file']] }, status: '', numstat: '' }, ran)
  const opened = opens
  const closed: unknown[] = []
  on('ui.close', (_$: any, e: any) => {
    closed.push(e)
    return {}
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const before = opened.length
  const r = await $.command.run({ command: 'filetree', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 200 } } as any)
  expect(JSON.stringify(r)).toContain('/tui fullscreen')
  expect(opened.length).toBe(before)
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: { ...paneProps(60), placement: 'inline' } })
  await clock.settle()
  expect(closed.length).toBeGreaterThan(0)
  await ui.unmount()
})

type Shell = { found: string[]; codeMissing: boolean }

function contextWorld(on: any, ran: Ran, root: string, w: Partial<World> = {}, shell: Shell = { found: [], codeMissing: false }) {
  on('tool.call', { tool: ['Read', 'Edit', 'Write'] }, (_$: any, e: any) => {
    if (e.tool === 'Read') return { result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x'.repeat(e.file_path.endsWith('a.ts') ? 4000 : 2400) }
    return { result: { filePath: e.file_path, structuredPatch: [{ newStart: 12 }] }, text: 'updated' }
  })
  on('process.run', { argv: ['find', 'code'] }, (_$: any, e: any) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'code' && shell.codeMissing) throw new Error('spawn code ENOENT')
    return { value: { exitCode: 0, stdout: e.argv[0] === 'find' ? shell.found.join('\n') : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', () => ({}))
  return world(on, {
    os: 'darwin', env: { HOME: '/Users/k' }, cwd: root, top: '',
    dirs: { [root]: [['src', 'dir'], ['README.md', 'file']], [`${root}/src`]: [['a.ts', 'file'], ['b.ts', 'file']] },
    status: '', numstat: '', ...w,
  }, ran)
}

const rowsOf = async (ui: any) => ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props
const drawnText = async (ui: any) => JSON.stringify(await ui.drawn())

for (const reason of ['clear', 'resume'] as const) {
  test(`context map: weights per file and folder, reset on compact and on ${reason}`, { timeoutMs: 20_000 }, async ($, on) => {
    const ran: Ran = []
    const root = '/Users/k/ctx'
    const clock = contextWorld(on, ran, root)
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    on('session.end', () => ({ sessionId: 'test-session' }))
    await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
    await $.tool.call({ tool: 'Read', file_path: `${root}/src/a.ts` } as any)
    await $.tool.call({ tool: 'Edit', file_path: `${root}/src/b.ts`, old_string: 'a'.repeat(100), new_string: 'b'.repeat(93) } as any)
    await clock.settle()
    const weightOf = async (id: string) => (await rowsOf(ui)).rows.find((r: any) => r.id === id)?.right.find((s: any) => s.t.startsWith(' · '))?.t
    expect(await weightOf(`${root}/src/a.ts`)).toBe(' · 1k')
    expect(await weightOf(`${root}/src/b.ts`)).toBe(' · 50')
    expect(await weightOf(`${root}/src`)).toBe(' · 1.1k')
    expect(await weightOf(`${root}/README.md`)).toBeUndefined()
    expect(await drawnText(ui)).toContain('≈1.1k')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await clock.settle()
    expect(await weightOf(`${root}/src/a.ts`)).toBeUndefined()
    expect(await drawnText(ui)).not.toContain('≈1')
    await ui.press({ key: 'filter' })
    expect(JSON.stringify(await rowsOf(ui))).toContain('nothing ≈ in context')
    await $.tool.call({ tool: 'Read', file_path: `${root}/README.md` } as any)
    await clock.settle()
    expect((await rowsOf(ui)).rows.map((r: any) => r.id)).toEqual([`${root}/README.md`])
    await $.session.end({ reason, sessionId: 'test-session', resume: {} } as any)
    await clock.settle()
    expect(JSON.stringify(await rowsOf(ui))).toContain('nothing ≈ in context')
    await ui.unmount()
  })
}

test('context map: touched filter keeps reads and writes; detail names the subagent', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const clock = contextWorld(on, ran, root)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('agent.list', () => ({ value: [{ id: 'agent-2', description: 'plan it', type: 'Plan', status: 'running' }] }))
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.agent.spawn({ prompt: 'look around', subagentType: 'Explore', description: 'look' } as any)
  await $.tool.call({ tool: 'Edit', file_path: `${root}/src/a.ts`, old_string: 'a', new_string: 'b', agentId: 'agent-1' } as any)
  await $.tool.call({ tool: 'Read', file_path: `${root}/src/b.ts`, agentId: 'agent-2' } as any)
  await clock.settle()
  expect(JSON.stringify((await rowsOf(ui)).rows)).not.toContain(' · ')
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  expect((await rowsOf(ui)).rows.map((r: any) => r.id)).toEqual([`${root}/src`, `${root}/src/a.ts`, `${root}/src/b.ts`])
  await clock.advance(120_000)
  await ui.post({ press: `${root}/src/a.ts` }, { in: 'rows' })
  expect(await drawnText(ui)).toContain('"src/a.ts · edited by Explore 2m ago"')
  await ui.post({ press: `${root}/src/b.ts` }, { in: 'rows' })
  expect(await drawnText(ui)).toContain('"src/b.ts · read by Plan 2m ago"')
  await ui.press({ key: 'filter' })
  expect(JSON.stringify(await rowsOf(ui))).toContain('README.md')
  await ui.unmount()
})

test('context map: history keeps every reader, so in context (main) survives a subagent read', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const clock = contextWorld(on, ran, root)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.agent.spawn({ prompt: 'look around', subagentType: 'Explore', description: 'look' } as any)
  await $.tool.call({ tool: 'Read', file_path: `${root}/src/a.ts` } as any)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Read', file_path: `${root}/src/a.ts`, agentId: 'agent-1' } as any)
  await clock.settle()
  await ui.post({ press: `${root}/src/a.ts` }, { in: 'rows' })
  expect(await drawnText(ui)).toContain('"src/a.ts · ≈1k in context (main) · read by Explore 0s ago · read by main 1m ago"')
  await ui.unmount()
})

test('context map: a subagent sed -i beside a main Edit credits each to its own author', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('tool.call', { tool: 'Bash' }, async () => {
    await gate
    return { result: { stdout: '', stderr: '' } }
  })
  const shell = { found: [`${root}/src/a.ts`, `${root}/src/b.ts`], codeMissing: false }
  const clock = contextWorld(on, ran, root, {}, shell)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.agent.spawn({ prompt: 'fix a.ts', subagentType: 'Explore', description: 'fix' } as any)
  const bash = $.tool.call({ tool: 'Bash', command: 'sed -i "" s/x/y/ src/a.ts', agentId: 'agent-1' } as any)
  await $.tool.call({ tool: 'Edit', file_path: `${root}/src/b.ts`, old_string: 'a', new_string: 'b' } as any)
  release()
  await bash
  await clock.settle()
  await ui.post({ press: `${root}/src/b.ts` }, { in: 'rows' })
  const b = await drawnText(ui)
  expect(b).toContain('"src/b.ts · ≈3 in context (main) · edited by main 0s ago"')
  await ui.post({ press: `${root}/src/a.ts` }, { in: 'rows' })
  expect(await drawnText(ui)).toContain('"src/a.ts · changed by Explore 0s ago"')
  await ui.unmount()
})

test('context map: Bash changes keep the line Claude last edited', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const shell = { found: [] as string[], codeMissing: false }
  const clock = contextWorld(on, ran, root, {}, shell)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.tool.call({ tool: 'Edit', file_path: `${root}/src/a.ts`, old_string: 'a', new_string: 'b' } as any)
  await clock.settle()
  shell.found = [`${root}/src/a.ts`]
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'sed -i "" s/x/y/ src/a.ts' } as any)
  await clock.settle()
  shell.found = []
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'cat src/a.ts' } as any)
  await clock.settle()
  await ui.post({ press: `${root}/src/a.ts` }, { in: 'rows' })
  expect(await drawnText(ui)).toContain('read+changed+edited by main 0s ago')
  await ui.press({ key: 'editor' })
  expect(ran).toContainEqual(['code', '-g', `${root}/src/a.ts:12`])
  await ui.unmount()
})

test('empty states name their cause', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/dots'
  const clock = contextWorld(on, ran, root, { dirs: { [root]: [['.env', 'file'], ['.zshrc', 'file']] } })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await clock.settle()
  const note = async () => (await rowsOf(ui)).rows[0].left[0].t
  await ui.input({ key: 'q', text: 'zzz', kind: 'change' })
  expect(await note()).toBe('no matches for "zzz"')
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'filter' })
  expect(await note()).toBe('nothing ≈ in context')
  await $.tool.call({ tool: 'Read', file_path: `${root}/.env` } as any)
  await clock.settle()
  await ui.input({ key: 'q', text: 'zzz', kind: 'change' })
  expect(await note()).toBe('no matches for "zzz" among files ≈ in context')
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'hidden' })
  expect(await note()).toBe('files ≈ in context are hidden; show hidden to see them')
  await ui.press({ key: 'filter' })
  await ui.press({ key: 'filter' })
  expect(await note()).toBe('only hidden files here; show hidden to see them')
  await ui.unmount()
})

test('a filter that hides the selected file clears it; buttons and keys act on the same row', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const clock = contextWorld(on, ran, root)
  const fills: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$: any, e: any) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.tool.call({ tool: 'Read', file_path: `${root}/src/a.ts` } as any)
  await clock.settle()
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  expect(await ui.find({ key: 'unselect' })).toBeDefined()
  await ui.press({ key: 'filter' })
  expect(await ui.find({ key: 'unselect' })).toBeUndefined()
  expect((await rowsOf(ui)).active).toBe(`${root}/src`)
  await ui.press({ key: 'mention' })
  await ui.post({ key: 'm' }, { in: 'rows' })
  expect(fills).toEqual(['@src ', '@src '])
  const sent = await $.prompt.submit({ text: 'what is this?', wait: false } as any)
  expect(JSON.stringify(sent)).not.toContain('README.md')
  await ui.unmount()
})

test('@ mention fills the prompt draft at the cursor without submitting', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const clock = contextWorld(on, ran, root, { dirs: { [root]: [['my notes.md', 'file'], ['README.md', 'file']] } })
  const fills: any[] = []
  let box = { text: 'explain', cursor: 7 }
  on('prompt.read', () => ({ value: box }))
  on('prompt.fill', (_$: any, e: any) => {
    fills.push(e)
    return { isFilled: true }
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await clock.settle()
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await ui.press({ key: 'mention' })
  box = { text: 'see  and', cursor: 4 }
  await ui.post({ press: `${root}/my notes.md` }, { in: 'rows' })
  await ui.post({ key: '@' }, { in: 'rows' })
  expect(fills.map(f => [f.text, f.mode])).toEqual([[' @README.md ', 'insert'], ['@"my notes.md"', 'insert']])
  await ui.unmount()
})

test('open in editor: code -g path:line by default, falls back to open when code is missing', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const shell = { found: [] as string[], codeMissing: false }
  const clock = contextWorld(on, ran, root, {}, shell)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.tool.call({ tool: 'Edit', file_path: `${root}/src/a.ts`, old_string: 'a', new_string: 'b' } as any)
  await clock.settle()
  await ui.post({ press: `${root}/src/a.ts` }, { in: 'rows' })
  await ui.press({ key: 'editor' })
  expect(ran).toContainEqual(['code', '-g', `${root}/src/a.ts:12`])
  shell.codeMissing = true
  await ui.post({ key: 'e' }, { in: 'rows' })
  const [tried, toast, opened] = ran.slice(-3)
  expect(tried).toEqual(['code', '-g', `${root}/src/a.ts:12`])
  expect(toast?.[1]).toMatch(/^code is not available \(.+\); opening with the default app$/)
  expect(opened).toEqual(['open', `${root}/src/a.ts`])
  await ui.unmount()
})

test('open in editor: a configured command fills {path} and {line}', { timeoutMs: 20_000, options: { editor: 'zed {path}:{line}' } }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const clock = contextWorld(on, ran, root)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.tool.call({ tool: 'Read', file_path: `${root}/README.md`, offset: 40 } as any)
  await clock.settle()
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await ui.press({ key: 'editor' })
  expect(ran).toContainEqual(['zed', `${root}/README.md:40`])
  await ui.unmount()
})

test('weight falls back to the serialized result when the engine sends no text', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/ctx'
  const result = { type: 'text', file: { filePath: `${root}/README.md`, content: 'y'.repeat(3900), numLines: 1, startLine: 1, totalLines: 1 } }
  on('tool.call', { tool: 'Read' }, () => ({ result }))
  const clock = contextWorld(on, ran, root)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(80) })
  await $.tool.call({ tool: 'Read', file_path: `${root}/README.md` } as any)
  await clock.settle()
  const expected = Math.ceil(JSON.stringify(result).length / 4)
  const row = (await rowsOf(ui)).rows.find((r: any) => r.id === `${root}/README.md`)
  expect(row.right.find((s: any) => s.t.startsWith(' · '))?.t).toBe(` · ${(expected / 1000).toFixed(1).replace(/\.0$/, '')}k`)
  await ui.unmount()
})

test('batched shell writes go to the command that names the file, else to "shell"', async () => {
  const writers = [{ command: 'sed -i s/a/b/ src/a.ts', since: 10 }, { command: 'npm run build', since: 12 }]
  const files = { '/r/src/c.ts': { line: 1, tokens: 0, live: false, by: { main: { edited: 15 } } } }
  const owners = attribute(['/r/src/a.ts', '/r/dist/out.js', '/r/src/c.ts'], writers, files)
  expect([...owners]).toEqual([['/r/src/a.ts', 0], ['/r/dist/out.js', -1]])
  expect([...attribute(['/r/dist/out.js'], [writers[1]!], {})]).toEqual([['/r/dist/out.js', 0]])
})
