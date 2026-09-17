import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  RULE_VERSION,
  cacheDirFor,
  formatNote,
  pathKey,
  sha256,
  type EnrichSettings,
  type Fail,
  type LoadedConfig,
  type PreparedDoc,
  type PreparedSnapshot,
  prepareReadonlyRoot,
} from "./kb.ts";
import { commitIndex, docIdFor } from "./index-store.mjs";
import { postingsForDoc } from "./retrieval.mjs";

export const PROMPT_VERSION = 1;
export const CHUNK_VERSION = 1;
export const JOB_VERSION = 1;
export const MAX_CHUNK_CHARS = 12_000;

export type ModelComplete = (input: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<{ text: string; inputTokens: number; outputTokens: number; costUnknown?: boolean }>;

export type SemanticRule = {
  text: string;
  startLine: number;
  endLine: number;
  excerpt: string;
};

export type SemanticRecord = {
  path: string;
  sourceHash: string;
  title: string;
  catalog: string[];
  provider: string;
  model: string;
  promptVersion: number;
  chunkVersion: number;
  coverage: { startLine: number; endLine: number }[];
  summary: string;
  topics: string[];
  aliases: string[];
  questions: string[];
  rules: SemanticRule[];
  inputTokens: number;
  outputTokens: number;
};

export type ChunkStatus = "pending" | "running" | "completed" | "failed" | "stale";

export type ChunkOutput = {
  summary: string;
  topics: string[];
  aliases: string[];
  questions: string[];
  rules: SemanticRule[];
};

export type JobChunk = {
  docPath: string;
  sourceHash: string;
  index: number;
  startLine: number;
  endLine: number;
  status: ChunkStatus;
  error?: string;
  output?: ChunkOutput;
};

export type EnrichJob = {
  version: number;
  rootName: string;
  sourceKey: string;
  provider: string;
  model: string;
  promptVersion: number;
  chunkVersion: number;
  maxRequests: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUnknown: boolean;
  paused: boolean;
  chunks: JobChunk[];
  records: SemanticRecord[];
};

const SYSTEM = `你整理一份只读技术文档，供后续检索。只根据给定正文，不要发明未出现的规则。
返回一个 JSON 对象，字段：
summary: 字符串，概述与适用场景
topics: 字符串数组，主题或组件名
aliases: 字符串数组，有依据的检索别名
questions: 字符串数组，相关业务问法
rules: 数组，每项 {text, startLine, endLine, excerpt}
excerpt 必须是对应行范围内的原文片段。不要改写数值、否定或“待实现”状态。未知就返回空数组。`;

export function defaultMaxRequests(chunkCount: number): number {
  return Math.max(1, chunkCount * 2);
}

export function jobPath(sourcePath: string): string {
  return join(cacheDirFor(sourcePath), "job.json");
}

export function lockPath(sourcePath: string): string {
  return join(cacheDirFor(sourcePath), "job.lock");
}

export function semanticPath(sourcePath: string): string {
  return join(cacheDirFor(sourcePath), "sem.json");
}

export function splitChunks(doc: PreparedDoc): { startLine: number; endLine: number }[] {
  const total = Math.max(1, doc.lines.length);
  const ranges: { startLine: number; endLine: number }[] = [];
  let start = 1;
  let chars = 0;
  let fence: string | undefined;
  let table = false;
  for (let i = 0; i < doc.lines.length; i++) {
    const lineNo = i + 1;
    const raw = doc.lines[i] ?? "";
    const trimmed = raw.trim();
    const wasFence = !!fence;
    const mark = /^(```+|~~~+)/.exec(trimmed);
    if (mark) {
      const ch = mark[1][0];
      if (!fence) fence = ch;
      else if (ch === fence) fence = undefined;
    }
    const isTable = /^\s*\|/.test(raw);
    if (!isTable) table = false;
    else if (!table) table = true;
    const next = raw.length + 1;
    const heading = i > 0 && !wasFence && !fence && /^#{1,6}\s+\S/.test(trimmed);
    const canSplit = !wasFence && !fence && !table;
    if (ranges.length === 0 && i === 0) chars = next;
    else if (canSplit && chars + next > MAX_CHUNK_CHARS && lineNo > start) {
      ranges.push({ startLine: start, endLine: lineNo - 1 });
      start = lineNo;
      chars = next;
    } else if (canSplit && heading && chars > MAX_CHUNK_CHARS / 2) {
      ranges.push({ startLine: start, endLine: lineNo - 1 });
      start = lineNo;
      chars = next;
    } else chars += next;
  }
  ranges.push({ startLine: start, endLine: total });
  return ranges;
}

function chunkKey(chunk: Pick<JobChunk, "docPath" | "sourceHash" | "index" | "startLine" | "endLine">): string {
  return `${pathKey(chunk.docPath)}:${chunk.sourceHash}:${chunk.index}:${chunk.startLine}:${chunk.endLine}`;
}

export function buildJob(snapshot: PreparedSnapshot, enrich: EnrichSettings, maxRequests?: number): EnrichJob {
  const chunks: JobChunk[] = [];
  for (const doc of snapshot.docs) {
    const parts = splitChunks(doc);
    parts.forEach((part, index) => {
      chunks.push({
        docPath: doc.path,
        sourceHash: doc.sourceHash,
        index,
        startLine: part.startLine,
        endLine: part.endLine,
        status: "pending",
      });
    });
  }
  return {
    version: JOB_VERSION,
    rootName: snapshot.sourceName,
    sourceKey: snapshot.sourceKey,
    provider: enrich.provider,
    model: enrich.model,
    promptVersion: PROMPT_VERSION,
    chunkVersion: CHUNK_VERSION,
    maxRequests: maxRequests ?? defaultMaxRequests(chunks.length),
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUnknown: false,
    paused: false,
    chunks,
    records: [],
  };
}

function isSemanticRecord(raw: unknown): raw is SemanticRecord {
  if (!raw || typeof raw !== "object") return false;
  const rec = raw as Record<string, unknown>;
  return typeof rec.path === "string"
    && typeof rec.sourceHash === "string"
    && Array.isArray(rec.topics)
    && Array.isArray(rec.aliases)
    && Array.isArray(rec.questions)
    && Array.isArray(rec.rules);
}

export function parseJob(raw: unknown): EnrichJob | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== JOB_VERSION || rec.promptVersion !== PROMPT_VERSION || rec.chunkVersion !== CHUNK_VERSION) return null;
  if (typeof rec.rootName !== "string" || typeof rec.sourceKey !== "string") return null;
  if (!Array.isArray(rec.chunks) || !Array.isArray(rec.records)) return null;
  return rec as EnrichJob;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) return;
    const buf = await readFile(path);
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    return;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<Fail | { ok: true }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.sem-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { await chmod(tmp, 0o600); } catch { /* windows */ }
    await rename(tmp, path);
    return { ok: true };
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore */ }
    return { ok: false, error: `无法写入任务: ${(err as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
}

export async function loadJob(sourcePath: string): Promise<EnrichJob | undefined> {
  const raw = await readJsonFile(jobPath(sourcePath));
  return raw ? parseJob(raw) ?? undefined : undefined;
}

export async function loadSemantics(sourcePath: string): Promise<SemanticRecord[]> {
  const raw = await readJsonFile(semanticPath(sourcePath));
  if (!raw || typeof raw !== "object") return [];
  const records = (raw as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  return records.filter(isSemanticRecord);
}

async function saveJob(sourcePath: string, job: EnrichJob): Promise<Fail | { ok: true }> {
  return writeJsonAtomic(jobPath(sourcePath), job);
}

async function saveSemantics(sourcePath: string, sourceKey: string, records: SemanticRecord[]): Promise<Fail | { ok: true }> {
  return writeJsonAtomic(semanticPath(sourcePath), { version: RULE_VERSION, sourceKey, records });
}

export async function acquireLock(sourcePath: string): Promise<Fail | { ok: true; token: string }> {
  const p = lockPath(sourcePath);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  try {
    const fh = await open(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await fh.writeFile(token, "utf8");
    } finally {
      await fh.close();
    }
    return { ok: true, token };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { ok: false, error: "该来源已有 AI 整理任务在运行" };
    return { ok: false, error: `无法加锁: ${code ?? "unknown"}` };
  }
}

export async function releaseLock(sourcePath: string, token: string): Promise<void> {
  const p = lockPath(sourcePath);
  try {
    const got = await readFile(p, "utf8");
    if (got === token) await unlink(p);
  } catch {
    /* ignore */
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("not-json");
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function asStringArray(raw: unknown, max = 12): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()).slice(0, max);
}

export function validateModelOutput(raw: unknown, doc: PreparedDoc, startLine: number, endLine: number): {
  summary: string;
  topics: string[];
  aliases: string[];
  questions: string[];
  rules: SemanticRule[];
} | Fail {
  if (!raw || typeof raw !== "object") return { ok: false, error: "结果不是对象" };
  const rec = raw as Record<string, unknown>;
  const summary = typeof rec.summary === "string" ? rec.summary.trim().slice(0, 800) : "";
  const topics = asStringArray(rec.topics);
  const aliases = asStringArray(rec.aliases);
  const questions = asStringArray(rec.questions);
  const rules: SemanticRule[] = [];
  if (Array.isArray(rec.rules)) {
    for (const item of rec.rules.slice(0, 20)) {
      if (!item || typeof item !== "object") continue;
      const rule = item as Record<string, unknown>;
      const text = typeof rule.text === "string" ? rule.text.trim() : "";
      const excerpt = typeof rule.excerpt === "string" ? rule.excerpt.trim() : "";
      const s = typeof rule.startLine === "number" ? rule.startLine : Number(rule.startLine);
      const e = typeof rule.endLine === "number" ? rule.endLine : Number(rule.endLine);
      if (!text || !excerpt || !Number.isInteger(s) || !Number.isInteger(e)) return { ok: false, error: "规则字段无效" };
      if (s < startLine || e > endLine || s > e) return { ok: false, error: "规则行号越界" };
      const slice = doc.lines.slice(s - 1, e).join("\n");
      if (!slice.includes(excerpt)) {
        return { ok: false, error: "摘录不在原文范围内" };
      }
      rules.push({ text: text.slice(0, 400), startLine: s, endLine: e, excerpt: excerpt.slice(0, 300) });
    }
  }
  return { summary, topics, aliases, questions, rules };
}

function mergeRecord(doc: PreparedDoc, enrich: EnrichSettings, parts: ReturnType<typeof validateModelOutput>[], coverage: { startLine: number; endLine: number }[], tokens: { in: number; out: number }): SemanticRecord | Fail {
  const okParts = [];
  for (const part of parts) {
    if ("ok" in part) return part;
    okParts.push(part);
  }
  const topics = [...new Set(okParts.flatMap((p) => p.topics))];
  const aliases = [...new Set(okParts.flatMap((p) => p.aliases))];
  const questions = [...new Set(okParts.flatMap((p) => p.questions))];
  return {
    path: doc.path,
    sourceHash: doc.sourceHash,
    title: doc.title,
    catalog: doc.catalog,
    provider: enrich.provider,
    model: enrich.model,
    promptVersion: PROMPT_VERSION,
    chunkVersion: CHUNK_VERSION,
    coverage,
    summary: okParts.map((p) => p.summary).filter(Boolean).join("\n").slice(0, 1200),
    topics,
    aliases,
    questions,
    rules: okParts.flatMap((p) => p.rules),
    inputTokens: tokens.in,
    outputTokens: tokens.out,
  };
}

function reuseChunks(prev: EnrichJob | undefined, next: EnrichJob): EnrichJob {
  if (!prev) return next;
  if (prev.promptVersion !== next.promptVersion) return next;
  const done = new Map(prev.chunks.filter((c) => c.status === "completed").map((c) => [chunkKey(c), c]));
  const records = prev.records.filter((r) => next.chunks.some((c) => pathKey(c.docPath) === pathKey(r.path) && c.sourceHash === r.sourceHash));
  return {
    ...next,
    requests: prev.requests,
    inputTokens: prev.inputTokens,
    outputTokens: prev.outputTokens,
    costUnknown: prev.costUnknown,
    records,
    chunks: next.chunks.map((c) => done.get(chunkKey(c)) ?? c),
  };
}

export function jobSummary(job: EnrichJob, current?: string): string {
  const total = job.chunks.length;
  const done = job.chunks.filter((c) => c.status === "completed").length;
  const failed = job.chunks.filter((c) => c.status === "failed").length;
  const pending = job.chunks.filter((c) => c.status === "pending" || c.status === "running").length;
  const pct = total ? Math.round((100 * done) / total) : 0;
  const state = job.paused && pending > 0
    ? "已暂停"
    : pending === 0 && failed === 0
      ? "全量完成"
      : pending === 0
        ? "部分完成"
        : "进行中";
  const now = current?.trim() ? ` 正在:${current.trim().slice(0, 32)}` : "";
  return `${job.rootName}: ${state} ${done}/${total} (${pct}%)，失败 ${failed}，请求 ${job.requests}/${job.maxRequests}${now}`;
}

export async function pauseJob(sourcePath: string): Promise<string> {
  const job = await loadJob(sourcePath);
  if (!job) return "没有进行中的任务";
  job.paused = true;
  await saveJob(sourcePath, job);
  return `已请求暂停 ${job.rootName}`;
}

export async function startEnrichment(
  config: Extract<LoadedConfig, { ok: true }>,
  rootName: string,
  complete: ModelComplete,
  opts: { signal?: AbortSignal; maxRequests?: number; onProgress?: (text: string) => void; mode?: "full" | "incremental" } = {},
): Promise<string> {
  if (!config.enrich) return "未配置清洗模型";
  const root = config.roots.find((r) => r.name === rootName);
  if (!root) return "未知来源";
  const prepared = await prepareReadonlyRoot(config, root, { signal: opts.signal });
  if (!prepared.ok) return prepared.error;
  const sourcePath = prepared.snapshot.sourcePath;
  const sourceKey = prepared.snapshot.sourceKey;
  const lock = await acquireLock(sourcePath);
  if (!lock.ok) return lock.error;
  try {
    const built = buildJob(prepared.snapshot, config.enrich, opts.maxRequests);
    let job = opts.mode === "full" ? built : reuseChunks(await loadJob(sourcePath), built);
    job.paused = false;
    const docs = new Map(prepared.snapshot.docs.map((d) => [pathKey(d.path), d]));
    const progress = (title?: string) => opts.onProgress?.(jobSummary(job, title));
    await saveJob(sourcePath, job);
    progress();
    for (const chunk of job.chunks) {
      if (opts.signal?.aborted) {
        job.paused = true;
        break;
      }
      if (job.paused) break;
      if (chunk.status === "completed") continue;
      const doc = docs.get(pathKey(chunk.docPath));
      if (!doc || doc.sourceHash !== chunk.sourceHash) {
        chunk.status = "stale";
        continue;
      }
      if (job.requests >= job.maxRequests) {
        job.paused = true;
        break;
      }
      chunk.status = "running";
      job.requests += 1;
      progress(doc.title);
      const body = doc.lines.slice(chunk.startLine - 1, chunk.endLine).map((line, i) => `${chunk.startLine + i}|${line}`).join("\n");
      const user = `标题: ${doc.title}\n分类: ${doc.catalog.join(" / ")}\n行 ${chunk.startLine}-${chunk.endLine}:\n${body}`;
      try {
        const result = await complete({
          system: SYSTEM,
          user,
          maxTokens: config.enrich.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          timeoutMs: config.enrich.timeoutMs,
          signal: opts.signal,
        });
        if (opts.signal?.aborted) {
          chunk.status = "pending";
          job.paused = true;
          break;
        }
        job.inputTokens += result.inputTokens;
        job.outputTokens += result.outputTokens;
        if (result.costUnknown) job.costUnknown = true;
        let parsed: ReturnType<typeof validateModelOutput>;
        try {
          parsed = validateModelOutput(extractJson(result.text), doc, chunk.startLine, chunk.endLine);
        } catch {
          parsed = { ok: false, error: "结果不是 JSON" };
        }
        if ("ok" in parsed && job.requests < job.maxRequests && !opts.signal?.aborted) {
          job.requests += 1;
          const retry = await complete({
            system: SYSTEM,
            user: `${user}\n上次结果无效：${parsed.error}。请只返回合法 JSON。`,
            maxTokens: config.enrich.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            timeoutMs: config.enrich.timeoutMs,
            signal: opts.signal,
          });
          if (opts.signal?.aborted) {
            chunk.status = "pending";
            job.paused = true;
            break;
          }
          job.inputTokens += retry.inputTokens;
          job.outputTokens += retry.outputTokens;
          try {
            parsed = validateModelOutput(extractJson(retry.text), doc, chunk.startLine, chunk.endLine);
          } catch {
            parsed = { ok: false, error: "结果不是 JSON" };
          }
        }
        if ("ok" in parsed) {
          chunk.status = "failed";
          chunk.error = parsed.error;
          chunk.output = undefined;
        } else {
          chunk.status = "completed";
          chunk.error = undefined;
          chunk.output = parsed;
        }
      } catch (err) {
        if (opts.signal?.aborted) {
          chunk.status = "pending";
          chunk.error = undefined;
          job.paused = true;
          break;
        }
        chunk.status = "failed";
        chunk.error = err instanceof Error ? err.message : "调用失败";
        job.costUnknown = true;
        job.paused = true;
        break;
      }
      await saveJob(sourcePath, job);
      progress();
      if (opts.signal?.aborted) {
        job.paused = true;
        break;
      }
    }

    job.records = materializeRecords(job, docs, config.enrich);
    await publishDerivedNotes(sourcePath, sourceKey, job.records, docs);
    await saveSemantics(sourcePath, sourceKey, job.records);
    await saveJob(sourcePath, { ...job, chunks: job.chunks.map((c) => ({ ...c, output: c.status === "completed" ? c.output : undefined })) });
    const summary = jobSummary(job);
    opts.onProgress?.(summary);
    return summary;
  } finally {
    await releaseLock(sourcePath, lock.token);
  }
}

function derivedBody(rec: SemanticRecord): string {
  const rules = rec.rules.map((r) => `- ${r.text}（L${r.startLine}-${r.endLine}）\n  ${r.excerpt}`).join("\n");
  const aliases = rec.aliases.length ? rec.aliases.map((a) => `- ${a}`).join("\n") : "（无）";
  const questions = rec.questions.length ? rec.questions.map((q) => `- ${q}`).join("\n") : "（无）";
  return [
    "## 内容与适用",
    rec.summary || "（无）",
    "",
    "## 规则、约束与例外",
    rules || "（无）",
    "",
    "## 别名与常见问法",
    "别名：",
    aliases,
    "",
    "问法（用于检索，不是已支持功能清单）：",
    questions,
  ].join("\n");
}

async function publishDerivedNotes(
  sourcePath: string,
  sourceKey: string,
  records: SemanticRecord[],
  docs: Map<string, PreparedDoc>,
): Promise<void> {
  if (!records.length) return;
  const noteDir = join(cacheDirFor(sourcePath), "notes");
  await mkdir(noteDir, { recursive: true, mode: 0o700 });
  const upserts = [];
  for (const rec of records) {
    const doc = docs.get(pathKey(rec.path));
    if (!doc) continue;
    const origId = docIdFor(sourceKey, doc.relPath);
    const relPath = `.pi-kb/notes/${origId}.md`;
    const body = derivedBody(rec);
    const text = formatNote({
      type: "derived",
      createdAt: new Date().toISOString(),
      author: "pi-kb",
      cwd: sourcePath,
      sourcePath: rec.path,
      sourceHash: rec.sourceHash,
      sourceTitle: rec.title,
      coverage: "derived",
    }, rec.title, body);
    const notePath = join(noteDir, `${origId}.md`);
    const tmp = join(noteDir, `.${origId}-${randomUUID()}.tmp`);
    await writeFile(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { await chmod(tmp, 0o600); } catch { /* windows */ }
    await rename(tmp, notePath);
    upserts.push({
      doc: {
        docId: docIdFor(sourceKey, relPath),
        relPath,
        kind: "derived",
        title: rec.title,
        catalog: rec.catalog,
        sourceHash: sha256(Buffer.from(text)),
        sourcePath: rec.path,
        sourceFileHash: rec.sourceHash,
      },
      postings: postingsForDoc({
        relPath,
        title: rec.title,
        catalog: rec.catalog,
        lines: body.split("\n"),
        extra: [...rec.topics, ...rec.aliases, ...rec.questions].join("\n"),
      }),
    });
  }
  if (upserts.length) await commitIndex(sourcePath, { sourceKey, upserts, complete: true });
}

function materializeRecords(
  job: EnrichJob,
  docs: Map<string, PreparedDoc>,
  enrich: EnrichSettings,
): SemanticRecord[] {
  const grouped = new Map<string, JobChunk[]>();
  for (const chunk of job.chunks) {
    const list = grouped.get(pathKey(chunk.docPath)) ?? [];
    list.push(chunk);
    grouped.set(pathKey(chunk.docPath), list);
  }
  const records: SemanticRecord[] = [];
  for (const [key, chunks] of grouped) {
    const doc = docs.get(key);
    if (!doc) continue;
    if (!chunks.every((c) => c.status === "completed" && c.output && c.sourceHash === doc.sourceHash)) continue;
    const merged = mergeRecord(
      doc,
      enrich,
      chunks.map((c) => c.output!),
      chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine })),
      { in: job.inputTokens, out: job.outputTokens },
    );
    if ("ok" in merged) continue;
    records.push(merged);
  }
  return records;
}
