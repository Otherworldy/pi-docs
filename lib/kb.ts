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
import { listDocs, readGeneration, readTopManifest } from "./index-store.mjs";
import { searchRootIndex } from "./retrieval.mjs";
import {
  CONFIG_VERSION,
  RESERVED_PROJECT_IDS,
  findBindingConflicts,
  findWorkspaceConflicts,
  matchWorkspace,
  ownershipForDoc,
  parseIsolationFields,
  parseScope,
  scopeToJson,
  visibleInQuery,
} from "./scope.mjs";

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
export const PLUGIN_OFF = "知识库插件已关闭。用 /kb 开启。";
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
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 32;

export type RootInput = {
  name: string;
  path: string;
  writable?: boolean;
  exclude?: string[];
};

export type Scope =
  | { kind: "shared" }
  | { kind: "unassigned" }
  | { kind: "projects"; projects: string[] };

export type ProjectInput = {
  id: string;
  name: string;
  workspaces: string[];
};

export type BindingInput = {
  root: string;
  path: string;
  scope: Scope;
};

export type LoadedWorkspace = {
  configuredPath: string;
  path: string;
  realPath?: string;
  exists: boolean;
};

export type LoadedProject = {
  id: string;
  name: string;
  workspaces: LoadedWorkspace[];
};

export type LoadedBinding = {
  root: string;
  path: string;
  scope: Scope;
};

export type EnrichSettings = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  concurrency?: number;
};

export type ConfigSpec = {
  isolation: boolean;
  enabled: boolean;
  roots: RootInput[];
  projects: ProjectInput[];
  bindings: BindingInput[];
  enrich?: EnrichSettings;
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
  isolation: boolean;
  enabled: boolean;
  roots: LoadedRoot[];
  projects: LoadedProject[];
  bindings: LoadedBinding[];
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
  fp?: string;
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
  scopeKind?: "shared" | "unassigned" | "projects";
  projects?: string[];
  scope?: Scope;
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
  const concurrency = rec.concurrency === undefined ? undefined : rec.concurrency;
  if (concurrency !== undefined && (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)) {
    return { ok: false, error: "enrich.concurrency 无效" };
  }
  return {
    provider: rec.provider.trim(),
    model: rec.model.trim(),
    maxOutputTokens,
    timeoutMs,
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
}

export function parseConfigJson(raw: unknown): ({ ok: true } & ConfigSpec) | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "配置必须是对象" };
  const rec = raw as Record<string, unknown>;
  const roots = rec.roots;
  if (!Array.isArray(roots)) return { ok: false, error: "缺少 roots 数组" };
  const names = new Set<string>();
  let writable = 0;
  const out: RootInput[] = [];
  for (const item of roots) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "root 必须是对象" };
    const root = item as Record<string, unknown>;
    if (typeof root.name !== "string" || !root.name.trim()) return { ok: false, error: "root.name 不能为空" };
    if (typeof root.path !== "string" || !root.path.trim()) return { ok: false, error: "root.path 不能为空" };
    if (names.has(root.name)) return { ok: false, error: `重复的 root 名: ${root.name}` };
    names.add(root.name);
    const isWritable = root.writable === true;
    if (isWritable) writable += 1;
    if (writable > 1) return { ok: false, error: "初版只允许一个可写 root" };
    if (root.exclude !== undefined) {
      if (!Array.isArray(root.exclude) || root.exclude.some((x) => typeof x !== "string")) {
        return { ok: false, error: "exclude 必须是字符串数组" };
      }
    }
    const path = root.path.trim();
    if (!path.startsWith("~") && !isAbsolute(path)) return { ok: false, error: `root.path 必须是绝对路径或 ~/：${root.name}` };
    out.push({
      name: root.name.trim(),
      path,
      writable: isWritable,
      exclude: (root.exclude as string[] | undefined) ?? [],
    });
  }
  if (rec.enabled !== undefined && typeof rec.enabled !== "boolean") {
    return { ok: false, error: "enabled 必须是布尔值" };
  }
  const enabled = rec.enabled !== false;
  const enrich = parseEnrichSettings(rec.enrich);
  if (enrich && "ok" in enrich) return enrich;
  if (rec.version === undefined) {
    if (rec.projects !== undefined || rec.bindings !== undefined) {
      return { ok: false, error: "projects/bindings 需要 version: 2" };
    }
    return { ok: true, isolation: false, enabled, roots: out, projects: [], bindings: [], enrich };
  }
  const iso = parseIsolationFields(rec, names);
  if (!iso.ok) return iso;
  return {
    ok: true,
    isolation: true,
    enabled,
    roots: out,
    projects: iso.projects,
    bindings: iso.bindings,
    enrich,
  };
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
  const projects: LoadedProject[] = [];
  for (const item of spec.projects) {
    const workspaces: LoadedWorkspace[] = [];
    for (const ws of item.workspaces) {
      const expanded = resolve(expandUserPath(ws, home));
      const loaded: LoadedWorkspace = {
        configuredPath: ws,
        path: expanded,
        exists: false,
      };
      try {
        const st = await lstat(expanded);
        if (st.isSymbolicLink() || st.isDirectory()) {
          loaded.realPath = await realpath(expanded);
          loaded.exists = true;
        }
      } catch {
        loaded.exists = false;
      }
      workspaces.push(loaded);
    }
    projects.push({ id: item.id, name: item.name, workspaces });
  }
  if (spec.isolation) {
    const wsConflict = findWorkspaceConflicts(projects);
    if (wsConflict) return { ok: false, configPath, error: wsConflict };
    const bindConflict = findBindingConflicts(roots, spec.bindings);
    if (bindConflict) return { ok: false, configPath, error: bindConflict };
  }
  return {
    ok: true,
    configPath,
    isolation: spec.isolation,
    enabled: spec.enabled,
    roots,
    projects,
    bindings: spec.bindings,
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
  scope?: Scope;
};

type AllowDoc = (file: string, doc?: { kind?: SearchHit["kind"]; sourcePath?: string; scope?: Scope }) => boolean;

const allowAll: AllowDoc = () => true;

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
    } else if (raw.scope !== undefined) {
      const parsed = parseScope(raw.scope);
      if (parsed.ok) meta.scope = parsed.scope;
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
  if (isAiOutputFile(config, sourceReal)) {
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

function isAiOutputFile(config: Extract<LoadedConfig, { ok: true }>, realPath: string): boolean {
  const w = config.writable?.realPath;
  if (!w || !pathInside(realPath, w)) return false;
  return isAiNoteRel(relative(w, realPath));
}

async function searchLayer(
  config: Extract<LoadedConfig, { ok: true }>,
  roots: LoadedRoot[],
  skipInside: string[],
  terms: string[],
  kindHint: "ai" | "original",
  b: Budget,
  allow: AllowDoc = allowAll,
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
      let noteScope: Scope | undefined;
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
          noteScope = meta.scope;
        } else {
          kind = "lesson";
        }
      }
      if (!allow(realPath, { kind, sourcePath, scope: noteScope })) return;
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
        scope: noteScope,
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

function hitsFromPrepared(snapshot: PreparedSnapshot, terms: string[], rootName: string, records: SemanticIndex[] = [], allow: AllowDoc = allowAll): SearchHit[] {
  const byPath = new Map(records.map((r) => [pathKey(r.path), r]));
  const hits: SearchHit[] = [];
  for (const doc of snapshot.docs) {
    if (!allow(doc.path, { kind: "original" })) continue;
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

async function semanticHits(root: LoadedRoot, terms: string[], allow: AllowDoc = allowAll): Promise<SearchHit[]> {
  if (!root.realPath) return [];
  const recs = await loadSemanticIndex(root.realPath);
  const hits: SearchHit[] = [];
  for (const rec of recs) {
    if (!allow(rec.path, { kind: "original" })) continue;
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
  allow: AllowDoc = allowAll,
  isolation = false,
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
  const indexQuery: { limit: number; visibleIds?: Set<string>; generation?: number } = { limit };
  async function scopedQuery() {
    if (!isolation || !root.realPath) return indexQuery;
    const listed = await listDocs(root.realPath);
    if (!listed.ok) return listed;
    const ids = new Set<string>();
    for (const [id, doc] of listed.docs) {
      if (allow(join(root.realPath, doc.relPath), doc)) ids.add(id);
    }
    return { limit, visibleIds: ids, generation: listed.generation };
  }
  let queryOpts = await scopedQuery();
  if ("ok" in queryOpts && queryOpts.ok === false) return queryOpts;
  let found = await searchRootIndex(root.realPath, query, queryOpts);
  if (!found.ok) return found;
  if (!found.indexed) {
    const built = await indexRoot(indexOpts);
    if (built.ok) {
      b.skipped += built.skipped ?? 0;
      for (const reason of built.reasons ?? []) {
        if (b.reasons.length < 8 && !b.reasons.includes(reason)) b.reasons.push(reason);
      }
    }
    queryOpts = await scopedQuery();
    if ("ok" in queryOpts && queryOpts.ok === false) return queryOpts;
    found = await searchRootIndex(root.realPath, query, queryOpts);
    if (!found.ok) return found;
  }
  if (!found.indexed) return [];
  const merged = new Map<string, SearchHit>();
  for (const row of found.hits) {
    const abs = join(root.realPath, row.relPath);
    const kind = row.kind === "digest" || row.kind === "lesson" || row.kind === "derived" ? row.kind : "original";
    if (!allow(abs, { kind, sourcePath: row.sourcePath, scope: row.scope })) continue;
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
      scope: row.scope,
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
    return hitsFromIndexedRoot(config, root, query, limit, b, signal, true, allow, isolation);
  }
  return out;
}

export async function searchKb(
  config: LoadedConfig,
  query: string,
  opts: { root?: string; limit?: number; signal?: AbortSignal; projectIds?: string[] } = {},
): Promise<SearchOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.enabled) return { ok: false, error: PLUGIN_OFF };
  const terms = tokenizeQuery(query);
  if (!Array.isArray(terms)) return terms;
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const b = newBudget(opts.signal);
  const writable = config.writable;
  const scope = { isolation: config.isolation, projectIds: opts.projectIds ?? [] };
  const allow: AllowDoc = (file, doc) => {
    if (!scope.isolation) return true;
    return visibleInQuery(ownershipForDoc(file, config.roots, config.bindings, doc), scope);
  };

  function tagHits(hits: SearchHit[]): SearchHit[] {
    if (!scope.isolation) return hits;
    for (const hit of hits) {
      const file = (hit.kind === "digest" || hit.kind === "derived") ? (hit.sourcePath ?? hit.path) : hit.path;
      const own = ownershipForDoc(file, config.roots, config.bindings, { kind: hit.kind, sourcePath: hit.sourcePath, scope: hit.scope });
      hit.scopeKind = own.kind;
      if (own.projects.length) hit.projects = own.projects;
    }
    return hits;
  }

  async function fallbackRoot(root: LoadedRoot): Promise<SearchHit[] | Fail> {
    const aiHits = root.writable ? await searchLayer(config, [root], [], terms, "ai", b, allow) : [];
    const prepared = await prepareReadonlyRoot(config, root, { signal: opts.signal });
    if (!prepared.ok) return prepared;
    mergeSkip(b, prepared.snapshot);
    const origHits = hitsFromPrepared(prepared.snapshot, terms, root.name, await loadSemanticIndex(prepared.snapshot.sourcePath), allow);
    return [...aiHits, ...origHits];
  }

  async function searchRoot(root: LoadedRoot): Promise<SearchHit[] | Fail> {
    const indexed = await hitsFromIndexedRoot(config, root, query, limit, b, opts.signal, false, allow, scope.isolation);
    if (!Array.isArray(indexed)) return indexed;
    const top = root.realPath ? await readTopManifest(root.realPath) : undefined;
    const hits = indexed.length ? indexed : (top?.current ? indexed : await fallbackRoot(root));
    if (!Array.isArray(hits)) return hits;
    if (root.realPath) {
      const semantic = await semanticHits(root, terms, allow);
      return tagHits(mergeHits([...hits, ...semantic]));
    }
    return tagHits(hits);
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
    if (hit.scopeKind === "shared") lines.push("归属: 共享");
    else if (hit.scopeKind === "projects" && hit.projects?.length) lines.push(`归属: ${hit.projects.join(", ")}`);
    else if (hit.scopeKind === "unassigned") lines.push("归属: 未分类");
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

export function inQueryScope(
  config: Extract<LoadedConfig, { ok: true }>,
  file: string,
  projectIds: string[] = [],
  doc?: { kind?: SearchHit["kind"]; sourcePath?: string; scope?: Scope },
): boolean {
  if (!config.isolation) return true;
  return visibleInQuery(ownershipForDoc(file, config.roots, config.bindings, doc), {
    isolation: true,
    projectIds,
  });
}

function rootUsable(config: Extract<LoadedConfig, { ok: true }>, name: string): boolean {
  const root = config.roots.find((r) => r.name === name);
  return !!(root && (root.exists || root.writable));
}

export function hasProjectDocs(
  config: LoadedConfig,
  projectIds: string[] = [],
  opts: { includeShared?: boolean } = {},
): boolean {
  if (!config.ok || !config.enabled) return false;
  if (!config.isolation) return config.roots.some((r) => r.exists || r.writable);
  if (opts.includeShared && config.bindings.some((b) => b.scope.kind === "shared" && rootUsable(config, b.root))) {
    return true;
  }
  const ids = new Set(projectIds);
  if (!ids.size) return false;
  return config.bindings.some((b) => {
    if (b.scope.kind !== "projects") return false;
    if (!b.scope.projects.some((id) => ids.has(id))) return false;
    return rootUsable(config, b.root);
  });
}

export function scopeFingerprint(config: LoadedConfig, projectIds: string[] = []): string {
  if (!config.ok) return `err:${config.error}`;
  return JSON.stringify({
    i: config.isolation,
    p: projectIds,
    b: config.bindings,
    proj: config.projects.map((p) => p.id),
    ex: config.roots.map((r) => [r.name, r.exclude]),
  });
}

export async function writeLesson(
  config: LoadedConfig,
  input: { title: string; body: string; cwd: string; now?: Date; projectId?: string },
): Promise<WriteOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.enabled) return { ok: false, error: PLUGIN_OFF };
  if (!config.writable) return { ok: false, error: "未配置记录目录" };
  if (config.isolation && !input.projectId) return { ok: false, error: "未选择项目，无法记录经验" };
  const bad = validateTitleBody(input.title, input.body);
  if (bad) return bad;
  const dir = join(await ensureWritableDir(config.writable), "lessons");
  await mkdir(dir, { recursive: true });
  const dirReal = await realpath(dir);
  if (!pathInside(dirReal, config.writable.realPath!)) return { ok: false, error: "lessons 目录逃出可写 root" };
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const fileName = `${day}-${randomUUID()}.md`;
  const meta: Record<string, unknown> = {
    type: "lesson",
    createdAt: (input.now ?? new Date()).toISOString(),
    author: AUTHOR,
    cwd: input.cwd,
  };
  if (input.projectId) meta.scope = { projects: [input.projectId] };
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
  input: { title: string; body: string; cwd: string; ref: ReadRef; now?: Date; projectIds?: string[] },
): Promise<WriteOk | Fail> {
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.enabled) return { ok: false, error: PLUGIN_OFF };
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
  if (config.isolation && !inQueryScope(config, sourceReal, input.projectIds ?? [])) {
    return { ok: false, error: "来源不在当前允许范围内" };
  }
  if (isAiOutputFile(config, sourceReal)) {
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
  if (!config.enabled) {
    lines.push("状态: 已关闭");
    lines.push("策略: 不检索、不写入；用 /kb 开启");
  } else {
    lines.push("策略: 联合检索原文与 AI 笔记；完整读原文后可整理；不改原笔记");
  }
  lines.push(config.isolation ? `项目隔离: ${config.projects.length} 个项目` : "项目隔离: 未启用");
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
  | { op: "setWritable"; name: string; writable?: boolean };

export type KbSelectOption = string | { value: string; label?: string; description?: string };

export type KbUi = {
  select(title: string, options: KbSelectOption[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(text: string, level?: "info" | "warning" | "error"): void;
};

export type EnrichHooks = {
  resolveModel(current?: EnrichSettings, ui?: KbUi): Promise<EnrichSettings | Fail | undefined>;
  start(config: Extract<LoadedConfig, { ok: true }>, rootName: string, mode?: "full" | "incremental"): Promise<string>;
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

export type ProjectSession = {
  mode: "auto" | "id" | "shared";
  projectId?: string;
  extraIds: string[];
};

export function applyProjectArg(config: LoadedConfig, raw: string): ({ ok: true } & Pick<ProjectSession, "mode" | "projectId">) | Fail {
  const token = raw.trim();
  if (!token) return { ok: false, error: "缺少项目参数" };
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.isolation) return { ok: false, error: "未启用项目隔离" };
  if (token === "auto") return { ok: true, mode: "auto" };
  if (token === "shared") return { ok: true, mode: "shared" };
  if (!config.projects.some((p) => p.id === token)) return { ok: false, error: `没有这个项目: ${token}` };
  return { ok: true, mode: "id", projectId: token };
}

export function applyScopeArg(config: LoadedConfig, raw: string): { ok: true; extraIds: string[] } | Fail {
  const token = raw.trim();
  if (!token) return { ok: false, error: "缺少范围参数" };
  if (!config.ok) return { ok: false, error: config.error };
  if (!config.isolation) return { ok: false, error: "未启用项目隔离" };
  if (token === "current") return { ok: true, extraIds: [] };
  if (token === "all") return { ok: true, extraIds: ["*"] };
  const ids = token.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (id === "*" || id === "all" || id === "current") return { ok: false, error: `无效项目 id: ${id}` };
    if (!config.projects.some((p) => p.id === id)) return { ok: false, error: `没有这个项目: ${id}` };
  }
  return { ok: true, extraIds: ids };
}

export async function backupConfigFile(configPath: string): Promise<{ ok: true; path?: string; existed?: boolean } | Fail> {
  const dest = `${configPath}.bak`;
  try {
    await copyFile(configPath, dest, constants.COPYFILE_EXCL);
    return { ok: true, path: dest };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true };
    if (code === "EEXIST") return { ok: true, path: dest, existed: true };
    return { ok: false, error: `无法备份配置: ${code ?? "unknown"}` };
  }
}

function newProjectId(name: string, used: Set<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let id = slug && !RESERVED_PROJECT_IDS.has(slug) ? slug : `p-${randomUUID().slice(0, 8)}`;
  if (!used.has(id)) return id;
  return `p-${randomUUID().slice(0, 8)}`;
}

export function currentProjectId(config: LoadedConfig, cwd: string, session?: ProjectSession): string | undefined {
  if (!config.ok || !config.isolation) return;
  if (session?.mode === "id") return session.projectId;
  if (session?.mode === "shared") return;
  const matched = matchWorkspace(cwd, config.projects);
  return matched.ok ? matched.projectId : undefined;
}

async function bindDocumentToProject(
  config: LoadedConfig,
  rootName: string,
  workspacePath: string,
  configPath: string,
  home: string,
): Promise<{ iso: { projects: ProjectInput[]; bindings: BindingInput[] } } | Fail> {
  const ws = resolve(expandUserPath(workspacePath.trim(), home));
  if (!ws) return { ok: false, error: "项目地址不能为空" };
  const isolated = config.ok && config.isolation;
  if (!isolated) {
    const bak = await backupConfigFile(configPath);
    if (!bak.ok) return bak;
  }
  const iso = snapshotIsolation(config) ?? { projects: [], bindings: [] };
  let proj = iso.projects.find((p) => p.workspaces.some((w) => samePath(w, ws)));
  if (!proj) {
    const name = basename(ws) || "project";
    const id = newProjectId(name, new Set(iso.projects.map((p) => p.id)));
    proj = { id, name, workspaces: [ws] };
    iso.projects.push(proj);
  }
  const existing = iso.bindings.find((b) => b.root === rootName && b.path === ".");
  if (existing?.scope.kind === "projects") {
    if (!existing.scope.projects.includes(proj.id)) existing.scope.projects.push(proj.id);
  } else {
    iso.bindings = iso.bindings.filter((b) => !(b.root === rootName && b.path === "."));
    iso.bindings.push({ root: rootName, path: ".", scope: { kind: "projects", projects: [proj.id] } });
  }
  return { iso };
}

async function bindDocumentShared(
  config: LoadedConfig,
  rootName: string,
  configPath: string,
): Promise<{ iso: { projects: ProjectInput[]; bindings: BindingInput[] } } | Fail> {
  const isolated = config.ok && config.isolation;
  if (!isolated) {
    const bak = await backupConfigFile(configPath);
    if (!bak.ok) return bak;
  }
  const iso = snapshotIsolation(config) ?? { projects: [], bindings: [] };
  iso.bindings = iso.bindings.filter((b) => !(b.root === rootName && b.path === "."));
  iso.bindings.push({ root: rootName, path: ".", scope: { kind: "shared" } });
  return { iso };
}

export function snapshotIsolation(config: LoadedConfig): { projects: ProjectInput[]; bindings: BindingInput[] } | undefined {
  if (!config.ok || !config.isolation) return;
  return {
    projects: config.projects.map((p) => ({
      id: p.id,
      name: p.name,
      workspaces: p.workspaces.map((w) => w.configuredPath),
    })),
    bindings: config.bindings.map((b) => ({
      root: b.root,
      path: b.path,
      scope: b.scope,
    })),
  };
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
    if (change.writable === false) t.writable = false;
    else for (const r of next) r.writable = r.name === change.name;
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
  isolation?: { projects: ProjectInput[]; bindings: BindingInput[] } | null,
  enabled?: boolean,
): Promise<LoadedConfig> {
  let nextEnrich = enrich;
  let nextIso = isolation;
  let nextEnabled = enabled;
  if (nextEnrich === undefined || nextIso === undefined || nextEnabled === undefined) {
    const existing = await loadConfigFile(configPath, home);
    if (existing.ok) {
      if (nextEnrich === undefined) nextEnrich = existing.enrich;
      if (nextIso === undefined) nextIso = snapshotIsolation(existing) ?? null;
      if (nextEnabled === undefined) nextEnabled = existing.enabled;
    } else if (nextIso === undefined) {
      nextIso = null;
    }
    if (nextEnabled === undefined) nextEnabled = true;
  }
  if (nextEnrich === null) nextEnrich = undefined;
  if (nextIso) {
    const names = new Set(roots.map((r) => r.name));
    nextIso = {
      projects: nextIso.projects,
      bindings: nextIso.bindings.filter((b) => names.has(b.root)),
    };
  }
  const raw: Record<string, unknown> = { roots, enrich: nextEnrich, enabled: nextEnabled !== false };
  if (nextIso) {
    raw.version = CONFIG_VERSION;
    raw.projects = nextIso.projects;
    raw.bindings = nextIso.bindings.map((b) => ({
      root: b.root,
      path: b.path,
      scope: scopeToJson(b.scope),
    }));
  }
  const spec = parseConfigJson(raw);
  if (!spec.ok) return { ok: false, configPath, error: spec.error };
  const payload: Record<string, unknown> = {
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
  if (spec.isolation) {
    payload.version = CONFIG_VERSION;
    payload.projects = spec.projects;
    payload.bindings = spec.bindings.map((b) => ({
      root: b.root,
      path: b.path,
      scope: scopeToJson(b.scope),
    }));
  }
  if (spec.enrich) payload.enrich = spec.enrich;
  if (spec.enabled === false) payload.enabled = false;
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
  }).catch(() => {});
}

async function afterAddReadonly(
  config: Extract<LoadedConfig, { ok: true }>,
  name: string,
  ui: KbUi,
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
  return config;
}

async function runKbMenu(
  config: LoadedConfig,
  configPath: string,
  ui: KbUi,
  home: string,
  hooks: EnrichHooks | undefined,
  sessionOpts?: { cwd?: string; session?: ProjectSession; persistSession?: (s: ProjectSession) => void },
): Promise<LoadedConfig> {
  const cwd = sessionOpts?.cwd ?? process.cwd();

  async function addDoc() {
    const name = (await ui.input("名称"))?.trim();
    if (!name) return;
    const path = (await ui.input("路径"))?.trim();
    if (!path) return;
    const kind = await ui.select("用途", [
      { value: "readonly", label: "只读资料", description: "检索原文，不在此写入" },
      { value: "writable", label: "记录目录", description: "原文可读可检索；kb_write 写入 digests/ 和 lessons/，同时只能有一个" },
    ]);
    if (!kind) return;
    const writable = kind === "writable";
    const applied = applyRootChange(snapshotRoots(config), { op: "add", name, path, writable });
    if (!applied.ok) {
      ui.notify(applied.error, "error");
      return;
    }
    const saved = await saveConfigFile(configPath, applied.roots, home);
    if (!saved.ok) {
      ui.notify(saved.error, "error");
      return;
    }
    config = saved;
    const raw = await ui.input("项目地址", cwd);
    const scoped = raw === undefined || !raw.trim()
      ? await bindDocumentShared(config, name, configPath)
      : await bindDocumentToProject(config, name, raw, configPath, home);
    if ("error" in scoped) {
      ui.notify(scoped.error, "error");
    } else {
      const bound = await saveConfigFile(configPath, snapshotRoots(config), home, undefined, scoped.iso);
      config = bound;
      ui.notify(bound.ok ? "已保存" : bound.error, bound.ok ? "info" : "error");
    }
    if (config.ok) config = await afterAddReadonly(config, name, ui);
  }

  async function startAi(rootName: string, mode: "full" | "incremental") {
    if (!config.ok) return;
    if (!hooks) {
      ui.notify("当前环境不能调用清洗模型", "error");
      return;
    }
    const model = await hooks.resolveModel(config.enrich, ui);
    if (!model) return;
    if ("ok" in model) {
      ui.notify(model.error, "error");
      return;
    }
    const saved = await saveConfigFile(configPath, snapshotRoots(config), home, model);
    if (!saved.ok) {
      ui.notify(saved.error, "error");
      return;
    }
    config = saved;
    ui.notify(await hooks.start(saved, rootName, mode));
  }

  async function ensureEnrich(): Promise<EnrichSettings | undefined> {
    if (config.ok && config.enrich) return config.enrich;
    if (!hooks) {
      ui.notify("当前环境不能调用清洗模型", "error");
      return;
    }
    const model = await hooks.resolveModel(config.ok ? config.enrich : undefined, ui);
    if (!model) return;
    if ("ok" in model) {
      ui.notify(model.error, "error");
      return;
    }
    const saved = await saveConfigFile(configPath, snapshotRoots(config), home, model);
    config = saved;
    if (!saved.ok) {
      ui.notify(saved.error, "error");
      return;
    }
    return saved.enrich;
  }

  async function saveEnrich(next: EnrichSettings): Promise<void> {
    const saved = await saveConfigFile(configPath, snapshotRoots(config), home, next);
    config = saved;
    ui.notify(saved.ok ? "已保存" : saved.error, saved.ok ? "info" : "error");
  }

  async function settingsMenu() {
    for (;;) {
      const enrich = config.ok ? config.enrich : undefined;
      const conc = enrich?.concurrency ?? DEFAULT_CONCURRENCY;
      const timeoutSec = Math.round((enrich?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
      const act = await ui.select("设置", [
        { value: "concurrency", label: "并发", description: `${conc} 路，同时整理几篇` },
        { value: "timeout", label: "超时", description: `${timeoutSec} 秒，单次模型请求` },
      ]);
      if (!act) return;
      const base = await ensureEnrich();
      if (!base) continue;
      if (act === "concurrency") {
        const raw = (await ui.input("并发", String(conc)))?.trim();
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
          ui.notify(`并发必须是 1–${MAX_CONCURRENCY} 的整数`, "error");
          continue;
        }
        await saveEnrich({ ...base, concurrency: n });
      } else if (act === "timeout") {
        const raw = (await ui.input("超时秒数", String(timeoutSec)))?.trim();
        if (!raw) continue;
        const sec = Number(raw);
        const ms = sec * 1000;
        if (!Number.isInteger(sec) || ms < 1000 || ms > 300_000) {
          ui.notify("超时必须是 1–300 的整数秒", "error");
          continue;
        }
        await saveEnrich({ ...base, timeoutMs: ms });
      }
    }
  }

  async function aiMenu(rootName: string) {
    for (;;) {
      let progress = "没有进行中的任务";
      if (config.ok) {
        const root = config.roots.find((r) => r.name === rootName);
        if (root?.realPath) {
          const { loadJob, jobSummary } = await import("./semantic.ts");
          const job = await loadJob(root.realPath);
          if (job) progress = jobSummary(job);
        }
      }
      const act = await ui.select("AI整理", [
        { value: "start", label: "开始", description: "全量重跑清洗" },
        { value: "incr", label: "增量整理", description: "只处理新增和变更" },
        { value: "stop", label: "停止", description: progress },
      ]);
      if (!act) return;
      if (act === "start") await startAi(rootName, "full");
      else if (act === "incr") await startAi(rootName, "incremental");
      else ui.notify(hooks?.pause ? await hooks.pause(rootName) : progress);
    }
  }

  async function scopeMenu(rootName: string) {
    for (;;) {
      const bind = config.ok ? config.bindings.find((b) => b.root === rootName && b.path === ".") : undefined;
      const ids = bind?.scope.kind === "projects" ? bind.scope.projects : [];
      const opts: KbSelectOption[] = ids.map((id) => {
        const proj = config.ok ? config.projects.find((p) => p.id === id) : undefined;
        const path = proj?.workspaces[0]?.configuredPath ?? id;
        return { value: `proj:${id}`, label: proj?.name ?? id, description: path };
      });
      opts.push({ value: "add", label: "添加", description: "填写项目目录路径" });
      const picked = await ui.select("归属", opts);
      if (!picked) return;
      if (picked === "add") {
        const raw = await ui.input("项目地址", cwd);
        if (raw === undefined) continue;
        const ws = raw.trim();
        if (!ws) {
          ui.notify("项目地址不能为空", "error");
          continue;
        }
        const scoped = await bindDocumentToProject(config, rootName, ws, configPath, home);
        if ("error" in scoped) {
          ui.notify(scoped.error, "error");
          continue;
        }
        const saved = await saveConfigFile(configPath, snapshotRoots(config), home, undefined, scoped.iso);
        config = saved;
        ui.notify(saved.ok ? "已保存归属" : saved.error, saved.ok ? "info" : "error");
        continue;
      }
      const id = picked.startsWith("proj:") ? picked.slice(5) : picked;
      const proj = config.ok ? config.projects.find((p) => p.id === id) : undefined;
      const path = proj?.workspaces[0]?.configuredPath ?? id;
      const del = await ui.select(proj?.name ?? id, [
        { value: "delete", label: "删除", description: path },
      ]);
      if (del !== "delete" || !config.ok) continue;
      const iso = snapshotIsolation(config);
      if (!iso) continue;
      const cur = iso.bindings.find((b) => b.root === rootName && b.path === ".");
      if (cur?.scope.kind === "projects") {
        cur.scope.projects = cur.scope.projects.filter((p) => p !== id);
        if (!cur.scope.projects.length) {
          iso.bindings = iso.bindings.filter((b) => b !== cur);
        }
      }
      const saved = await saveConfigFile(configPath, snapshotRoots(config), home, undefined, iso);
      config = saved;
      ui.notify(saved.ok ? "已删除归属" : saved.error, saved.ok ? "info" : "error");
    }
  }

  async function docMenu(rootName: string) {
    for (;;) {
      const root = snapshotRoots(config).find((r) => r.name === rootName);
      if (!root) return;
      const act = await ui.select(rootName, [
        { value: "delete", label: "删除", description: "只去掉配置，不删磁盘文件" },
        { value: "ai", label: "AI整理", description: "用清洗模型生成检索资料" },
        { value: "scope", label: "归属", description: "这份资料给哪些项目用" },
        root.writable
          ? { value: "readonly", label: "取消记录", description: "改回只读资料，不再接收 kb_write" }
          : { value: "writable", label: "设为记录目录", description: "原文仍可读；kb_write 写入 digests/ 和 lessons/，同时只能有一个" },
      ]);
      if (!act) return;
      if (act === "ai") {
        await aiMenu(rootName);
        continue;
      }
      if (act === "scope") {
        await scopeMenu(rootName);
        continue;
      }
      if (act === "writable" || act === "readonly") {
        const applied = applyRootChange(snapshotRoots(config), {
          op: "setWritable",
          name: rootName,
          writable: act === "writable",
        });
        if (!applied.ok) {
          ui.notify(applied.error, "error");
          continue;
        }
        const saved = await saveConfigFile(configPath, applied.roots, home);
        config = saved;
        ui.notify(saved.ok ? (act === "writable" ? "已设为记录目录" : "已改为只读") : saved.error, saved.ok ? "info" : "error");
        continue;
      }
      if (act === "delete") {
        if (!await ui.confirm("删除这个文档配置？", rootName)) continue;
        const applied = applyRootChange(snapshotRoots(config), { op: "remove", name: rootName });
        if (!applied.ok) {
          ui.notify(applied.error, "error");
          continue;
        }
        const saved = await saveConfigFile(configPath, applied.roots, home);
        config = saved;
        ui.notify(saved.ok ? "已保存" : saved.error, saved.ok ? "info" : "error");
        return;
      }
    }
  }

  for (;;) {
    if (config.ok && !config.enabled) {
      const top = await ui.select("知识库", [
        { value: "on", label: "开启插件", description: "恢复检索、整理和主动查阅" },
      ]);
      if (!top) {
        ui.notify(await formatStatus(config));
        return config;
      }
      const saved = await saveConfigFile(configPath, snapshotRoots(config), home, undefined, undefined, true);
      config = saved;
      ui.notify(saved.ok ? "已开启" : saved.error, saved.ok ? "info" : "error");
      continue;
    }
    const roots = snapshotRoots(config);
    const topOpts: KbSelectOption[] = roots.map((r) => ({
      value: `root:${r.name}`,
      label: r.name,
      description: r.writable ? `${r.path}  ·记录` : r.path,
    }));
    topOpts.push({ value: "add", label: "添加文档", description: "加入一个笔记目录，不改原文件" });
    topOpts.push({ value: "settings", label: "设置", description: "清洗并发和超时" });
    topOpts.push({ value: "off", label: "关闭插件", description: "停止检索和写入，目录配置保留" });
    const top = await ui.select("知识库", topOpts);
    if (!top) {
      ui.notify(await formatStatus(config));
      return config;
    }
    if (top === "off") {
      const saved = await saveConfigFile(configPath, snapshotRoots(config), home, undefined, undefined, false);
      config = saved;
      ui.notify(saved.ok ? "已关闭" : saved.error, saved.ok ? "info" : "error");
      continue;
    }
    if (top === "add") await addDoc();
    else if (top === "settings") await settingsMenu();
    else if (top.startsWith("root:")) await docMenu(top.slice(5));
  }
}

export async function configureKbInteractive(
  configPath: string,
  ui: KbUi,
  home = homedir(),
  hooks?: EnrichHooks,
  sessionOpts?: { cwd?: string; session?: ProjectSession; persistSession?: (s: ProjectSession) => void },
): Promise<LoadedConfig> {
  let config = await loadConfigFile(configPath, home);
  if (!config.ok && !config.error.includes("不存在")) {
    const overwrite = await ui.confirm("覆盖损坏的配置？", config.error);
    if (!overwrite) {
      ui.notify(await formatStatus(config), "error");
      return config;
    }
  }
  return runKbMenu(config, configPath, ui, home, hooks, sessionOpts);
}

export function isOriginalTextFile(config: Extract<LoadedConfig, { ok: true }>, realPath: string): boolean {
  if (!TEXT_EXTS.has(extname(realPath).toLowerCase())) return false;
  const owner = mostSpecificRoot(realPath, config.roots);
  if (owner && pathInside(realPath, cacheDirFor(owner.realPath ?? owner.path))) return false;
  if (isAiOutputFile(config, realPath)) return false;
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
