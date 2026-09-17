import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { cacheDirFor, sha256 } from "./source.mjs";

export const INDEX_VERSION = 1;
export const BUCKET_COUNT = 256;
export const INDEX_LOCK = "index.lock";

function padBucket(n) {
  return n.toString(16).padStart(2, "0");
}

function dict(from) {
  return Object.assign(Object.create(null), from ?? {});
}

export function docIdFor(sourceKey, relPath) {
  const rel = String(relPath).replaceAll("\\", "/").replace(/^\/+/, "");
  return sha256(`${sourceKey}\n${rel}`).slice(0, 32);
}

export function bucketFor(value) {
  return Number.parseInt(sha256(String(value)).slice(0, 8), 16) % BUCKET_COUNT;
}

export function indexDir(sourcePath) {
  return join(cacheDirFor(sourcePath), "index");
}

export function manifestPath(sourcePath) {
  return join(cacheDirFor(sourcePath), "manifest.json");
}

export function lockPath(sourcePath) {
  return join(cacheDirFor(sourcePath), INDEX_LOCK);
}

function generationPath(sourcePath, generation) {
  return join(indexDir(sourcePath), "manifests", `${generation}.json`);
}

function shardPath(sourcePath, kind, bucket, revision) {
  return join(indexDir(sourcePath), kind, `${padBucket(bucket)}.${revision}.json`);
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.idx-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { await chmod(tmp, 0o600); } catch { /* windows */ }
    await rename(tmp, path);
    return { ok: true };
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore */ }
    return { ok: false, error: `无法写入索引: ${err.code ?? "unknown"}` };
  }
}

async function readJson(path) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) return;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return;
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export async function acquireIndexLock(sourcePath) {
  const p = lockPath(sourcePath);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify({ pid: process.pid, token, host: hostname(), at: new Date().toISOString() })}\n`;
  try {
    const fh = await open(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await fh.writeFile(payload, "utf8");
    } finally {
      await fh.close();
    }
    return { ok: true, token };
  } catch (err) {
    if (err.code !== "EEXIST") return { ok: false, error: `无法加索引锁: ${err.code ?? "unknown"}` };
    const raw = await readJson(p);
    const sameHost = raw && raw.host === hostname();
    if (sameHost && raw.pid !== process.pid && !processAlive(raw.pid)) {
      try { await unlink(p); } catch { /* ignore */ }
      return acquireIndexLock(sourcePath);
    }
    return { ok: false, error: "该来源索引正在更新" };
  }
}

export async function releaseIndexLock(sourcePath, token) {
  const p = lockPath(sourcePath);
  try {
    const raw = await readJson(p);
    if (raw?.token === token) await unlink(p);
  } catch {
    /* ignore */
  }
}

export async function readTopManifest(sourcePath) {
  const raw = await readJson(manifestPath(sourcePath));
  if (!raw || raw.version !== INDEX_VERSION) return;
  if (typeof raw.sourceKey !== "string" || !Number.isInteger(raw.current)) return;
  if (raw.bucketCount !== BUCKET_COUNT) return;
  return raw;
}

export async function readGeneration(sourcePath, generation) {
  const raw = await readJson(generationPath(sourcePath, generation));
  if (!raw || raw.version !== INDEX_VERSION) return;
  if (raw.generation !== generation) return;
  if (!raw.docs || !raw.terms || typeof raw.docs !== "object" || typeof raw.terms !== "object") return;
  return raw;
}

async function loadShard(sourcePath, kind, bucket, revision) {
  if (revision === undefined || revision === null) return kind === "docs" ? { docs: dict() } : { terms: dict() };
  const raw = await readJson(shardPath(sourcePath, kind, bucket, revision));
  if (!raw) return;
  return raw;
}

export async function getDocs(sourcePath, docIds) {
  const top = await readTopManifest(sourcePath);
  if (!top) return { ok: true, generation: 0, docs: new Map() };
  const gen = await readGeneration(sourcePath, top.current);
  if (!gen) return { ok: false, error: "索引世代损坏" };
  const needed = new Map();
  for (const id of docIds) {
    const b = bucketFor(id);
    const list = needed.get(b) ?? [];
    list.push(id);
    needed.set(b, list);
  }
  const docs = new Map();
  for (const [bucket, ids] of needed) {
    const shard = await loadShard(sourcePath, "docs", bucket, gen.docs[String(bucket)]);
    if (!shard) return { ok: false, error: `文档分片缺失: ${padBucket(bucket)}` };
    for (const id of ids) {
      const doc = shard.docs?.[id];
      if (doc) docs.set(id, doc);
    }
  }
  return { ok: true, generation: top.current, docs };
}

export async function getPostings(sourcePath, terms) {
  const top = await readTopManifest(sourcePath);
  if (!top) return { ok: true, generation: 0, terms: new Map() };
  const gen = await readGeneration(sourcePath, top.current);
  if (!gen) return { ok: false, error: "索引世代损坏" };
  const needed = new Map();
  for (const term of terms) {
    const b = bucketFor(term);
    const list = needed.get(b) ?? [];
    list.push(term);
    needed.set(b, list);
  }
  const out = new Map();
  for (const [bucket, keys] of needed) {
    const shard = await loadShard(sourcePath, "terms", bucket, gen.terms[String(bucket)]);
    if (!shard) return { ok: false, error: `词项分片缺失: ${padBucket(bucket)}` };
    for (const term of keys) {
      const rec = shard.terms?.[term];
      if (rec) out.set(term, rec);
    }
  }
  return { ok: true, generation: top.current, terms: out };
}

export async function listDocIds(sourcePath) {
  const top = await readTopManifest(sourcePath);
  if (!top) return { ok: true, generation: 0, ids: [] };
  const gen = await readGeneration(sourcePath, top.current);
  if (!gen) return { ok: false, error: "索引世代损坏" };
  const ids = [];
  for (const [bucket, revision] of Object.entries(gen.docs)) {
    const shard = await loadShard(sourcePath, "docs", Number(bucket), revision);
    if (!shard) return { ok: false, error: `文档分片缺失: ${padBucket(Number(bucket))}` };
    ids.push(...Object.keys(shard.docs ?? {}));
  }
  return { ok: true, generation: top.current, ids };
}

function cloneShard(kind, bucket, revision, raw) {
  if (kind === "docs") {
    return { bucket, revision, docs: dict(raw?.docs) };
  }
  return { bucket, revision, terms: dict(raw?.terms) };
}

function removeDocPostings(termShards, doc) {
  for (const term of doc?.terms ?? []) {
    const b = bucketFor(term);
    const shard = termShards.get(b);
    if (!shard) continue;
    const rec = shard.terms[term];
    if (!rec) continue;
    rec.postings = rec.postings.filter((p) => p.docId !== doc.docId);
    rec.df = rec.postings.length;
    if (!rec.postings.length) delete shard.terms[term];
  }
}

function addDocPostings(termShards, doc, postings, generation) {
  for (const p of postings) {
    const b = bucketFor(p.term);
    let shard = termShards.get(b);
    if (!shard) {
      shard = { bucket: b, revision: generation, terms: dict() };
      termShards.set(b, shard);
    } else {
      shard.revision = generation;
    }
    const rec = shard.terms[p.term] && Array.isArray(shard.terms[p.term].postings)
      ? shard.terms[p.term]
      : { df: 0, postings: [] };
    rec.postings = rec.postings.filter((x) => x.docId !== doc.docId);
    rec.postings.push({
      docId: doc.docId,
      tf: p.tf,
      fields: p.fields ?? [],
      lines: (p.lines ?? []).slice(0, 8),
    });
    rec.df = rec.postings.length;
    shard.terms[p.term] = rec;
  }
}

async function loadTouched(sourcePath, gen, docIds, terms) {
  const docShards = new Map();
  const termShards = new Map();
  const buckets = new Set(docIds.map((id) => bucketFor(id)));
  for (const b of buckets) {
    const revision = gen?.docs?.[String(b)];
    const raw = await loadShard(sourcePath, "docs", b, revision);
    if (revision !== undefined && !raw) return { ok: false, error: `文档分片缺失: ${padBucket(b)}` };
    docShards.set(b, cloneShard("docs", b, revision, raw));
  }
  const termBuckets = new Set(terms.map((t) => bucketFor(t)));
  for (const id of docIds) {
    const b = bucketFor(id);
    const old = docShards.get(b)?.docs?.[id];
    for (const term of old?.terms ?? []) termBuckets.add(bucketFor(term));
  }
  for (const b of termBuckets) {
    const revision = gen?.terms?.[String(b)];
    const raw = await loadShard(sourcePath, "terms", b, revision);
    if (revision !== undefined && !raw) return { ok: false, error: `词项分片缺失: ${padBucket(b)}` };
    termShards.set(b, cloneShard("terms", b, revision, raw));
  }
  return { ok: true, docShards, termShards };
}

async function writeChangedShards(sourcePath, kind, shards, generation, prevRefs) {
  for (const shard of shards.values()) {
    const prevRev = prevRefs?.[String(shard.bucket)];
    const empty = kind === "docs" ? Object.keys(shard.docs).length === 0 : Object.keys(shard.terms).length === 0;
    if (empty) continue;
    if (shard.revision !== generation) continue;
    shard.revision = generation;
    const published = await writeJsonAtomic(shardPath(sourcePath, kind, shard.bucket, generation), shard);
    if (!published.ok) return published;
    void prevRev;
  }
  return { ok: true };
}

export async function stageIndex(sourcePath, input) {
  const sourceKey = input.sourceKey;
  if (!sourceKey) return { ok: false, error: "缺少 sourceKey" };
  const upserts = input.upserts ?? [];
  const deletes = input.deletes ?? [];
  const top = await readTopManifest(sourcePath);
  if (top && top.sourceKey !== sourceKey) return { ok: false, error: "来源身份与索引不一致" };
  const current = top?.current ?? 0;
  const gen = current ? await readGeneration(sourcePath, current) : undefined;
  if (current && !gen) return { ok: false, error: "当前索引世代损坏" };
  const wantComplete = input.complete !== false;
  if (!upserts.length && !deletes.length) {
    if (!current) return { ok: true, generation: 0, sourceKey, complete: wantComplete, unchanged: true };
    if (!!gen.complete === wantComplete) {
      return { ok: true, generation: current, previous: top?.previous ?? undefined, sourceKey, complete: gen.complete, unchanged: true };
    }
  }
  const generation = current + 1;
  const docIds = [...deletes, ...upserts.map((u) => u.doc.docId)];
  const newTerms = upserts.flatMap((u) => (u.postings ?? []).map((p) => p.term));
  const loaded = await loadTouched(sourcePath, gen, docIds, newTerms);
  if (!loaded.ok) return loaded;
  const { docShards, termShards } = loaded;
  let docCount = gen?.docCount ?? 0;

  for (const id of deletes) {
    const b = bucketFor(id);
    const shard = docShards.get(b);
    const old = shard?.docs?.[id];
    if (!old) continue;
    removeDocPostings(termShards, old);
    delete shard.docs[id];
    shard.revision = generation;
    docCount -= 1;
  }
  for (const item of upserts) {
    const doc = item.doc;
    const b = bucketFor(doc.docId);
    let shard = docShards.get(b);
    if (!shard) {
      shard = { bucket: b, revision: generation, docs: dict() };
      docShards.set(b, shard);
    }
    const old = shard.docs[doc.docId];
    if (old) removeDocPostings(termShards, old);
    else docCount += 1;
    const terms = [...new Set((item.postings ?? []).map((p) => p.term))];
    shard.docs[doc.docId] = { ...doc, terms };
    shard.revision = generation;
    addDocPostings(termShards, shard.docs[doc.docId], item.postings ?? [], generation);
  }

  const docsRef = { ...(gen?.docs ?? {}) };
  const termsRef = { ...(gen?.terms ?? {}) };
  for (const [b, shard] of docShards) {
    if (Object.keys(shard.docs).length === 0) delete docsRef[String(b)];
    else if (shard.revision === generation) docsRef[String(b)] = generation;
  }
  for (const [b, shard] of termShards) {
    if (Object.keys(shard.terms).length === 0) delete termsRef[String(b)];
    else if (shard.revision === generation) termsRef[String(b)] = generation;
  }

  const wroteDocs = await writeChangedShards(sourcePath, "docs", docShards, generation, gen?.docs);
  if (!wroteDocs.ok) return wroteDocs;
  const wroteTerms = await writeChangedShards(sourcePath, "terms", termShards, generation, gen?.terms);
  if (!wroteTerms.ok) return wroteTerms;

  const generationManifest = {
    version: INDEX_VERSION,
    generation,
    sourceKey,
    createdAt: new Date().toISOString(),
    docs: docsRef,
    terms: termsRef,
    docCount,
    complete: input.complete !== false,
  };
  const published = await writeJsonAtomic(generationPath(sourcePath, generation), generationManifest);
  if (!published.ok) return published;
  return { ok: true, generation, previous: current || undefined, sourceKey, complete: generationManifest.complete };
}

export async function activateIndex(sourcePath, staged) {
  const top = {
    version: INDEX_VERSION,
    bucketCount: BUCKET_COUNT,
    sourceKey: staged.sourceKey,
    current: staged.generation,
    previous: staged.previous ?? null,
    updatedAt: new Date().toISOString(),
  };
  const published = await writeJsonAtomic(manifestPath(sourcePath), top);
  if (!published.ok) return published;
  await gcIndex(sourcePath, top);
  return { ok: true, generation: staged.generation };
}

export async function commitIndex(sourcePath, input) {
  const lock = await acquireIndexLock(sourcePath);
  if (!lock.ok) return lock;
  try {
    const staged = await stageIndex(sourcePath, input);
    if (!staged.ok) return staged;
    if (staged.unchanged) return { ok: true, generation: staged.generation };
    return await activateIndex(sourcePath, staged);
  } finally {
    await releaseIndexLock(sourcePath, lock.token);
  }
}

async function gcIndex(sourcePath, top) {
  const keepGens = new Set([top.current, top.previous].filter((n) => Number.isInteger(n)));
  const keepFiles = new Set([manifestPath(sourcePath), generationPath(sourcePath, top.current)]);
  if (Number.isInteger(top.previous)) keepFiles.add(generationPath(sourcePath, top.previous));
  for (const generation of keepGens) {
    const gen = await readGeneration(sourcePath, generation);
    if (!gen) continue;
    for (const [b, rev] of Object.entries(gen.docs ?? {})) keepFiles.add(shardPath(sourcePath, "docs", Number(b), rev));
    for (const [b, rev] of Object.entries(gen.terms ?? {})) keepFiles.add(shardPath(sourcePath, "terms", Number(b), rev));
  }
  for (const kind of ["docs", "terms", "manifests"]) {
    const dir = join(indexDir(sourcePath), kind);
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      if (keepFiles.has(p)) continue;
      if (name.startsWith(".")) continue;
      try { await unlink(p); } catch { /* ignore */ }
    }
  }
}
