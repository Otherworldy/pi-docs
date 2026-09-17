import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  FILE_MAX,
  SKIP_DIRS,
  TEXT_EXTS,
  TITLE_MAX,
  excluded,
  extractNoteTitle,
  normalizeNoteLines,
  parseShowDocInfo,
  parseShowDocReadme,
  pathInside,
  pathKey,
  samePath,
  sha256,
} from "./source.mjs";
import { parseScope } from "./scope.mjs";
import { commitIndex, docIdFor, getDocs, listDocIds } from "./index-store.mjs";
import { postingsForDoc } from "./retrieval.mjs";

export const SCAN_MS = 5000;
export const MAX_DIRENTS = 10_000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const INDEX_BATCH = 32;

export function newScanBudget(signal, now = Date.now(), limits = {}) {
  return {
    deadline: now + (limits.ms ?? SCAN_MS),
    dirents: 0,
    bodyBytes: 0,
    skipped: 0,
    reasons: [],
    truncated: false,
    signal,
    maxDirents: limits.dirents ?? MAX_DIRENTS,
    maxBodyBytes: limits.bodyBytes ?? MAX_BODY_BYTES,
  };
}

export function budgetStop(b) {
  if (b.signal?.aborted) {
    b.truncated = true;
    if (!b.reasons.includes("cancelled")) b.reasons.push("cancelled");
    return true;
  }
  if (Date.now() > b.deadline) {
    b.truncated = true;
    if (!b.reasons.includes("time")) b.reasons.push("time");
    return true;
  }
  if (b.dirents >= (b.maxDirents ?? MAX_DIRENTS)) {
    b.truncated = true;
    if (!b.reasons.includes("dirents")) b.reasons.push("dirents");
    return true;
  }
  if (b.bodyBytes >= (b.maxBodyBytes ?? MAX_BODY_BYTES)) {
    b.truncated = true;
    if (!b.reasons.includes("body-bytes")) b.reasons.push("body-bytes");
    return true;
  }
  return false;
}

export function skipScan(b, reason) {
  b.skipped += 1;
  if (b.reasons.length < 8 && !b.reasons.includes(reason)) b.reasons.push(reason);
}

export async function walkTextFiles(base, skipInside, b, visit, exclude = []) {
  if (!base) return;
  const stack = [base];
  while (stack.length) {
    if (budgetStop(b)) return;
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipScan(b, "unreadable-dir");
      continue;
    }
    for (const ent of entries) {
      b.dirents += 1;
      if (budgetStop(b)) return;
      const abs = join(dir, ent.name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        skipScan(b, "unreadable-file");
        continue;
      }
      if (st.isSymbolicLink()) {
        skipScan(b, "symlink");
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
      let real;
      try {
        real = await realpath(abs);
      } catch {
        skipScan(b, "unreadable-file");
        continue;
      }
      if (skipInside.some((p) => pathInside(real, p) || samePath(real, p))) continue;
      const rel = relative(base, real);
      if (excluded(rel, exclude)) continue;
      await visit(real, rel.replaceAll("\\", "/"), st);
    }
  }
}

export async function readUtf8Limited(path, b) {
  let st;
  try {
    st = await lstat(path);
  } catch {
    skipScan(b, "unreadable-file");
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    skipScan(b, "symlink");
    return null;
  }
  if (st.size > FILE_MAX) {
    skipScan(b, "too-large");
    return null;
  }
  let buf;
  try {
    buf = await readFile(path);
  } catch {
    skipScan(b, "unreadable-file");
    return null;
  }
  b.bodyBytes += buf.byteLength;
  if (buf.includes(0)) {
    skipScan(b, "binary");
    return null;
  }
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) {
    skipScan(b, "non-utf8");
    return null;
  }
  return { text, buf, size: st.size, mtimeMs: st.mtimeMs };
}

async function resolveMappedFile(dir, filename, base, exclude) {
  const abs = resolve(dir, filename);
  try {
    const st = await lstat(abs);
    if (!st.isFile() || st.isSymbolicLink()) return;
    const real = await realpath(abs);
    if (!pathInside(real, base) && !samePath(real, base)) return;
    const rel = relative(base, real);
    if (excluded(rel, exclude)) return;
    return real;
  } catch {
    return;
  }
}

async function showDocMaps(files, base, exclude, b) {
  const fileToTitle = new Map();
  const titleToCatalog = new Map();
  const skipMeta = new Set();
  for (const file of files) {
    if (/_readme\.md$/i.test(file.name)) {
      const parsed = parseShowDocReadme(file.text);
      if (parsed.size === 0) continue;
      let used = 0;
      for (const [name, title] of parsed) {
        const real = await resolveMappedFile(file.dir, name, base, exclude);
        if (!real) {
          skipScan(b, "showdoc-out-of-scope");
          continue;
        }
        const prev = fileToTitle.get(pathKey(real));
        if (prev && prev !== title) {
          fileToTitle.delete(pathKey(real));
          skipScan(b, "showdoc-dup-title");
          continue;
        }
        fileToTitle.set(pathKey(real), title);
        used += 1;
      }
      if (used > 0) skipMeta.add(pathKey(file.realPath));
    } else if (/_info\.json$/i.test(file.name)) {
      let raw;
      try {
        raw = JSON.parse(file.text);
      } catch {
        skipScan(b, "showdoc-info-invalid");
        continue;
      }
      const catalogs = parseShowDocInfo(raw);
      if (!catalogs) {
        skipScan(b, "showdoc-info-invalid");
        continue;
      }
      for (const [title, catalog] of catalogs) {
        const prev = titleToCatalog.get(title);
        if (prev && prev.join("/") !== catalog.join("/")) {
          titleToCatalog.delete(title);
          skipScan(b, "showdoc-dup-title");
          continue;
        }
        titleToCatalog.set(title, catalog);
      }
      skipMeta.add(pathKey(file.realPath));
    }
  }
  return { fileToTitle, titleToCatalog, skipMeta };
}

async function loadPrevDocs(sourcePath) {
  const listed = await listDocIds(sourcePath);
  if (!listed.ok) return listed;
  const got = await getDocs(sourcePath, listed.ids);
  if (!got.ok) return got;
  const byRel = new Map();
  for (const doc of got.docs.values()) {
    byRel.set(pathKey(doc.relPath), doc);
  }
  return { ok: true, generation: listed.generation, byRel, ids: listed.ids };
}

function titleOf(file, maps) {
  const mapped = maps.fileToTitle.get(pathKey(file.realPath));
  return (mapped ?? extractNoteTitle(file.text) ?? basename(file.realPath, extname(file.realPath))).slice(0, TITLE_MAX);
}

export async function indexRoot(opts) {
  try {
  const sourcePath = opts.sourcePath;
  const sourceKey = opts.sourceKey ?? pathKey(sourcePath);
  const skipInside = opts.skipInside ?? [];
  const exclude = opts.exclude ?? [];
  const mode = opts.mode === "full" ? "full" : "meta";
  const batchSize = opts.batchSize ?? INDEX_BATCH;
  const prev = await loadPrevDocs(sourcePath);
  if (!prev.ok) return prev;
  const b = newScanBudget(opts.signal, Date.now(), {
    ms: opts.scanMs ?? 120_000,
    dirents: opts.maxDirents ?? 1_000_000,
    bodyBytes: opts.maxBodyBytes ?? 1024 * 1024 * 1024,
  });
  const seen = new Set();
  const metaFiles = [];
  const pending = [];
  let updated = 0;
  let generation = prev.generation;

  async function flush() {
    if (!pending.length) return { ok: true };
    const batch = pending.splice(0, pending.length);
    const committed = await commitIndex(sourcePath, { sourceKey, upserts: batch, complete: false });
    if (!committed.ok) return committed;
    generation = committed.generation;
    updated += batch.length;
    opts.onProgress?.({ state: "indexing", updated, generation });
    return { ok: true };
  }

  await walkTextFiles(sourcePath, skipInside, b, async (realPath, relPath, st) => {
    const name = basename(realPath);
    if (/_readme\.md$/i.test(name) || /_info\.json$/i.test(name)) {
      const got = await readUtf8Limited(realPath, b);
      if (!got) return;
      metaFiles.push({
        realPath,
        relPath,
        dir: dirname(realPath),
        name,
        text: got.text,
        hash: sha256(got.buf),
        mtimeMs: got.mtimeMs,
        size: got.size,
      });
    }
  }, exclude);
  if (b.truncated && !metaFiles.length && prev.generation === 0) {
    /* still try content files below if walk died immediately */
  }
  const maps = await showDocMaps(metaFiles, sourcePath, exclude, b);
  const metaFp = sha256(JSON.stringify({
    titles: [...maps.fileToTitle.entries()].sort(),
    catalogs: [...maps.titleToCatalog.entries()].sort(),
    skipMeta: [...maps.skipMeta].sort(),
  }));

  const contentBudget = newScanBudget(opts.signal, Date.now(), {
    ms: opts.scanMs ?? 120_000,
    dirents: opts.maxDirents ?? 1_000_000,
    bodyBytes: opts.maxBodyBytes ?? 1024 * 1024 * 1024,
  });
  await walkTextFiles(sourcePath, skipInside, contentBudget, async (realPath, relPath, st) => {
    if (maps.skipMeta.has(pathKey(realPath))) return;
    const id = docIdFor(sourceKey, relPath);
    seen.add(id);
    const old = prev.byRel.get(pathKey(relPath));
    const aiRel = isAiNoteRel(relPath);
    const mapsOk = aiRel || old?.metaFingerprint === metaFp;
    const metaUnchanged = old
      && old.size === st.size
      && old.mtimeMs === st.mtimeMs
      && mapsOk
      && mode !== "full";
    if (metaUnchanged) return;
    const got = await readUtf8Limited(realPath, contentBudget);
    if (!got) return;
    const hash = sha256(got.buf);
    if (old && old.sourceHash === hash && (aiRel || old.metaFingerprint === metaFp) && mode !== "full") return;
    const lines = normalizeNoteLines(got.text);
    const ai = isAiNoteRel(relPath) ? peekNoteKind(got.text) : undefined;
    const title = ai ? (extractNoteTitle(got.text) ?? basename(realPath, extname(realPath))) : titleOf({ realPath, text: got.text }, maps);
    const catalog = ai ? [] : (maps.titleToCatalog.get(title) ?? []);
    const doc = {
      docId: id,
      relPath,
      kind: ai?.kind ?? "original",
      title,
      catalog,
      sourceHash: hash,
      sourcePath: ai?.sourcePath,
      sourceFileHash: ai?.sourceHash,
      scope: ai?.scope,
      mtimeMs: st.mtimeMs,
      size: st.size,
      metaFingerprint: ai ? "ai" : metaFp,
    };
    pending.push({
      doc,
      postings: postingsForDoc({ relPath, title, catalog, lines, extra: ai?.sourceTitle ?? "" }),
    });
    if (pending.length >= batchSize) await flush();
  }, exclude);

  const truncated = b.truncated || contentBudget.truncated;
  if (pending.length) {
    const flushed = await flush();
    if (!flushed.ok) return flushed;
  }

  const deletes = [];
  if (!truncated) {
    for (const doc of prev.byRel.values()) {
      if (!seen.has(doc.docId)) deletes.push(doc.docId);
    }
    const committed = await commitIndex(sourcePath, {
      sourceKey,
      deletes,
      complete: true,
    });
    if (!committed.ok) return committed;
    generation = committed.generation;
  }
  return {
    ok: true,
    generation,
    updated,
    deleted: deletes.length,
    truncated,
    skipped: b.skipped + contentBudget.skipped,
    reasons: [...new Set([...b.reasons, ...contentBudget.reasons])],
    state: truncated ? "partial" : "ready",
  };
  } catch (err) {
    return { ok: false, error: `索引失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function isAiNoteRel(relPath) {
  const rel = relPath.replaceAll("\\", "/");
  return rel === "digests" || rel === "lessons" || rel.startsWith("digests/") || rel.startsWith("lessons/");
}

function peekNoteKind(text) {
  try {
    const m = /^<!-- pi-kb\n([\s\S]*?)\n-->/.exec(text);
    if (!m) return { kind: "lesson" };
    const raw = JSON.parse(m[1]);
    if (raw.type === "digest") {
      return {
        kind: "digest",
        sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath : undefined,
        sourceHash: typeof raw.sourceHash === "string" ? raw.sourceHash : undefined,
        sourceTitle: typeof raw.sourceTitle === "string" ? raw.sourceTitle : undefined,
      };
    }
    const scope = parseScope(raw.scope);
    return { kind: "lesson", scope: scope.ok ? scope.scope : undefined };
  } catch {
    return { kind: "lesson" };
  }
}

export function skipInsidePaths(rootPath, writablePath, writable) {
  const skip = [join(rootPath, ".pi-kb")];
  if (!writablePath) return skip;
  if (!(writable || samePath(rootPath, writablePath)) && (pathInside(writablePath, rootPath) || samePath(writablePath, rootPath))) {
    skip.push(writablePath);
  }
  return skip;
}
