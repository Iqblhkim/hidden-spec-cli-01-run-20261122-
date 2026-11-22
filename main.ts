// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), matching lines at three tiers (section 5), and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. Used to print `R old -> new` lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 5: matching lines, and section 3: a file's lines ----------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Positions where O occurs in lines at tier, at or after from; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (strict: tier 0 only), with its positions. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface FileState { br: string; lines: string[]; final: boolean; }

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

type Op = { kind: 'ctx' | 'old' | 'new'; text: string };

function reindent(line: string, tier: number, fileFirst: string, oFirst: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  const p = leadWS(oFirst);
  if (!line.startsWith(p)) return line;
  return leadWS(fileFirst) + line.slice(p.length);
}

/** Replace the matched lines at pos: context lines come from the file, new lines are re-indented at tier 2. */
function applyOps(lines: string[], pos: number, ops: Op[], tier: number, oFirst: string): string[] {
  const out = lines.slice();
  const oCount = ops.filter((o) => o.kind !== 'new').length;
  const repl: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') { repl.push(lines[pos + oi]!); oi += 1; }
    else if (op.kind === 'old') oi += 1;
    else repl.push(reindent(op.text, tier, lines[pos]!, oFirst));
  }
  out.splice(pos, oCount, ...repl);
  return out;
}

// ---------- section 6: unified diffs ----------

interface Hunk { a: number; ops: Op[]; noNL: boolean; plusNoNL: boolean | null; }

interface Section {
  oldP: string | null; newP: string | null;
  create: boolean; del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const l = lines[i]!;
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  let j = i + 1;
  interface BodyLine { raw: string; kind: 'ctx' | 'old' | 'new' | 'mark'; text: string; }
  const body: BodyLine[] = [];
  while (j < lines.length) {
    const b = lines[j]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (b === '') { body.push({ raw: b, kind: 'ctx', text: '' }); j += 1; }
    else if (b.startsWith(' ')) { body.push({ raw: b, kind: 'ctx', text: b.slice(1) }); j += 1; }
    else if (b.startsWith('-')) { body.push({ raw: b, kind: 'old', text: b.slice(1) }); j += 1; }
    else if (b.startsWith('+')) { body.push({ raw: b, kind: 'new', text: b.slice(1) }); j += 1; }
    else if (b.startsWith('\\')) { body.push({ raw: b, kind: 'mark', text: b.slice(1) }); j += 1; }
    else break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  const ops: Op[] = [];
  let noNL = false;
  let plusNoNL: boolean | null = null;
  for (let k = 0; k < body.length; k += 1) {
    const e = body[k]!;
    if (e.kind === 'mark') continue;
    ops.push({ kind: e.kind, text: e.text });
    const followedByMark = body[k + 1] !== undefined && body[k + 1]!.kind === 'mark';
    if (e.kind === 'ctx' || e.kind === 'new') {
      let last = true;
      for (let q = k + 1; q < body.length; q += 1) {
        if (body[q]!.kind === 'ctx' || body[q]!.kind === 'new') { last = false; break; }
      }
      if (last) noNL = followedByMark;
    }
    if (e.kind === 'new') {
      let last = true;
      for (let q = k + 1; q < body.length; q += 1) {
        if (body[q]!.kind === 'new') { last = false; break; }
      }
      if (last) plusNoNL = followedByMark;
    }
  }
  return { hunk: { a, ops, noNL, plusNoNL }, next: j };
}

function applyUnifiedHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(content);
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
    const N = h.ops.filter((o) => o.kind !== 'old').map((o) => o.text);
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      const ins = h.ops.filter((o) => o.kind === 'new').map((o) => o.text);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (atEnd) final = !h.noNL;
      d += N.length;
    } else {
      const found = findTier(O, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const atEnd = best + O.length === lines.length;
      lines = applyOps(lines, best, h.ops, found.tier, O[0]!);
      if (atEnd) final = !h.noNL;
      d += N.length - O.length;
    }
  }
  return renderFile({ br: f.br, lines, final });
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.create) {
      const target = sec.newP ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'new') plus.push(op.text);
      let noNL: boolean | null = null;
      for (const h of sec.hunks) if (h.plusNoNL !== null) noNL = h.plusNoNL;
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noNL === true ? '' : '\n'));
      return;
    }
    if (sec.del) {
      const target = sec.oldP ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const oldP = sec.oldP ?? '';
    const newP = sec.newP ?? '';
    if (sec.oldP !== null && sec.newP !== null && sec.oldP !== sec.newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyUnifiedHunks(content, sec.hunks, strict, oldP);
      tree.now.set(newP, result);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const target = sec.oldP ?? sec.newP ?? '';
    if (!safe(target)) throw new Fail('unsafe', target);
    const content = tree.get(target);
    if (content === null) throw new Fail('missing', target);
    tree.now.set(target, applyUnifiedHunks(content, sec.hunks, strict, target));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      gitOld = m[1]!;
      gitNew = m[2]!;
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A bare section: i stays on the --- line; the section loop reads the pair.
    } else {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    let pairOld: string | null = null;
    let pairNew: string | null = null;
    let pairSeen = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let create = false;
    let del = false;
    const hunks: Hunk[] = [];
    let header = true;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!header) break;
        if (!pairSeen) {
          const oRaw = l.slice(4).split('\t')[0]!.trim();
          const nRaw = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
          pairOld = oRaw === '/dev/null' ? null : stripAB(oRaw);
          pairNew = nRaw === '/dev/null' ? null : stripAB(nRaw);
          pairSeen = true;
        }
        i += 2;
        continue;
      }
      if (header && l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const r = parseHunk(lines, i);
        hunks.push(r.hunk);
        i = r.next;
        header = false;
        continue;
      }
      if (header) {
        if (l.startsWith('rename from ')) renameFrom = l.slice(12).trim();
        else if (l.startsWith('rename to ')) renameTo = l.slice(10).trim();
        else if (l.startsWith('new file mode')) create = true;
        else if (l.startsWith('deleted file mode')) del = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    let oldP: string | null;
    let newP: string | null;
    if (pairSeen) { oldP = pairOld; newP = pairNew; }
    else { oldP = renameFrom ?? gitOld; newP = renameTo ?? gitNew; }
    const oldDevNull = pairSeen && pairOld === null;
    const newDevNull = pairSeen && pairNew === null;
    edits.push(unifiedSectionEdit({
      oldP, newP,
      create: create || oldDevNull,
      del: del || newDevNull,
      hunks,
    }, strict));
  }
  return edits;
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const f = parseFile(content);
    const found = findTier(oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'old', text: t })),
      ...newLines.map((t): Op => ({ kind: 'new', text: t })),
    ];
    const lines = applyOps(f.lines, found.occ[0]!, ops, found.tier, oldLines[0]!);
    tree.now.set(path, renderFile({ br: f.br, lines, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= lastEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let k = i + 1;
    let sep = -1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '=======') { sep = k; break; }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
      k += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let m = sep + 1;
    let end = -1;
    while (m < lines.length) {
      if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') { end = m; break; }
      m += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    lastEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

interface VChunk { anchor: string | null; ops: Op[]; eof: boolean; }

function applyV4aChunks(content: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = parseFile(content);
  let lines = f.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const found = findTier([ch.anchor], lines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.occ[0]! + 1;
    }
    const O = ch.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
    const N = ch.ops.filter((o) => o.kind !== 'old').map((o) => o.text);
    if (O.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const ins = ch.ops.filter((o) => o.kind === 'new').map((o) => o.text);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      cursor = pos + ins.length;
    } else {
      let placed: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrences(O, lines, t, cursor);
        const ok = ch.eof ? occ.filter((p) => p + O.length === lines.length) : occ;
        if (ok.length > 0) { placed = { tier: t, pos: ok[0]! }; break; }
      }
      if (placed === null) throw new Fail('no-match', path);
      lines = applyOps(lines, placed.pos, ch.ops, placed.tier, O[0]!);
      cursor = placed.pos + N.length;
    }
  }
  return renderFile({ br: f.br, lines, final: f.final });
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: { text: string; num: number }[], startLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let rest = raw;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let current: VChunk | null = null;
  let between = false;
  for (const r of rest) {
    const s = r.text;
    if (s.startsWith('@@')) {
      const a = s.slice(2).trim();
      current = { anchor: a === '' ? null : a, ops: [], eof: false };
      chunks.push(current);
      between = false;
    } else if (s === '*** End of File') {
      if (current === null) throw new Exit2(`error: parse ${r.num}`);
      current.eof = true;
      current = null;
      between = true;
    } else if (s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
      if (current === null) {
        if (s === '' && between) continue;
        if (chunks.length === 0 && !between) {
          current = { anchor: null, ops: [], eof: false };
          chunks.push(current);
        } else throw new Exit2(`error: parse ${r.num}`);
      }
      current.ops.push(
        s === '' ? { kind: 'ctx', text: '' }
          : s.startsWith(' ') ? { kind: 'ctx', text: s.slice(1) }
          : s.startsWith('-') ? { kind: 'old', text: s.slice(1) }
          : { kind: 'new', text: s.slice(1) },
      );
    } else {
      throw new Exit2(`error: parse ${r.num}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const result = applyV4aChunks(content, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    const addM = /^\*\*\* Add File: (.*)$/.exec(l);
    const delM = /^\*\*\* Delete File: (.*)$/.exec(l);
    const updM = /^\*\*\* Update File: (.*)$/.exec(l);
    if (addM === null && delM === null && updM === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = addM !== null ? 'add' : delM !== null ? 'del' : 'upd';
    const path = (addM ?? delM ?? updM)![1]!.trim();
    const startLine = i + 1;
    i += 1;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const s = lines[i]!;
      if (/^\*\*\* (Add|Delete|Update) File: /.test(s)) break;
      raw.push({ text: s, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, startLine, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { path: string; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, now });
  }
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  const display: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      display.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const c of changed) {
    if (consumed.has(c.path)) continue;
    const was = tree.original(c.path);
    display.push({ key: c.path, text: `${was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  display.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = display.map((d) => d.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
