import { expect, mock, test } from 'claude-code/testing'

type World = { os: 'darwin' | 'linux' | 'win32'; env: Record<string, string>; cwd: string; top: string; dirs: Record<string, [string, 'file' | 'dir'][]>; status: string; numstat: string }
type Ran = string[][]

function world(on: any, w: World, ran: Ran) {
  mock.env(on, w.env)
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
