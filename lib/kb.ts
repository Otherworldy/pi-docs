import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  constants,
  type Dirent,
} from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  link,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";

export const CONFIG_FILENAME = "pi-kb.json";
export const AUTHOR = "pi-agent";
export const TEXT_EXTS = new Set([".md", ".mdx", ".txt", ".html", ".htm", ".json", ".yaml", ".yml"]);
export const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules"]);
export const QUERY_MAX = 512;
export const TITLE_MAX = 120;
export const BODY_MAX = 16 * 1024;
export const SNIPPET_MAX = 300;
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 20;
export const OUTPUT_MAX = 12 * 1024;
export const FILE_MAX = 1024 * 1024;
export const MAX_DIRENTS = 10_000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const SCAN_MS = 5000;

export type RootInput = {
  name: string;
  path: string;
  writable?: boolean;
  exclude?: string[];
};

export type LoadedRoot = {
  name: string;
  configuredPath: string;
  path: string;
  realPath?: string;
  writable: boolean;
  exclude: string[];
  exists: boolean;
};

export type LoadedConfig = {
  ok: true;
  configPath: string;
  roots: LoadedRoot[];
  writable?: LoadedRoot;
} | {
  ok: false;
  configPath: string;
  error: string;
};

export type ReadRef = {
  id: string;
  sourcePath: string;
  sourceHash: string;
  sourceTitle: string;
};

export type Snippet = { line: number; text: string };

export type SearchHit = {
  kind: "digest" | "lesson" | "original";
  root: string;
  path: string;
  relPath: string;
  sourcePath?: string;
  sourceStatus?: "unchanged" | "changed" | "missing" | "out-of-scope" | "unverified";
  pathHit: boolean;
  snippets: Snippet[];
  preview?: string;
  pathScore: number;
};

export type SearchOk = {
  ok: true;
  hits: SearchHit[];
  originalsSearched: boolean;
  truncated: boolean;
  skipped: number;
  skipReasons: string[];
};

export type WriteOk = {
  ok: true;
  path: string;
  kind: "digest" | "lesson";
  status: "created" | "already_exists";
  cleanupFailed?: boolean;
};

export type Fail = { ok: false; error: string };

export type Budget = {
  deadline: number;
  dirents: number;
  bodyBytes: number;
  skipped: number;
  reasons: string[];
  truncated: boolean;
  signal?: AbortSignal;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function expandUserPath(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function pathApi(platform = process.platform) {
  return platform === "win32" ? win32 : posix;
}

/** Stable path identity: Windows is case-insensitive and slash-insensitive. */
export function pathKey(p: string, platform = process.platform): string {
  const n = pathApi(platform).normalize(p);
  return platform === "win32" ? n.toLowerCase() : n;
}

export function samePath(a: string, b: string, platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

export function pathInside(child: string, parent: string, platform = process.platform): boolean {
  const api = pathApi(platform);
  const c = api.resolve(child);
  const p = api.resolve(parent);
  const rel = api.relative(p, c);
  return rel === "" || (!rel.startsWith(`..${api.sep}`) && rel !== ".." && !api.isAbsolute(rel));
}

export function excluded(relPath: string, rules: string[]): boolean {
  const norm = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  for (const rule of rules) {
    const r = rule.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!r) continue;
    if (norm === r || norm.startsWith(`${r}/`)) return true;
  }
  return false;
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (whole, ent: string) => {
    const named = NAMED_ENTITIES[ent];
    if (named !== undefined) return named;
    let n: number;
    if (ent.startsWith("#x") || ent.startsWith("#X")) n = Number.parseInt(ent.slice(2), 16);
    else n = Number.parseInt(ent.slice(1), 10);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(n);
    } catch {
      return whole;
    }
  });
}

export function foldSpace(text: string): string {
  return text.replace(/[ \t]+/g, " ");
}

export function parseConfigJson(raw: unknown): { ok: true; roots: RootInput[] } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "配置必须是对象" };
  const roots = (raw as { roots?: unknown }).roots;
  if (!Array.isArray(roots)) return { ok: false, error: "缺少 roots 数组" };
  const names = new Set<string>();
  let writable = 0;
  const out: RootInput[] = [];
  for (const item of roots) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "root 必须是对象" };
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name.trim()) return { ok: false, error: "root.name 不能为空" };
    if (typeof rec.path !== "string" || !rec.path.trim()) return { ok: false, error: "root.path 不能为空" };
    if (names.has(rec.name)) return { ok: false, error: `重复的 root 名: ${rec.name}` };
    names.add(rec.name);
    const isWritable = rec.writable === true;
    if (isWritable) writable += 1;
    if (writable > 1) return { ok: false, error: "初版只允许一个可写 root" };
    if (rec.exclude !== undefined) {
      if (!Array.isArray(rec.exclude) || rec.exclude.some((x) => typeof x !== "string")) {
        return { ok: false, error: "exclude 必须是字符串数组" };
      }
    }
    const path = rec.path.trim();
    if (!path.startsWith("~") && !isAbsolute(path)) return { ok: false, error: `root.path 必须是绝对路径或 ~/：${rec.name}` };
    out.push({
      name: rec.name.trim(),
      path,
      writable: isWritable,
      exclude: (rec.exclude as string[] | undefined) ?? [],
    });
  }
  return { ok: true, roots: out };
}

export async function loadConfigFile(configPath: string, home = homedir()): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, configPath, error: `配置不存在: ${configPath}` };
    return { ok: false, configPath, error: `无法读取配置: ${configPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, configPath, error: "配置不是合法 JSON" };
  }
  const spec = parseConfigJson(parsed);
  if (!spec.ok) return { ok: false, configPath, error: spec.error };
  const roots: LoadedRoot[] = [];
  for (const item of spec.roots) {
    const expanded = resolve(expandUserPath(item.path, home));
    const loaded: LoadedRoot = {
      name: item.name,
      configuredPath: item.path,
      path: expanded,
      writable: item.writable === true,
      exclude: item.exclude ?? [],
      exists: false,
    };
    try {
      const st = await lstat(expanded);
      if (st.isSymbolicLink() || st.isDirectory()) {
        const real = await realpath(expanded);
        loaded.realPath = real;
        loaded.exists = true;
      }
    } catch {
      loaded.exists = false;
    }
    roots.push(loaded);
  }
  return {
    ok: true,
    configPath,
    roots,
    writable: roots.find((r) => r.writable),
  };
}

export function mostSpecificRoot(realFile: string, roots: LoadedRoot[]): LoadedRoot | undefined {
  let best: LoadedRoot | undefined;
  let bestLen = -1;
  for (const root of roots) {
    const base = root.realPath ?? root.path;
    if (!pathInside(realFile, base)) continue;
    const len = base.length;
    if (len > bestLen) {
      best = root;
      bestLen = len;
    }
  }
  return best;
}

export function coveredAndExcluded(realFile: string, roots: LoadedRoot[]): boolean {
  for (const root of roots) {
    const base = root.realPath ?? root.path;
    if (!pathInside(realFile, base)) continue;
    const rel = relative(base, realFile);
    if (excluded(rel, root.exclude)) return true;
  }
  return false;
}

export function tokenizeQuery(query: string): string[] | Fail {
  if (query.length > QUERY_MAX) return { ok: false, error: `查询过长（>${QUERY_MAX}）` };
  const terms = query.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return { ok: false, error: "查询不能为空" };
  return terms;
}

function clipAround(line: string, needle: string, max = SNIPPET_MAX): string {
  if (line.length <= max) return line;
  const idx = line.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, (idx < 0 ? 0 : idx) - Math.floor(max / 3));
  let slice = line.slice(start, start + max);
  if (start > 0) slice = `…${slice.slice(1)}`;
  if (start + max < line.length) slice = `${slice.slice(0, -1)}…`;
  return slice;
}

function hayHas(hay: string, term: string): boolean {
  return hay.includes(term.toLowerCase());
}

type NoteMeta = {
  type: "digest" | "lesson";
  createdAt: string;
  author: string;
  cwd: string;
  sourcePath?: string;
  sourceHash?: string;
  sourceTitle?: string;
  coverage?: string;
};

const META_RE = /^<!-- pi-kb\n([\s\S]*?)\n-->\n?/;

export function parseNoteMeta(text: string): NoteMeta | null {
  const m = META_RE.exec(text);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as Record<string, unknown>;
    if (raw.type !== "digest" && raw.type !== "lesson") return null;
    if (typeof raw.createdAt !== "string" || typeof raw.author !== "string" || typeof raw.cwd !== "string") return null;
    const meta: NoteMeta = {
      type: raw.type,
      createdAt: raw.createdAt,
      author: raw.author,
      cwd: raw.cwd,
    };
    if (raw.type === "digest") {
      if (typeof raw.sourcePath !== "string" || typeof raw.sourceHash !== "string") return null;
      if (raw.coverage !== "full-text") return null;
      meta.sourcePath = raw.sourcePath;
      meta.sourceHash = raw.sourceHash;
      meta.sourceTitle = typeof raw.sourceTitle === "string" ? raw.sourceTitle : "";
      meta.coverage = "full-text";
    }
    return meta;
  } catch {
    return null;
  }
}

export function formatNote(meta: Record<string, unknown>, title: string, body: string): string {
  return `<!-- pi-kb\n${JSON.stringify(meta)}\n-->\n\n# ${title}\n\n${body.trim()}\n`;
}

export function digestFileName(sourcePath: string, sourceHash: string, platform = process.platform): string {
  return `${sha256(pathKey(sourcePath, platform))}-${sourceHash}.md`;
}

export function findSecretKind(text: string): string | null {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) return "private-key";
  if (/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/.test(text)) return "github-token";
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(text)) return "api-token";
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(text)) return "slack-token";
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return "aws-key";
  const m = text.match(/\b(password|passwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?([^\s"'#]+)/i);
  if (m?.[2]) {
    const v = m[2];
    if (v.length < 8) return null;
    if (/^(your[_-]?.*|xxx+|placeholder|example|changeme|<[^>]+>|\$\{.*\})$/i.test(v)) return null;
    return "labeled-secret";
  }
  return null;
}

function newBudget(signal?: AbortSignal, now = Date.now()): Budget {
  return {
    deadline: now + SCAN_MS,
    dirents: 0,
    bodyBytes: 0,
    skipped: 0,
    reasons: [],
    truncated: false,
    signal,
  };
}

function budgetStop(b: Budget, reason: string): boolean {
  if (b.signal?.aborted) {
    b.truncated = true;
    b.reasons.push("cancelled");
    return true;
  }
  if (Date.now() > b.deadline) {
    b.truncated = true;
    b.reasons.push("time");
    return true;
  }
  if (b.dirents >= MAX_DIRENTS) {
    b.truncated = true;
    b.reasons.push("dirents");
    return true;
  }
  if (b.bodyBytes >= MAX_BODY_BYTES) {
    b.truncated = true;
    b.reasons.push("body-bytes");
    return true;
  }
  if (reason) {
    /* used by callers via skip */
  }
  return false;
}

function skip(b: Budget, reason: string): void {
  b.skipped += 1;
  if (b.reasons.length < 8 && !b.reasons.includes(reason)) b.reasons.push(reason);
}

export async function ensureWritableDir(root: LoadedRoot): Promise<string> {
  if (root.realPath) return root.realPath;
  const parent = dirname(root.path);
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    throw new Error(`可写目录的父路径不存在: ${parent}`);
  }
  const target = join(parentReal, basename(root.path));
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const real = await realpath(target);
  if (!pathInside(real, parentReal)) throw new Error("可写目录解析后离开了已验证的父目录");
  const st = await lstat(real);
  if (!st.isDirectory()) throw new Error("可写路径不是目录");
  root.realPath = real;
  root.exists = true;
  return real;
}

async function walkFiles(
  root: LoadedRoot,
  skipInside: string[],
  b: Budget,
  visit: (realPath: string, relPath: string) => Promise<void>,
): Promise<void> {
  const base = root.realPath;
  if (!base) return;
  const stack = [base];
  while (stack.length) {
    if (budgetStop(b, "")) return;
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skip(b, "unreadable-dir");
      continue;
    }
    for (const ent of entries) {
      b.dirents += 1;
      if (budgetStop(b, "")) return;
      const abs = join(dir, ent.name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        skip(b, "unreadable-file");
        continue;
      }
      if (st.isSymbolicLink()) {
        skip(b, "symlink");
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (skipInside.some((p) => pathInside(abs, p) || samePath(abs, p))) continue;
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (!TEXT_EXTS.has(extname(ent.name).toLowerCase())) continue;
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        skip(b, "unreadable-file");
        continue;
      }
      if (skipInside.some((p) => pathInside(real, p) || samePath(real, p))) continue;
      if (coveredAndExcluded(real, [root])) continue;
      const rel = relative(base, real);
      await visit(real, rel);
    }
  }
}

async function readUtf8Limited(path: string, b: Budget): Promise<{ text: string; buf: Buffer } | null> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    skip(b, "unreadable-file");
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    skip(b, "symlink");
    return null;
  }
  if (st.size > FILE_MAX) {
    skip(b, "too-large");
    return null;
  }
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    skip(b, "unreadable-file");
    return null;
  }
  b.bodyBytes += buf.byteLength;
  if (buf.includes(0)) {
    skip(b, "binary");
    return null;
  }
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) {
    skip(b, "non-utf8");
    return null;
  }
  return { text, buf };
}

function asLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function matchFile(
  terms: string[],
  relPath: string,
  text: string,
  extra = "",
): { pathScore: number; pathHit: boolean; snippets: Snippet[]; preview?: string } | null {
  const origLines = asLines(text);
  const decodedLines = origLines.map((line) => decodeEntities(line));
  const decoded = decodedLines.join("\n");
  const pathHay = foldSpace(`${relPath.replaceAll("\\", "/")}\n${extra}`).toLowerCase();
  const bodyHay = foldSpace(`${origLines.join("\n")}\n${decoded}`).toLowerCase();
  const hay = `${pathHay}\n${bodyHay}`;
  for (const term of terms) {
    if (!hayHas(hay, term)) return null;
  }
  let pathScore = 0;
  for (const term of terms) {
    if (hayHas(pathHay, term)) pathScore += 1;
  }
  const snippets: Snippet[] = [];
  for (let i = 0; i < origLines.length && snippets.length < 2; i++) {
    const o = origLines[i];
    const d = decodedLines[i];
    const lineHay = foldSpace(`${o}\n${d}`).toLowerCase();
    const hit = terms.find((t) => hayHas(lineHay, t));
    if (!hit) continue;
    snippets.push({ line: i + 1, text: clipAround(d, hit) });
  }
  const pathHit = pathScore > 0 && snippets.length === 0;
  let preview: string | undefined;
  if (pathHit) {
    const first = decodedLines.find((l) => l.trim()) ?? decodedLines[0] ?? "";
    preview = clipAround(first, terms[0] ?? "");
  }
  return { pathScore, pathHit, snippets, preview };
}

async function validateDigest(
  text: string,
  config: Extract<LoadedConfig, { ok: true }>,
  b: Budget,
): Promise<{ usable: boolean; meta: NoteMeta; sourceStatus: SearchHit["sourceStatus"] }> {
  const meta = parseNoteMeta(text);
  if (!meta || meta.type !== "digest" || !meta.sourcePath || !meta.sourceHash) {
    return { usable: false, meta: meta ?? { type: "digest", createdAt: "", author: "", cwd: "" }, sourceStatus: "unverified" };
  }
  let sourceReal: string;
  try {
    sourceReal = await realpath(meta.sourcePath);
  } catch {
    return { usable: false, meta, sourceStatus: "missing" };
  }
  const owner = mostSpecificRoot(sourceReal, config.roots);
  if (!owner || coveredAndExcluded(sourceReal, config.roots)) {
    return { usable: false, meta, sourceStatus: "out-of-scope" };
  }
  if (config.writable?.realPath && pathInside(sourceReal, config.writable.realPath)) {
    return { usable: false, meta, sourceStatus: "out-of-scope" };
  }
  const got = await readUtf8Limited(sourceReal, b);
  if (!got) return { usable: false, meta, sourceStatus: "unverified" };
  const hash = sha256(got.buf);
  if (hash !== meta.sourceHash) return { usable: false, meta, sourceStatus: "changed" };
  return { usable: true, meta, sourceStatus: "unchanged" };
}

async function searchLayer(
  config: Extract<LoadedConfig, { ok: true }>,
  roots: LoadedRoot[],
  skipInside: string[],
  terms: string[],
  kindHint: "ai" | "original",
  b: Budget,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root.exists || !root.realPath) continue;
    await walkFiles(root, skipInside, b, async (realPath, relPath) => {
      const seenKey = pathKey(realPath);
      if (seen.has(seenKey)) return;
      if (coveredAndExcluded(realPath, roots)) {
        skip(b, "excluded");
        return;
      }
      const owner = mostSpecificRoot(realPath, config.roots) ?? root;
      const got = await readUtf8Limited(realPath, b);
      if (!got) return;
      seen.add(seenKey);
      let kind: SearchHit["kind"] = "original";
      let extra = "";
      let sourcePath: string | undefined;
      let sourceStatus: SearchHit["sourceStatus"];
      if (kindHint === "ai") {
        const meta = parseNoteMeta(got.text);
        if (meta?.type === "digest") {
          const v = await validateDigest(got.text, config, b);
          kind = "digest";
          sourcePath = v.meta.sourcePath;
          sourceStatus = v.sourceStatus;
          extra = `${v.meta.sourceTitle ?? ""}\n${v.meta.sourcePath ?? ""}`;
          if (!v.usable) {
            skip(b, `stale-digest:${v.sourceStatus}`);
            return;
          }
        } else if (meta?.type === "lesson") {
          kind = "lesson";
        } else {
          kind = "lesson";
        }
      }
      const matched = matchFile(terms, relPath, got.text, extra);
      if (!matched) return;
      hits.push({
        kind,
        root: owner.name,
        path: realPath,
        relPath: relative(owner.realPath ?? owner.path, realPath),
        sourcePath,
        sourceStatus,
        pathHit: matched.pathHit,
        snippets: matched.snippets,
        preview: matched.preview,
        pathScore: matched.pathScore,
      });
    });
  }
  hits.sort((a, b) => b.pathScore - a.pathScore || a.path.localeCompare(b.path));
  return hits;
}

export async function searchKb(
  config: LoadedConfig,
  query: string,
  opts: { root?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<SearchOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  const terms = tokenizeQuery(query);
  if (!Array.isArray(terms)) return terms;
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const b = newBudget(opts.signal);
  const writable = config.writable;
  const writableReal = writable?.realPath ? [writable.realPath] : [];

  if (opts.root) {
    const root = config.roots.find((r) => r.name === opts.root);
    if (!root) return { ok: false, error: `未知 root: ${opts.root}` };
    if (!root.exists) {
      if (root.writable) {
        return { ok: true, hits: [], originalsSearched: !root.writable, truncated: false, skipped: 0, skipReasons: [] };
      }
      return { ok: false, error: `root 目录不存在: ${root.name} (${root.path})` };
    }
    const skipInside = root.writable ? [] : writableReal;
    const hits = await searchLayer(config, [root], skipInside, terms, root.writable ? "ai" : "original", b);
    return {
      ok: true,
      hits: hits.slice(0, limit),
      originalsSearched: !root.writable,
      truncated: b.truncated,
      skipped: b.skipped,
      skipReasons: b.reasons,
    };
  }

  let aiHits: SearchHit[] = [];
  if (writable?.exists && writable.realPath) {
    aiHits = await searchLayer(config, [writable], [], terms, "ai", b);
  } else if (writable && !writable.exists) {
    /* empty writable is fine */
  }
  if (aiHits.length > 0) {
    return {
      ok: true,
      hits: aiHits.slice(0, limit),
      originalsSearched: false,
      truncated: b.truncated,
      skipped: b.skipped,
      skipReasons: b.reasons,
    };
  }
  const originalRoots = config.roots.filter((r) => !r.writable);
  const missing = originalRoots.filter((r) => !r.exists);
  if (missing.length && originalRoots.every((r) => !r.exists)) {
    return { ok: false, error: `只读 root 不存在: ${missing.map((r) => r.name).join(", ")}` };
  }
  const origHits = await searchLayer(config, originalRoots.filter((r) => r.exists), writableReal, terms, "original", b);
  return {
    ok: true,
    hits: origHits.slice(0, limit),
    originalsSearched: true,
    truncated: b.truncated,
    skipped: b.skipped,
    skipReasons: b.reasons,
  };
}

export function formatSearch(result: SearchOk): string {
  const lines = [
    `originalsSearched: ${result.originalsSearched}`,
    `truncated: ${result.truncated}`,
    `skipped: ${result.skipped}${result.skipReasons.length ? ` (${result.skipReasons.join(", ")})` : ""}`,
    `hits: ${result.hits.length}`,
  ];
  if (result.hits.length === 0) {
    lines.push("", "无命中。缩短关键词或指定原始 root 再试，不要立即认定资料不存在。");
    return lines.join("\n");
  }
  for (const hit of result.hits) {
    const status = hit.sourceStatus ? ` 来源${hit.sourceStatus}` : "";
    lines.push("", `## ${hit.kind}  root=${hit.root}${status}`);
    lines.push(hit.path);
    if (hit.sourcePath) lines.push(`来源: ${hit.sourcePath}`);
    if (hit.pathHit) lines.push(`文件名/路径命中${hit.preview ? `: ${hit.preview}` : ""}`);
    for (const s of hit.snippets) lines.push(`L${s.line}: ${s.text}`);
  }
  return lines.join("\n");
}

function validateTitleBody(title: string, body: string): Fail | null {
  const t = title.trim();
  const b = body.trim();
  if (!t || t.includes("\n")) return { ok: false, error: "标题必须是非空单行" };
  if (t.length > TITLE_MAX) return { ok: false, error: `标题过长（>${TITLE_MAX}）` };
  if (!b) return { ok: false, error: "正文不能为空" };
  if (Buffer.byteLength(body, "utf8") > BODY_MAX) return { ok: false, error: `正文过长（>${BODY_MAX}）` };
  const secret = findSecretKind(`${title}\n${body}`);
  if (secret) return { ok: false, error: `疑似密钥（${secret}），请脱敏后再记` };
  return null;
}

async function publishFile(
  dir: string,
  fileName: string,
  content: string,
  kind: "digest" | "lesson",
  onExists: "reuse" | "retry",
): Promise<WriteOk | Fail> {
  const finalPath = join(dir, fileName);
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  let published = false;
  let result: WriteOk | Fail | undefined;
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, finalPath);
      published = true;
      result = { ok: true, path: finalPath, kind, status: "created" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        result = onExists === "reuse"
          ? { ok: true, path: finalPath, kind, status: "already_exists" }
          : { ok: false, error: "文件名冲突，请重试" };
      } else {
        try {
          await copyFile(tmp, finalPath, constants.COPYFILE_EXCL);
          published = true;
          result = { ok: true, path: finalPath, kind, status: "created" };
        } catch (copyErr) {
          const copyCode = (copyErr as NodeJS.ErrnoException).code;
          if (copyCode === "EEXIST") {
            result = onExists === "reuse"
              ? { ok: true, path: finalPath, kind, status: "already_exists" }
              : { ok: false, error: "文件名冲突，请重试" };
          } else {
            result = { ok: false, error: `写入失败: ${copyCode ?? code ?? "unknown"}` };
          }
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    result = { ok: false, error: code === "EEXIST" ? "临时文件冲突，请重试" : `写入失败: ${code ?? "unknown"}` };
  }
  try {
    await unlink(tmp);
  } catch {
    if (published && result?.ok) result.cleanupFailed = true;
  }
  return result ?? { ok: false, error: "写入失败" };
}

export async function existingDigestPath(
  config: Extract<LoadedConfig, { ok: true }>,
  sourcePath: string,
  sourceHash: string,
): Promise<string | undefined> {
  const w = config.writable;
  if (!w?.realPath) return;
  const p = join(w.realPath, "digests", digestFileName(sourcePath, sourceHash));
  try {
    await access(p, constants.F_OK);
    const text = await readFile(p, "utf8");
    const meta = parseNoteMeta(text);
    if (meta?.type === "digest" && meta.sourceHash === sourceHash && samePath(meta.sourcePath, sourcePath)) return p;
  } catch {
    return;
  }
}

export async function writeLesson(
  config: LoadedConfig,
  input: { title: string; body: string; cwd: string; now?: Date },
): Promise<WriteOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.writable) return { ok: false, error: "未配置记录目录" };
  const bad = validateTitleBody(input.title, input.body);
  if (bad) return bad;
  const dir = join(await ensureWritableDir(config.writable), "lessons");
  await mkdir(dir, { recursive: true });
  const dirReal = await realpath(dir);
  if (!pathInside(dirReal, config.writable.realPath!)) return { ok: false, error: "lessons 目录逃出可写 root" };
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const fileName = `${day}-${randomUUID()}.md`;
  const meta = {
    type: "lesson",
    createdAt: (input.now ?? new Date()).toISOString(),
    author: AUTHOR,
    cwd: input.cwd,
  };
  return publishFile(dirReal, fileName, formatNote(meta, input.title.trim(), input.body), "lesson", "retry");
}

export async function writeDigest(
  config: LoadedConfig,
  input: { title: string; body: string; cwd: string; ref: ReadRef; now?: Date },
): Promise<WriteOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.writable) return { ok: false, error: "未配置记录目录" };
  const bad = validateTitleBody(input.title, input.body);
  if (bad) return bad;
  let sourceReal: string;
  try {
    sourceReal = await realpath(input.ref.sourcePath);
  } catch {
    return { ok: false, error: "来源已消失，请重读后再整理" };
  }
  if (coveredAndExcluded(sourceReal, config.roots) || !mostSpecificRoot(sourceReal, config.roots)) {
    return { ok: false, error: "来源不在当前允许范围内" };
  }
  if (config.writable.realPath && pathInside(sourceReal, config.writable.realPath)) {
    return { ok: false, error: "不能把 AI 笔记再整理成资料整理" };
  }
  const buf = await readFile(sourceReal);
  const hash = sha256(buf);
  if (hash !== input.ref.sourceHash) return { ok: false, error: "来源在读取后已变化，请重读后再整理" };
  const existed = await existingDigestPath(config, sourceReal, hash);
  if (existed) return { ok: true, path: existed, kind: "digest", status: "already_exists" };
  const dir = join(await ensureWritableDir(config.writable), "digests");
  await mkdir(dir, { recursive: true });
  const dirReal = await realpath(dir);
  if (!pathInside(dirReal, config.writable.realPath!)) return { ok: false, error: "digests 目录逃出可写 root" };
  const fileName = digestFileName(sourceReal, hash);
  const meta = {
    type: "digest",
    createdAt: (input.now ?? new Date()).toISOString(),
    author: AUTHOR,
    cwd: input.cwd,
    sourcePath: sourceReal,
    sourceHash: hash,
    sourceTitle: input.ref.sourceTitle,
    coverage: "full-text",
  };
  const published = await publishFile(dirReal, fileName, formatNote(meta, input.title.trim(), input.body), "digest", "reuse");
  if (published.ok && published.status === "already_exists") {
    const again = await existingDigestPath(config, sourceReal, hash);
    if (again) return { ok: true, path: again, kind: "digest", status: "already_exists" };
    return { ok: false, error: "同版本整理正在写入或损坏，请重试" };
  }
  return published;
}

export function sourceTitleFrom(path: string, text: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading) return heading[1].trim().slice(0, TITLE_MAX);
  return basename(path, extname(path));
}

export function formatStatus(config: LoadedConfig): string {
  const lines = [`配置: ${config.configPath}`];
  if (!config.ok) {
    lines.push(`状态: 不可用 — ${config.error}`);
    lines.push("策略: 未宣称知识库可用");
    return lines.join("\n");
  }
  lines.push("策略: AI 笔记优先；完整读原文后可整理；不改原笔记");
  lines.push(`格式: ${[...TEXT_EXTS].join(" ")}`);
  for (const root of config.roots) {
    const rw = root.writable ? "可写" : "只读";
    const ex = root.exclude.length ? ` exclude=${root.exclude.join("|")}` : "";
    let avail = root.exists ? root.realPath ?? root.path : root.writable ? "首次记录时创建" : "缺失";
    lines.push(`- ${root.name} (${rw}) ${root.path} [${avail}]${ex}`);
  }
  return lines.join("\n");
}

export function isOriginalTextFile(config: Extract<LoadedConfig, { ok: true }>, realPath: string): boolean {
  if (!TEXT_EXTS.has(extname(realPath).toLowerCase())) return false;
  if (config.writable?.realPath && pathInside(realPath, config.writable.realPath)) return false;
  if (!mostSpecificRoot(realPath, config.roots)) return false;
  if (coveredAndExcluded(realPath, config.roots)) return false;
  return true;
}
