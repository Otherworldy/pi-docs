import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  constants,
  type Dirent,
} from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  link,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  CACHE_DIRNAME,
  FILE_MAX,
  SKIP_DIRS,
  TEXT_EXTS,
  TITLE_MAX,
  asLines,
  cacheDirFor,
  decodeEntities,
  digestFileName,
  excluded,
  extractNoteTitle,
  foldSpace,
  normalizeNoteLines,
  parseShowDocInfo,
  parseShowDocReadme,
  pathInside,
  pathKey,
  samePath,
  sha256,
  sourceCachePath,
  sourceTitleFrom,
  stripBom,
} from "./source.mjs";
import {
  budgetStop as collectBudgetStop,
  indexRoot,
  newScanBudget,
  readUtf8Limited,
  skipInsidePaths,
  skipScan,
  walkTextFiles,
} from "./collect.mjs";
import { readGeneration, readTopManifest } from "./index-store.mjs";
import { searchRootIndex } from "./retrieval.mjs";

export {
  CACHE_DIRNAME,
  FILE_MAX,
  SKIP_DIRS,
  TEXT_EXTS,
  TITLE_MAX,
  asLines,
  cacheDirFor,
  decodeEntities,
  digestFileName,
  excluded,
  extractNoteTitle,
  foldSpace,
  normalizeNoteLines,
  parseShowDocInfo,
  parseShowDocReadme,
  pathInside,
  pathKey,
  samePath,
  sha256,
  sourceCachePath,
  sourceTitleFrom,
  stripBom,
};

export const CONFIG_FILENAME = "pi-kb.json";
export const AUTHOR = "pi-agent";
export const QUERY_MAX = 512;
export const BODY_MAX = 16 * 1024;
export const SNIPPET_MAX = 300;
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 20;
export const OUTPUT_MAX = 12 * 1024;
export const MAX_DIRENTS = 10_000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const SCAN_MS = 5000;
export const RULE_VERSION = 1;
export const LEGACY_CACHE_DIRNAME = "pi-kb-cache";
export const SNAPSHOT_MAX = 32 * 1024 * 1024;

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_TIMEOUT_MS = 60_000;

export type RootInput = {
  name: string;
  path: string;
  writable?: boolean;
  exclude?: string[];
};

export type EnrichSettings = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
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
  enrich?: EnrichSettings;
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
  kind: "digest" | "lesson" | "original" | "derived";
  root: string;
  path: string;
  relPath: string;
  title?: string;
  catalog?: string[];
  sourcePath?: string;
  sourceStatus?: "unchanged" | "changed" | "missing" | "out-of-scope" | "unverified";
  pathHit: boolean;
  snippets: Snippet[];
  preview?: string;
  pathScore: number;
  semanticMatch?: boolean;
  semanticEvidence?: string;
  partial?: boolean;
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

export type PreparedDoc = {
  path: string;
  relPath: string;
  title: string;
  catalog: string[];
  sourceHash: string;
  lines: string[];
};

export type PreparedSnapshot = {
  version: number;
  sourceName: string;
  sourcePath: string;
  sourceKey: string;
  exclude: string[];
  metaFingerprint: string;
  docs: PreparedDoc[];
  skipped: number;
  skipReasons: string[];
  truncated: boolean;
  preparedAt: string;
};

export type PrepareOk = {
  ok: true;
  snapshot: PreparedSnapshot;
  status: "created" | "reused" | "updated" | "memory_only";
  path?: string;
  processed: number;
  updated: number;
  persistError?: string;
};

export type Budget = {
  deadline: number;
  dirents: number;
  bodyBytes: number;
  skipped: number;
  reasons: string[];
  truncated: boolean;
  signal?: AbortSignal;
};


export function isTruncatedReadResult(details: unknown, text: string, offset?: number): boolean {
  const tr = details && typeof details === "object"
    ? (details as { truncation?: { truncated?: boolean } }).truncation
    : undefined;
  if (tr?.truncated) return true;
  if (offset !== undefined && offset > 1) return true;
  return /\[Showing lines |more lines in file\. Use offset=/.test(text);
}

export function normalizeReadRef(raw: string): string {
  const trimmed = raw.trim();
  const uuid = /(?:readRef\s*=\s*)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(trimmed);
  if (uuid) return uuid[1].toLowerCase();
  return trimmed.replace(/^["'`]+|["'`]+$/g, "").trim();
}

export function expandUserPath(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function parseEnrichSettings(raw: unknown): EnrichSettings | Fail | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "enrich 必须是对象" };
  const rec = raw as Record<string, unknown>;
  if (typeof rec.provider !== "string" || !rec.provider.trim()) return { ok: false, error: "enrich.provider 不能为空" };
  if (typeof rec.model !== "string" || !rec.model.trim()) return { ok: false, error: "enrich.model 不能为空" };
  const maxOutputTokens = rec.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : rec.maxOutputTokens;
  const timeoutMs = rec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : rec.timeoutMs;
  if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 8192) {
    return { ok: false, error: "enrich.maxOutputTokens 无效" };
  }
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    return { ok: false, error: "enrich.timeoutMs 无效" };
  }
  return {
    provider: rec.provider.trim(),
    model: rec.model.trim(),
    maxOutputTokens,
    timeoutMs,
  };
}

export function parseConfigJson(raw: unknown): { ok: true; roots: RootInput[]; enrich?: EnrichSettings } | Fail {
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
  const enrich = parseEnrichSettings((raw as { enrich?: unknown }).enrich);
  if (enrich && "ok" in enrich) return enrich;
  return { ok: true, roots: out, enrich };
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
    enrich: spec.enrich,
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
  return newScanBudget(signal, now) as Budget;
}

function budgetStop(b: Budget, _reason = ""): boolean {
  return collectBudgetStop(b);
}

function skip(b: Budget, reason: string): void {
  skipScan(b, reason);
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
  if (!root.realPath) return;
  await walkTextFiles(root.realPath, skipInside, b, (realPath, relPath) => visit(realPath, relPath), root.exclude);
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

function isAiNoteRel(relPath: string): boolean {
  const rel = relPath.replaceAll("\\", "/");
  return rel === "digests" || rel === "lessons" || rel.startsWith("digests/") || rel.startsWith("lessons/");
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
      if (kindHint === "ai" && !isAiNoteRel(relPath)) return;
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

type SemanticIndex = {
  path: string;
  sourceHash: string;
  topics?: unknown;
  aliases?: unknown;
  questions?: unknown;
  rules?: unknown;
};

async function loadSemanticIndex(sourcePath: string): Promise<SemanticIndex[]> {
  try {
    const p = join(cacheDirFor(sourcePath), "sem.json");
    const st = await lstat(p);
    if (!st.isFile() || st.isSymbolicLink() || st.size > SNAPSHOT_MAX) return [];
    const raw = JSON.parse(await readFile(p, "utf8")) as { records?: unknown };
    if (!Array.isArray(raw.records)) return [];
    return raw.records.filter((r): r is SemanticIndex => !!r && typeof r === "object" && typeof (r as SemanticIndex).path === "string" && typeof (r as SemanticIndex).sourceHash === "string");
  } catch {
    return [];
  }
}

function stringsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

function semanticExtra(rec: SemanticIndex | undefined): string {
  if (!rec) return "";
  const rules = Array.isArray(rec.rules)
    ? rec.rules.map((rule) => (rule && typeof rule === "object" ? `${(rule as { text?: string }).text ?? ""} ${(rule as { excerpt?: string }).excerpt ?? ""}` : "")).join("\n")
    : "";
  return [...stringsOf(rec.topics), ...stringsOf(rec.aliases), ...stringsOf(rec.questions), rules].join("\n");
}

function semanticEvidence(rec: SemanticIndex, terms: string[]): string | undefined {
  const fields = [...stringsOf(rec.topics), ...stringsOf(rec.aliases), ...stringsOf(rec.questions)];
  if (Array.isArray(rec.rules)) {
    for (const rule of rec.rules) {
      if (rule && typeof rule === "object" && typeof (rule as { text?: string }).text === "string") fields.push((rule as { text: string }).text);
    }
  }
  const hit = fields.find((field) => terms.some((term) => field.toLowerCase().includes(term.toLowerCase())));
  return hit?.slice(0, SNIPPET_MAX);
}

function hitsFromPrepared(snapshot: PreparedSnapshot, terms: string[], rootName: string, records: SemanticIndex[] = []): SearchHit[] {
  const byPath = new Map(records.map((r) => [pathKey(r.path), r]));
  const hits: SearchHit[] = [];
  for (const doc of snapshot.docs) {
    const rec = byPath.get(pathKey(doc.path));
    const usable = rec && rec.sourceHash === doc.sourceHash ? rec : undefined;
    const titleExtra = `${doc.title}\n${doc.catalog.join(" / ")}`;
    const text = doc.lines.join("\n");
    const base = matchFile(terms, doc.relPath, text, titleExtra);
    const matched = base ?? matchFile(terms, doc.relPath, text, `${titleExtra}\n${semanticExtra(usable)}`);
    if (!matched) continue;
    const semanticOnly = !base && !!usable;
    hits.push({
      kind: "original",
      root: rootName,
      path: doc.path,
      relPath: doc.relPath,
      title: doc.title,
      catalog: doc.catalog,
      pathHit: matched.pathHit,
      snippets: matched.snippets,
      preview: matched.preview,
      pathScore: matched.pathScore + (usable ? 1 : 0),
      semanticMatch: semanticOnly || undefined,
      semanticEvidence: semanticOnly ? semanticEvidence(usable, terms) : undefined,
    });
  }
  hits.sort((a, b) => b.pathScore - a.pathScore || a.path.localeCompare(b.path));
  return hits;
}

function mergeSkip(b: Budget, snapshot: PreparedSnapshot): void {
  b.truncated = b.truncated || snapshot.truncated;
  b.skipped += snapshot.skipped;
  for (const reason of snapshot.skipReasons) {
    if (b.reasons.length < 8 && !b.reasons.includes(reason)) b.reasons.push(reason);
  }
}

function makeSnippets(text: string, needles: string[], preferred: number[] = []): Snippet[] {
  const origLines = asLines(text);
  const decodedLines = origLines.map((line) => decodeEntities(line));
  const snippets: Snippet[] = [];
  const used = new Set<number>();
  const pick = (i: number) => {
    const lineHay = foldSpace(`${origLines[i]}\n${decodedLines[i]}`).toLowerCase();
    const hit = needles.find((t) => hayHas(lineHay, t));
    if (!hit) return;
    snippets.push({ line: i + 1, text: clipAround(decodedLines[i], hit) });
    used.add(i);
  };
  for (const lineNo of preferred) {
    if (snippets.length >= 2) break;
    const i = lineNo - 1;
    if (i >= 0 && i < origLines.length && !used.has(i)) pick(i);
  }
  for (let i = 0; i < origLines.length && snippets.length < 2; i++) {
    if (!used.has(i)) pick(i);
  }
  return snippets;
}

function mergeHits(hits: SearchHit[]): SearchHit[] {
  const merged = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = hit.kind === "lesson" ? `lesson:${pathKey(hit.path)}` : pathKey(hit.sourcePath ?? hit.path);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...hit, snippets: [...hit.snippets] });
      continue;
    }
    const rank: Record<string, number> = { digest: 3, derived: 2, original: 1, lesson: 0 };
    if ((rank[hit.kind] ?? 0) > (rank[prev.kind] ?? 0)) {
      prev.kind = hit.kind;
      prev.path = hit.path;
      prev.relPath = hit.relPath;
      prev.sourcePath = hit.sourcePath ?? prev.path;
      prev.sourceStatus = hit.sourceStatus ?? prev.sourceStatus;
    }
    if (hit.semanticMatch) {
      prev.semanticMatch = true;
      prev.semanticEvidence = prev.semanticEvidence ?? hit.semanticEvidence;
    }
    prev.pathScore = Math.max(prev.pathScore, hit.pathScore);
    prev.partial = Boolean(prev.partial && hit.partial) || undefined;
    if (!prev.snippets.length && hit.snippets.length) prev.snippets = hit.snippets;
    if (hit.title && !prev.title) prev.title = hit.title;
  }
  return [...merged.values()].sort((a, b) => b.pathScore - a.pathScore || a.path.localeCompare(b.path));
}

async function semanticHits(root: LoadedRoot, terms: string[]): Promise<SearchHit[]> {
  if (!root.realPath) return [];
  const recs = await loadSemanticIndex(root.realPath);
  const hits: SearchHit[] = [];
  for (const rec of recs) {
    const extra = semanticExtra(rec);
    const hay = foldSpace(extra).toLowerCase();
    if (!terms.every((t) => hayHas(hay, t))) continue;
    let buf: Buffer;
    try {
      buf = await readFile(rec.path);
    } catch {
      continue;
    }
    if (sha256(buf) !== rec.sourceHash) continue;
    hits.push({
      kind: "original",
      root: root.name,
      path: rec.path,
      relPath: relative(root.realPath, rec.path),
      pathHit: false,
      snippets: [],
      pathScore: 1,
      semanticMatch: true,
      semanticEvidence: semanticEvidence(rec, terms),
    });
  }
  return hits;
}

async function hitsFromIndexedRoot(
  config: Extract<LoadedConfig, { ok: true }>,
  root: LoadedRoot,
  query: string,
  limit: number,
  b: Budget,
  signal?: AbortSignal,
  retried = false,
): Promise<SearchHit[] | Fail> {
  if (!root.realPath) return [];
  const indexOpts = {
    sourcePath: root.realPath,
    sourceKey: pathKey(root.realPath),
    skipInside: skipInsidePaths(root.realPath, config.writable?.realPath, root.writable),
    exclude: root.exclude,
    signal,
    scanMs: 8000,
  };
  let found = await searchRootIndex(root.realPath, query, { limit });
  if (!found.ok) return found;
  if (!found.indexed) {
    const built = await indexRoot(indexOpts);
    if (built.ok) {
      b.skipped += built.skipped ?? 0;
      for (const reason of built.reasons ?? []) {
        if (b.reasons.length < 8 && !b.reasons.includes(reason)) b.reasons.push(reason);
      }
    }
    found = await searchRootIndex(root.realPath, query, { limit });
    if (!found.ok) return found;
  }
  if (!found.indexed) return [];
  const merged = new Map<string, SearchHit>();
  for (const row of found.hits) {
    const abs = join(root.realPath, row.relPath);
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      continue;
    }
    if (row.sourceHash && sha256(buf) !== row.sourceHash) continue;
    const text = buf.toString("utf8");
    const phrases = row.phrases ?? found.phrases ?? [];
    if (phrases.length) {
      const hay = foldSpace(`${text}\n${decodeEntities(text)}`).toLowerCase();
      if (!phrases.every((p) => hay.includes(p.toLowerCase()))) continue;
    }
    if ((row.kind === "digest" || row.kind === "derived") && row.sourcePath) {
      try {
        const src = await readFile(row.sourcePath);
        if (row.sourceFileHash && sha256(src) !== row.sourceFileHash) continue;
      } catch {
        continue;
      }
    }
    const needles = row.needles ?? [];
    const snippets = makeSnippets(text, needles, row.lines ?? []);
    const decodedLines = asLines(text).map((line) => decodeEntities(line));
    const preview = snippets.length ? undefined : clipAround(decodedLines.find((l) => l.trim()) ?? decodedLines[0] ?? "", needles[0] ?? "");
    const hit: SearchHit = {
      kind: row.kind === "digest" || row.kind === "lesson" || row.kind === "derived" ? row.kind : "original",
      root: root.name,
      path: abs,
      relPath: row.relPath,
      title: row.title,
      catalog: row.catalog,
      sourcePath: row.sourcePath,
      sourceStatus: row.kind === "digest" ? "unchanged" : undefined,
      pathHit: snippets.length === 0,
      snippets,
      preview,
      pathScore: row.score ?? 0,
      partial: row.partial || undefined,
    };
    const key = hit.kind === "lesson" ? `lesson:${pathKey(abs)}` : pathKey(hit.sourcePath ?? abs);
    const prev = merged.get(key);
    if (!prev) merged.set(key, hit);
    else {
      const rank: Record<string, number> = { digest: 3, derived: 2, original: 1, lesson: 0 };
      if ((rank[hit.kind] ?? 0) > (rank[prev.kind] ?? 0)) {
        prev.kind = hit.kind;
        prev.path = hit.path;
        prev.relPath = hit.relPath;
        prev.sourcePath = hit.sourcePath ?? prev.path;
        prev.sourceStatus = hit.sourceStatus ?? prev.sourceStatus;
      }
      prev.pathScore = Math.max(prev.pathScore, hit.pathScore);
      prev.partial = Boolean(prev.partial && hit.partial) || undefined;
      if (!prev.snippets.length && hit.snippets.length) prev.snippets = hit.snippets;
      if (hit.title && !prev.title) prev.title = hit.title;
    }
  }
  const out = [...merged.values()].sort((a, b) => b.pathScore - a.pathScore || a.path.localeCompare(b.path)).slice(0, limit);
  if (!out.length && found.hits.length && !retried) {
    await indexRoot(indexOpts);
    return hitsFromIndexedRoot(config, root, query, limit, b, signal, true);
  }
  return out;
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

  async function fallbackRoot(root: LoadedRoot): Promise<SearchHit[] | Fail> {
    const aiHits = root.writable ? await searchLayer(config, [root], [], terms, "ai", b) : [];
    const prepared = await prepareReadonlyRoot(config, root, { signal: opts.signal });
    if (!prepared.ok) return prepared;
    mergeSkip(b, prepared.snapshot);
    const origHits = hitsFromPrepared(prepared.snapshot, terms, root.name, await loadSemanticIndex(prepared.snapshot.sourcePath));
    return [...aiHits, ...origHits];
  }

  async function searchRoot(root: LoadedRoot): Promise<SearchHit[] | Fail> {
    const indexed = await hitsFromIndexedRoot(config, root, query, limit, b, opts.signal);
    if (!Array.isArray(indexed)) return indexed;
    const top = root.realPath ? await readTopManifest(root.realPath) : undefined;
    const hits = indexed.length ? indexed : (top?.current ? indexed : await fallbackRoot(root));
    if (!Array.isArray(hits)) return hits;
    if (root.realPath) {
      const semantic = await semanticHits(root, terms, query);
      return mergeHits([...hits, ...semantic]);
    }
    return hits;
  }

  if (opts.root) {
    const root = config.roots.find((r) => r.name === opts.root);
    if (!root) return { ok: false, error: `未知 root: ${opts.root}` };
    if (!root.exists) {
      if (root.writable) {
        return { ok: true, hits: [], originalsSearched: true, truncated: false, skipped: 0, skipReasons: [] };
      }
      return { ok: false, error: `root 目录不存在: ${root.name} (${root.path})` };
    }
    const hits = await searchRoot(root);
    if (!Array.isArray(hits)) return hits;
    return {
      ok: true,
      hits: hits.slice(0, limit),
      originalsSearched: true,
      truncated: b.truncated,
      skipped: b.skipped,
      skipReasons: b.reasons,
    };
  }

  const readonlyRoots = config.roots.filter((r) => !r.writable);
  const missing = readonlyRoots.filter((r) => !r.exists);
  if (missing.length && readonlyRoots.every((r) => !r.exists) && !writable?.exists) {
    return { ok: false, error: `只读 root 不存在: ${missing.map((r) => r.name).join(", ")}` };
  }
  const hits: SearchHit[] = [];
  for (const root of config.roots.filter((r) => r.exists)) {
    const part = await searchRoot(root);
    if (!Array.isArray(part)) return part;
    hits.push(...part);
  }
  const merged = mergeHits(hits);
  return {
    ok: true,
    hits: merged.slice(0, limit),
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
    if (hit.title) lines.push(`标题: ${hit.title}${hit.catalog?.length ? `  ${hit.catalog.join(" / ")}` : ""}`);
    lines.push(hit.path);
    if (hit.sourcePath) lines.push(`来源: ${hit.sourcePath}`);
    if (hit.pathHit) lines.push(`文件名/路径命中${hit.preview ? `: ${hit.preview}` : ""}`);
    if (hit.partial) lines.push("部分匹配");
    if (hit.semanticMatch) lines.push(`语义索引匹配${hit.semanticEvidence ? `: ${hit.semanticEvidence}` : ""}`);
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
  const published = await publishFile(dirReal, fileName, formatNote(meta, input.title.trim(), input.body), "lesson", "retry");
  if (published.ok && config.ok) await refreshWritableIndex(config);
  return published;
}

async function refreshWritableIndex(config: Extract<LoadedConfig, { ok: true }>): Promise<void> {
  const root = config.writable;
  if (!root?.realPath) return;
  await indexRoot({
    sourcePath: root.realPath,
    sourceKey: pathKey(root.realPath),
    skipInside: skipInsidePaths(root.realPath, root.realPath, true),
    exclude: root.exclude,
  });
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
  if (published.ok && config.ok) await refreshWritableIndex(config);
  return published;
}

export async function formatStatus(config: LoadedConfig): Promise<string> {
  const lines = [`配置: ${config.configPath}`];
  if (!config.ok) {
    lines.push(`状态: 不可用 — ${config.error}`);
    lines.push("策略: 未宣称知识库可用");
    return lines.join("\n");
  }
  lines.push("策略: 联合检索原文与 AI 笔记；完整读原文后可整理；不改原笔记");
  lines.push(`格式: ${[...TEXT_EXTS].join(" ")}`);
  if (config.enrich) lines.push(`清洗模型: ${config.enrich.provider}/${config.enrich.model}`);
  else lines.push("清洗模型: 未配置（导入时可选择）");
  const jobs = await loadJobSummaries(config);
  for (const root of config.roots) {
    const rw = root.writable ? "可写" : "只读";
    const ex = root.exclude.length ? ` exclude=${root.exclude.join("|")}` : "";
    let avail = root.exists ? root.realPath ?? root.path : root.writable ? "首次记录时创建" : "缺失";
    lines.push(`- ${root.name} (${rw}) ${root.path} [${avail}]${ex}`);
    const job = jobs.get(root.name);
    if (job) lines.push(`  ${job}`);
    if (root.realPath) {
      const top = await readTopManifest(root.realPath);
      if (top) {
        const gen = await readGeneration(root.realPath, top.current);
        const state = gen?.complete === false ? "建立中" : "就绪";
        lines.push(`  索引: ${state} 世代 ${top.current} 文档 ${gen?.docCount ?? "?"}`);
      } else {
        lines.push("  索引: 未建立");
      }
    }
  }
  return lines.join("\n");
}

async function loadJobSummaries(config: Extract<LoadedConfig, { ok: true }>): Promise<Map<string, string>> {
  const { loadJob, jobSummary } = await import("./semantic.ts");
  const out = new Map<string, string>();
  for (const root of config.roots) {
    if (!root.realPath) continue;
    const job = await loadJob(root.realPath);
    if (job) out.set(root.name, jobSummary(job));
  }
  return out;
}

export type RootChange =
  | { op: "add"; name: string; path: string; writable?: boolean }
  | { op: "remove"; name: string }
  | { op: "setWritable"; name: string };

export type KbUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(text: string, level?: "info" | "warning" | "error"): void;
};

export type EnrichHooks = {
  resolveModel(current?: EnrichSettings): Promise<EnrichSettings | Fail | undefined>;
  start(config: Extract<LoadedConfig, { ok: true }>, rootName: string): Promise<string>;
  pause?(rootName: string): Promise<string>;
};

export function snapshotRoots(config: LoadedConfig): RootInput[] {
  if (!config.ok) return [];
  return config.roots.map((r) => ({
    name: r.name,
    path: r.configuredPath,
    writable: r.writable,
    exclude: [...r.exclude],
  }));
}

export function applyRootChange(roots: RootInput[], change: RootChange): { ok: true; roots: RootInput[] } | Fail {
  const next = roots.map((r) => ({ ...r, exclude: r.exclude ?? [] }));
  if (change.op === "add") {
    const name = change.name.trim();
    const path = change.path.trim();
    if (change.writable) {
      for (const r of next) r.writable = false;
    }
    next.push({ name, path, writable: change.writable === true, exclude: [] });
  } else if (change.op === "remove") {
    const i = next.findIndex((r) => r.name === change.name);
    if (i < 0) return { ok: false, error: `没有这个目录: ${change.name}` };
    next.splice(i, 1);
  } else {
    const t = next.find((r) => r.name === change.name);
    if (!t) return { ok: false, error: `没有这个目录: ${change.name}` };
    for (const r of next) r.writable = r.name === change.name;
  }
  const parsed = parseConfigJson({ roots: next });
  if (!parsed.ok) return parsed;
  return { ok: true, roots: parsed.roots };
}

export async function saveConfigFile(
  configPath: string,
  roots: RootInput[],
  home = homedir(),
  enrich?: EnrichSettings | null,
): Promise<LoadedConfig> {
  let nextEnrich = enrich;
  if (nextEnrich === undefined) {
    const existing = await loadConfigFile(configPath, home);
    if (existing.ok) nextEnrich = existing.enrich;
  } else if (nextEnrich === null) {
    nextEnrich = undefined;
  }
  const spec = parseConfigJson({ roots, enrich: nextEnrich });
  if (!spec.ok) return { ok: false, configPath, error: spec.error };
  const payload: { roots: RootInput[]; enrich?: EnrichSettings } = {
    roots: spec.roots.map((r) => {
      const o: RootInput = {
        name: r.name,
        path: r.path,
      };
      if (r.writable) o.writable = true;
      if (r.exclude.length) o.exclude = r.exclude;
      return o;
    }),
  };
  if (spec.enrich) payload.enrich = spec.enrich;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = join(dirname(configPath), `.pi-kb-${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, body, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, configPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, configPath, error: `无法写入配置: ${code ?? "unknown"}` };
  }
  return loadConfigFile(configPath, home);
}

function scheduleIndex(
  config: Extract<LoadedConfig, { ok: true }>,
  root: LoadedRoot,
  mode: "meta" | "full" = "meta",
): void {
  if (!root.realPath) return;
  void indexRoot({
    sourcePath: root.realPath,
    sourceKey: pathKey(root.realPath),
    skipInside: skipInsidePaths(root.realPath, config.writable?.realPath, root.writable),
    exclude: root.exclude,
    mode,
  });
}

async function afterAddReadonly(
  config: Extract<LoadedConfig, { ok: true }>,
  name: string,
  ui: KbUi,
  hooks: EnrichHooks | undefined,
  configPath: string,
  home: string,
): Promise<LoadedConfig> {
  const root = config.roots.find((r) => r.name === name);
  if (!root) return config;
  if (!root.exists) {
    ui.notify(`目录已保存，但路径不存在: ${root.path}`, "warning");
    return config;
  }
  ui.notify(`正在处理 ${name}…`);
  const prepared = await prepareReadonlyRoot(config, root);
  if (!prepared.ok) {
    ui.notify(`目录已保存，资料生成失败: ${prepared.error}`, "error");
    return config;
  }
  const extra = prepared.persistError ? `；${prepared.persistError}` : "";
  ui.notify(`规则清洗完成：${prepared.processed} 篇${extra}`);
  scheduleIndex(config, root);
  if (!hooks) return config;
  const useAi = await ui.confirm("使用 AI 全量语义整理？", `${name} 共 ${prepared.processed} 篇。仅规则清洗也可搜索。`);
  if (!useAi) return config;
  const model = await hooks.resolveModel(config.enrich);
  if (!model) return config;
  if ("ok" in model) {
    ui.notify(model.error, "error");
    return config;
  }
  const saved = await saveConfigFile(configPath, snapshotRoots(config), home, model);
  if (!saved.ok) {
    ui.notify(saved.error, "error");
    return config;
  }
  ui.notify(await hooks.start(saved, name));
  return saved;
}

export async function configureKbInteractive(
  configPath: string,
  ui: KbUi,
  home = homedir(),
  hooks?: EnrichHooks,
): Promise<LoadedConfig> {
  let config = await loadConfigFile(configPath, home);
  if (!config.ok && !config.error.includes("不存在")) {
    const overwrite = await ui.confirm("覆盖损坏的配置？", config.error);
    if (!overwrite) {
      ui.notify(await formatStatus(config), "error");
      return config;
    }
  }
  for (;;) {
    const roots = snapshotRoots(config);
    const options = ["完成", "添加目录"];
    if (roots.length) options.push("删除目录", "设为记录目录", "刷新资料", "AI 整理", "暂停 AI");
    const choice = await ui.select(await formatStatus(config), options);
    if (!choice || choice === "完成") {
      ui.notify(await formatStatus(config));
      return config;
    }
    if (choice === "刷新资料" || choice === "AI 整理" || choice === "暂停 AI") {
      if (!config.ok) continue;
      const names = config.roots.map((r) => r.name);
      if (choice === "刷新资料") {
        const name = await ui.select("刷新哪个目录？", names);
        if (!name) continue;
        const root = config.roots.find((r) => r.name === name);
        if (!root) continue;
        const prepared = await prepareReadonlyRoot(config, root);
        if (prepared.ok) scheduleIndex(config, root, "full");
        ui.notify(prepared.ok ? `已刷新 ${name}：${prepared.processed} 篇 ${prepared.status}` : prepared.error, prepared.ok ? "info" : "error");
        continue;
      }
      if (choice === "AI 整理") {
        if (!hooks) {
          ui.notify("当前环境不能调用清洗模型", "error");
          continue;
        }
        const name = await ui.select("整理哪个目录？", names);
        if (!name) continue;
        const model = await hooks.resolveModel(config.enrich);
        if (!model) continue;
        if ("ok" in model) {
          ui.notify(model.error, "error");
          continue;
        }
        const savedModel = await saveConfigFile(configPath, snapshotRoots(config), home, model);
        if (!savedModel.ok) {
          ui.notify(savedModel.error, "error");
          continue;
        }
        config = savedModel;
        ui.notify(await hooks.start(savedModel, name));
        return savedModel;
      }
      const name = await ui.select("暂停哪个目录？", names);
      if (!name) continue;
      ui.notify(hooks?.pause ? await hooks.pause(name) : "没有进行中的任务");
      continue;
    }
    let change: RootChange | undefined;
    if (choice === "添加目录") {
      const name = (await ui.input("目录名称", roots.length ? "agent" : "obsidian"))?.trim();
      if (!name) continue;
      const path = (await ui.input("绝对路径或 ~/", "~/"))?.trim();
      if (!path) continue;
      let writable = false;
      if (!roots.some((r) => r.writable)) {
        writable = await ui.confirm("作为记录目录？", "kb_write 会写入此目录下的 digests/ 和 lessons/");
      }
      change = { op: "add", name, path, writable };
    } else if (choice === "删除目录") {
      const name = await ui.select("删除哪个目录？", roots.map((r) => r.name));
      if (!name) continue;
      if (!await ui.confirm("删除这个目录配置？", name)) continue;
      change = { op: "remove", name };
    } else if (choice === "设为记录目录") {
      const name = await ui.select("哪个目录用于写入？", roots.map((r) => r.name));
      if (!name) continue;
      change = { op: "setWritable", name };
    } else {
      continue;
    }
    const applied = applyRootChange(roots, change);
    if (!applied.ok) {
      ui.notify(applied.error, "error");
      continue;
    }
    const saved = await saveConfigFile(configPath, applied.roots, home);
    config = saved;
    ui.notify(saved.ok ? "已保存" : saved.error, saved.ok ? "info" : "error");
    if (saved.ok && change.op === "add") {
      config = await afterAddReadonly(saved, change.name, ui, hooks, configPath, home);
    }
  }
}

export function isOriginalTextFile(config: Extract<LoadedConfig, { ok: true }>, realPath: string): boolean {
  if (!TEXT_EXTS.has(extname(realPath).toLowerCase())) return false;
  const owner = mostSpecificRoot(realPath, config.roots);
  if (owner && pathInside(realPath, cacheDirFor(owner.realPath ?? owner.path))) return false;
  if (config.writable?.realPath && pathInside(realPath, config.writable.realPath)) return false;
  if (!owner) return false;
  if (coveredAndExcluded(realPath, config.roots)) return false;
  return true;
}


async function migrateLegacyCache(configPath: string, sourcePath: string): Promise<void> {
  const destDir = cacheDirFor(sourcePath);
  const destSnap = join(destDir, "snapshot.json");
  try {
    await access(destSnap, constants.F_OK);
    return;
  } catch {
    /* missing */
  }
  const hash = sha256(pathKey(sourcePath));
  const oldDir = join(dirname(resolve(configPath)), LEGACY_CACHE_DIRNAME);
  const mapping: [string, string][] = [
    [`${hash}.json`, "snapshot.json"],
    [`job-${hash}.json`, "job.json"],
    [`sem-${hash}.json`, "sem.json"],
  ];
  let found = false;
  for (const [from] of mapping) {
    try {
      await access(join(oldDir, from), constants.F_OK);
      found = true;
      break;
    } catch {
      /* skip */
    }
  }
  if (!found) return;
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  for (const [from, to] of mapping) {
    try {
      await copyFile(join(oldDir, from), join(destDir, to), constants.COPYFILE_EXCL);
    } catch {
      /* skip */
    }
  }
}


function isPreparedDoc(raw: unknown): raw is PreparedDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  return typeof rec.path === "string"
    && typeof rec.relPath === "string"
    && typeof rec.title === "string"
    && Array.isArray(rec.catalog) && rec.catalog.every((x) => typeof x === "string")
    && typeof rec.sourceHash === "string"
    && Array.isArray(rec.lines) && rec.lines.every((x) => typeof x === "string");
}

export function parsePreparedSnapshot(raw: unknown): PreparedSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== RULE_VERSION) return null;
  if (typeof rec.sourceName !== "string" || typeof rec.sourcePath !== "string" || typeof rec.sourceKey !== "string") return null;
  if (!Array.isArray(rec.exclude) || rec.exclude.some((x) => typeof x !== "string")) return null;
  if (typeof rec.metaFingerprint !== "string" || typeof rec.preparedAt !== "string") return null;
  if (!Array.isArray(rec.docs) || rec.docs.some((d) => !isPreparedDoc(d))) return null;
  if (typeof rec.skipped !== "number" || typeof rec.truncated !== "boolean") return null;
  if (!Array.isArray(rec.skipReasons) || rec.skipReasons.some((x) => typeof x !== "string")) return null;
  return rec as PreparedSnapshot;
}

async function readSnapshotFile(path: string): Promise<PreparedSnapshot | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > SNAPSHOT_MAX) return null;
    const buf = await readFile(path);
    if (buf.includes(0)) return null;
    return parsePreparedSnapshot(JSON.parse(buf.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

async function publishSnapshot(path: string, snapshot: PreparedSnapshot): Promise<Fail | { ok: true }> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirSt = await lstat(dir);
  if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) return { ok: false, error: "生成资料目录无效" };
  const tmpPath = join(dir, `.pi-kb-cache-${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await chmod(tmpPath, 0o600);
    } catch {
      /* windows */
    }
    await rename(tmpPath, path);
    return { ok: true };
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, error: `无法写入生成资料: ${code ?? "unknown"}` };
  }
}

type ScannedFile = {
  realPath: string;
  relPath: string;
  dir: string;
  name: string;
  text: string;
  hash: string;
};

async function resolveMappedFile(
  dir: string,
  filename: string,
  root: LoadedRoot,
): Promise<string | undefined> {
  const abs = resolve(dir, filename);
  const base = root.realPath;
  if (!base) return;
  try {
    const st = await lstat(abs);
    if (!st.isFile() || st.isSymbolicLink()) return;
    const real = await realpath(abs);
    if (!pathInside(real, base) && !samePath(real, base)) return;
    if (coveredAndExcluded(real, [root])) return;
    return real;
  } catch {
    return;
  }
}

async function showDocMaps(
  files: ScannedFile[],
  root: LoadedRoot,
  b: Budget,
): Promise<{ fileToTitle: Map<string, string>; titleToCatalog: Map<string, string[]>; skipMeta: Set<string> }> {
  const fileToTitle = new Map<string, string>();
  const titleToCatalog = new Map<string, string[]>();
  const skipMeta = new Set<string>();
  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const key = pathKey(file.dir);
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    for (const file of group) {
      if (/_readme\.md$/i.test(file.name)) {
        const parsed = parseShowDocReadme(file.text);
        if (parsed.size === 0) continue;
        let used = 0;
        for (const [name, title] of parsed) {
          const real = await resolveMappedFile(file.dir, name, root);
          if (!real) {
            skip(b, "showdoc-out-of-scope");
            continue;
          }
          const prev = fileToTitle.get(pathKey(real));
          if (prev && prev !== title) {
            fileToTitle.delete(pathKey(real));
            skip(b, "showdoc-dup-title");
            continue;
          }
          fileToTitle.set(pathKey(real), title);
          used += 1;
        }
        if (used > 0) skipMeta.add(pathKey(file.realPath));
      } else if (/_info\.json$/i.test(file.name)) {
        let raw: unknown;
        try {
          raw = JSON.parse(file.text) as unknown;
        } catch {
          skip(b, "showdoc-info-invalid");
          continue;
        }
        const catalogs = parseShowDocInfo(raw);
        if (!catalogs) {
          skip(b, "showdoc-info-invalid");
          continue;
        }
        for (const [title, catalog] of catalogs) {
          const prev = titleToCatalog.get(title);
          if (prev && prev.join("/") !== catalog.join("/")) {
            titleToCatalog.delete(title);
            skip(b, "showdoc-dup-title");
            continue;
          }
          titleToCatalog.set(title, catalog);
        }
        skipMeta.add(pathKey(file.realPath));
      }
    }
  }
  return { fileToTitle, titleToCatalog, skipMeta };
}

function snapshotFingerprint(snapshot: Pick<PreparedSnapshot, "sourceKey" | "exclude" | "metaFingerprint" | "docs">): string {
  const docs = snapshot.docs.map((d) => `${pathKey(d.path)}:${d.sourceHash}`).sort();
  return sha256(JSON.stringify({
    version: RULE_VERSION,
    sourceKey: snapshot.sourceKey,
    exclude: snapshot.exclude,
    metaFingerprint: snapshot.metaFingerprint,
    docs,
  }));
}

export function skipInsideForPrepare(config: Extract<LoadedConfig, { ok: true }>, root: LoadedRoot): string[] {
  const skip: string[] = [];
  if (root.realPath) skip.push(cacheDirFor(root.realPath));
  const w = config.writable?.realPath;
  if (!w) return skip;
  if (root.writable || (root.realPath && samePath(root.realPath, w))) {
    skip.push(join(w, "digests"), join(w, "lessons"));
  } else {
    skip.push(w);
  }
  return skip;
}

export async function prepareReadonlyRoot(
  config: LoadedConfig,
  root: LoadedRoot,
  opts: { signal?: AbortSignal; now?: Date } = {},
): Promise<PrepareOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  if (!root.exists || !root.realPath) return { ok: false, error: `root 目录不存在: ${root.name} (${root.path})` };

  const b = newBudget(opts.signal);
  const skipInside = skipInsideForPrepare(config, root);
  await migrateLegacyCache(config.configPath, root.realPath);

  const files: ScannedFile[] = [];
  await walkFiles(root, skipInside, b, async (realPath, relPath) => {
    const got = await readUtf8Limited(realPath, b);
    if (!got) return;
    files.push({
      realPath,
      relPath: relPath.replaceAll("\\", "/"),
      dir: dirname(realPath),
      name: basename(realPath),
      text: got.text,
      hash: sha256(got.buf),
    });
  });

  const maps = await showDocMaps(files, root, b);
  const docs: PreparedDoc[] = [];
  for (const file of files) {
    const key = pathKey(file.realPath);
    if (maps.skipMeta.has(key)) continue;
    const mappedTitle = maps.fileToTitle.get(key);
    const title = (mappedTitle ?? extractNoteTitle(file.text) ?? basename(file.realPath, extname(file.realPath))).slice(0, TITLE_MAX);
    const catalog = maps.titleToCatalog.get(title) ?? [];
    docs.push({
      path: file.realPath,
      relPath: file.relPath,
      title,
      catalog,
      sourceHash: file.hash,
      lines: normalizeNoteLines(file.text),
    });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));

  const metaFingerprint = sha256(JSON.stringify({
    titles: [...maps.fileToTitle.entries()].sort(),
    catalogs: [...maps.titleToCatalog.entries()].sort(),
    skipMeta: [...maps.skipMeta].sort(),
  }));
  const snapshot: PreparedSnapshot = {
    version: RULE_VERSION,
    sourceName: root.name,
    sourcePath: root.realPath,
    sourceKey: pathKey(root.realPath),
    exclude: [...root.exclude],
    metaFingerprint,
    docs,
    skipped: b.skipped,
    skipReasons: b.reasons,
    truncated: b.truncated,
    preparedAt: (opts.now ?? new Date()).toISOString(),
  };

  const dest = sourceCachePath(root.realPath);
  const previous = await readSnapshotFile(dest);
  const prevFp = previous ? snapshotFingerprint(previous) : "";
  const nextFp = snapshotFingerprint(snapshot);
  if (previous && prevFp === nextFp && !snapshot.truncated) {
    return {
      ok: true,
      snapshot: previous,
      status: "reused",
      path: dest,
      processed: previous.docs.length,
      updated: 0,
    };
  }

  const prevHash = new Map((previous?.docs ?? []).map((d) => [pathKey(d.path), d.sourceHash]));
  const updated = docs.filter((d) => prevHash.get(pathKey(d.path)) !== d.sourceHash).length;

  let persistError: string | undefined;
  let status: PrepareOk["status"] = previous ? "updated" : "created";
  let path: string | undefined = dest;
  if (snapshot.truncated) {
    persistError = previous && !previous.truncated ? "扫描未完成，未覆盖完整快照" : "扫描未完成";
    status = "memory_only";
    path = undefined;
  } else {
    const published = await publishSnapshot(dest, snapshot);
    if (!published.ok) {
      persistError = published.error;
      status = "memory_only";
      path = undefined;
    }
  }

  return {
    ok: true,
    snapshot,
    status,
    path,
    processed: docs.length,
    updated,
    persistError,
  };
}
