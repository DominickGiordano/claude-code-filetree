import { stronger } from './icons';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const DEFAULT_THEME = {
    fg: '#cacccc',
    accent: '#cacccc',
    muted: '#707880',
    urgent: '#a55555',
    selection: '#2a2e3a',
};
export function emptyTree(root) {
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
        prefix: '',
        branch: null,
        counts: {},
        flash: [],
        flashDim: [],
        flashOn: false,
        flashTones: {},
    };
}
export function parseTheme(toml) {
    const get = (k) => toml.match(new RegExp(`^${k}\\s*=\\s*"(#[0-9a-fA-F]{6})"`, 'm'))?.[1];
    return {
        fg: get('foreground') ?? get('color7') ?? DEFAULT_THEME.fg,
        accent: get('accent') ?? get('color4') ?? DEFAULT_THEME.accent,
        muted: get('muted') ?? get('color8') ?? DEFAULT_THEME.muted,
        urgent: get('red') ?? get('color1') ?? DEFAULT_THEME.urgent,
        selection: get('selection') ?? DEFAULT_THEME.selection,
    };
}
export function join(dir, name) {
    return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}
export function dirname(path) {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
}
export function toNodes(dir, list) {
    return list
        .map(e => ({
        id: join(dir, e.name),
        parent: dir,
        name: e.name,
        kind: e.isLink ? 'link' : e.kind === 'dir' ? 'dir' : 'file',
        hidden: e.name.startsWith('.'),
        mtime: e.mtimeMs,
        loaded: false,
    }))
        .sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || collator.compare(a.name, b.name));
}
export function replaceChildren(nodes, dir, kids) {
    const keep = new Map(nodes.filter(n => n.parent === dir).map(n => [n.id, n]));
    const fresh = kids.map(k => {
        const old = keep.get(k.id);
        return old && old.kind === 'dir' && k.kind === 'dir' ? { ...k, loaded: old.loaded } : k;
    });
    const freshIds = new Set(fresh.map(k => k.id));
    const gone = [...keep.keys()].filter(id => !freshIds.has(id));
    const out = nodes.filter(n => n.parent !== dir && !gone.some(g => n.id.startsWith(g + '/')));
    return [...out.map(n => (n.id === dir ? { ...n, loaded: true } : n)), ...fresh];
}
export function parseBranch(record) {
    const body = record.replace(/^## /, '');
    if (body.startsWith('HEAD (no branch)'))
        return { head: 'detached', upstream: '', ahead: 0, behind: 0 };
    const head = body.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/)?.[1] ?? body;
    const upstream = body.match(/\.\.\.(\S+)/)?.[1] ?? '';
    const ahead = Number(body.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(body.match(/behind (\d+)/)?.[1] ?? 0);
    return { head, upstream, ahead, behind };
}
export function mapper(root, prefix) {
    return rel => (rel.startsWith(prefix) ? join(root, rel.slice(prefix.length).replace(/\/$/, '')).replace(/\/$/, '') : null);
}
export function parseGit(stdout, root, prefix) {
    const map = mapper(root, prefix);
    const git = {};
    const ignored = [];
    const untrackedDirs = [];
    const files = {};
    let branch = null;
    const parts = stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i] ?? '';
        if (rec.startsWith('## ')) {
            branch = parseBranch(rec);
            continue;
        }
        if (rec.length < 4)
            continue;
        const xy = rec.slice(0, 2);
        const raw = rec.slice(3);
        if (xy[0] === 'R' || xy[0] === 'C')
            i++;
        const path = map(raw);
        if (!path)
            continue;
        if (xy === '!!') {
            ignored.push(path);
            continue;
        }
        if (xy === '??' && raw.endsWith('/'))
            untrackedDirs.push(path);
        else
            files[path] = xy === '??' || (xy.includes('A') && !xy.includes('D')) ? 'new' : xy.includes('D') && !/U/.test(xy) ? 'del' : 'mod';
        const letter = xy === '??'
            ? '?'
            : /U/.test(xy) || xy === 'AA' || xy === 'DD'
                ? 'U'
                : (['D', 'M', 'R', 'C', 'A', 'T'].find(c => xy.includes(c)) ?? '');
        if (!letter)
            continue;
        git[path] = stronger(git[path], letter);
        let dir = dirname(path);
        while (dir.length >= root.length && dir !== '/') {
            git[dir] = stronger(git[dir], letter);
            if (dir === root)
                break;
            dir = dirname(dir);
        }
    }
    return { git, ignored, untrackedDirs, branch, files };
}
export function parseNumstat(stdout, root, prefix, into) {
    const map = mapper(root, prefix);
    const parts = stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i] ?? '';
        if (!rec)
            continue;
        const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
        if (!m)
            continue;
        let path = m[3] ?? '';
        if (path === '') {
            i += 2;
            path = parts[i] ?? '';
        }
        if (!path)
            continue;
        const add = m[1] === '-' ? 0 : Number(m[1]);
        const del = m[2] === '-' ? 0 : Number(m[2]);
        const abs = map(path);
        if (!abs)
            continue;
        const prev = into[abs] ?? [0, 0];
        into[abs] = [prev[0] + add, prev[1] + del];
    }
}
export function rollUp(diff, root) {
    const out = { ...diff };
    for (const [path, [add, del]] of Object.entries(diff)) {
        let dir = dirname(path);
        while (dir.length >= root.length && dir !== '/') {
            const prev = out[dir] ?? [0, 0];
            out[dir] = [prev[0] + add, prev[1] + del];
            if (dir === root)
                break;
            dir = dirname(dir);
        }
    }
    return out;
}
export function rollCounts(files, root) {
    const out = {};
    const slot = { new: 0, mod: 1, del: 2 };
    for (const [path, change] of Object.entries(files)) {
        let dir = dirname(path);
        while (dir.length >= root.length && dir !== '/') {
            const cur = out[dir] ?? [0, 0, 0];
            cur[slot[change]] += 1;
            out[dir] = cur;
            if (dir === root)
                break;
            dir = dirname(dir);
        }
    }
    return out;
}
export function underAny(id, set, root) {
    if (set.size === 0)
        return false;
    let cur = id;
    while (cur.length >= root.length) {
        if (set.has(cur))
            return true;
        const up = dirname(cur);
        if (up === cur)
            break;
        cur = up;
    }
    return false;
}
export function ancestorsOf(id, root) {
    const out = [];
    let dir = dirname(id);
    while (dir.startsWith(root) && dir !== root) {
        out.push(dir);
        dir = dirname(dir);
    }
    return out;
}
export function visibleRows(t) {
    const kids = new Map();
    for (const n of t.nodes) {
        if (!t.showHidden && n.hidden)
            continue;
        const list = kids.get(n.parent);
        if (list)
            list.push(n);
        else
            kids.set(n.parent, [n]);
    }
    const q = t.query.trim().toLowerCase();
    let keep = null;
    if (q) {
        keep = new Set();
        for (const n of t.nodes) {
            if (!n.name.toLowerCase().includes(q))
                continue;
            keep.add(n.id);
            for (const a of ancestorsOf(n.id, t.root))
                keep.add(a);
        }
    }
    const open = new Set(t.expanded);
    const rows = [];
    const walk = (dir, depth) => {
        for (const n of kids.get(dir) ?? []) {
            if (keep && !keep.has(n.id))
                continue;
            const isOpen = n.kind === 'dir' && (keep ? kids.has(n.id) : open.has(n.id));
            rows.push({ node: n, depth, open: isOpen });
            if (isOpen)
                walk(n.id, depth + 1);
        }
    };
    walk(t.root, 0);
    return rows;
}
export function stamp(ms) {
    if (!ms)
        return '';
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
