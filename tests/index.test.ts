import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  acquireIndexLock,
  activateIndex,
  bucketFor,
  commitIndex,
  docIdFor,
  getDocs,
  getPostings,
  listDocIds,
  listDocs,
  manifestPath,
  processAlive,
  readGeneration,
  readTopManifest,
  releaseIndexLock,
  stageIndex,
} from "../lib/index-store.mjs";
import { searchRootIndex } from "../lib/retrieval.mjs";

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "pi-kb-idx-"));
  const source = join(dir, "notes");
  await mkdir(source);
  return { dir, source, sourceKey: "notes-key" };
}

function doc(sourceKey: string, relPath: string, extra: Record<string, unknown> = {}) {
  const docId = extra.docId as string ?? docIdFor(sourceKey, relPath);
  return {
    docId,
    relPath,
    kind: "original",
    title: extra.title ?? relPath,
    catalog: extra.catalog ?? [],
    sourceHash: extra.sourceHash ?? "h1",
    mtimeMs: extra.mtimeMs ?? 1,
    size: extra.size ?? 10,
  };
}

describe("index store", () => {
  it("assigns stable ids and 256 buckets", () => {
    const a = docIdFor("k", "插件/A.md");
    const b = docIdFor("k", "插件\\A.md");
    assert.equal(a, b);
    assert.notEqual(a, docIdFor("k", "插件/B.md"));
    assert.equal(bucketFor("离职") >= 0 && bucketFor("离职") < 256, true);
  });

  it("commits documents and looks up terms", async () => {
    const { source, sourceKey } = await vault();
    const d = doc(sourceKey, "a.md", { title: "搜索栏Searchbar" });
    const r = await commitIndex(source, {
      sourceKey,
      upserts: [{
        doc: d,
        postings: [
          { term: "searchbar", tf: 2, fields: ["title"], lines: [1] },
          { term: "或", tf: 1, fields: ["body"], lines: [7] },
        ],
      }],
    });
    assert.equal(r.ok, true);
    const found = await getDocs(source, [d.docId]);
    assert.equal(found.ok, true);
    assert.equal(found.docs.get(d.docId)?.title, "搜索栏Searchbar");
    const terms = await getPostings(source, ["searchbar", "或", "missing"]);
    assert.equal(terms.ok, true);
    assert.equal(terms.terms.get("searchbar")?.df, 1);
    assert.equal(terms.terms.get("或")?.postings[0].docId, d.docId);
    assert.equal(terms.terms.has("missing"), false);
  });

  it("indexes prototype-property terms", async () => {
    const { source, sourceKey } = await vault();
    const d = doc(sourceKey, "ctor.md", { title: "constructor" });
    const r = await commitIndex(source, {
      sourceKey,
      upserts: [{
        doc: d,
        postings: [
          { term: "constructor", tf: 1, fields: ["body"], lines: [1] },
          { term: "toString", tf: 1, fields: ["body"], lines: [2] },
        ],
      }],
    });
    assert.equal(r.ok, true);
    const terms = await getPostings(source, ["constructor", "toString"]);
    assert.equal(terms.ok, true);
    assert.equal(terms.terms.get("constructor")?.df, 1);
    assert.equal(terms.terms.get("toString")?.postings[0].docId, d.docId);
  });

  it("updates docs when a term record has no postings array", async () => {
    const { source, sourceKey } = await vault();
    const d = doc(sourceKey, "a.md", { title: "hello" });
    const first = await commitIndex(source, {
      sourceKey,
      upserts: [{ doc: d, postings: [{ term: "hello", tf: 1, fields: ["title"], lines: [1] }] }],
    });
    assert.equal(first.ok, true);
    const termDir = join(source, ".pi-kb/index/terms");
    for (const name of await readdir(termDir)) {
      if (!name.endsWith(".json")) continue;
      const p = join(termDir, name);
      const raw = JSON.parse(await readFile(p, "utf8"));
      if (!raw.terms) continue;
      for (const rec of Object.values(raw.terms) as { postings?: unknown }[]) delete rec.postings;
      await writeFile(p, `${JSON.stringify(raw)}\n`);
    }
    const second = await commitIndex(source, {
      sourceKey,
      upserts: [{ doc: d, postings: [{ term: "hello", tf: 1, fields: ["title"], lines: [1] }] }],
    });
    assert.equal(second.ok, true);
    const terms = await getPostings(source, ["hello"]);
    assert.equal(terms.ok, true);
    assert.equal(terms.ok && terms.terms.get("hello")?.df, 1);
  });

  it("updates terms, deletes docs, and reuses unchanged shards", async () => {
    const { source, sourceKey } = await vault();
    let aRel = "a.md";
    let bRel = "b.md";
    while (bucketFor(docIdFor(sourceKey, aRel)) === bucketFor(docIdFor(sourceKey, bRel))) bRel = `x${bRel}`;
    const a = doc(sourceKey, aRel, { title: "A" });
    const b = doc(sourceKey, bRel, { title: "B" });
    await commitIndex(source, {
      sourceKey,
      upserts: [
        { doc: a, postings: [{ term: "alpha", tf: 1, fields: ["body"], lines: [1] }] },
        { doc: b, postings: [{ term: "beta", tf: 1, fields: ["body"], lines: [1] }] },
      ],
    });
    const first = await readTopManifest(source);
    const gen1 = await readGeneration(source, first!.current);
    const aBucket = String(bucketFor(a.docId));
    await commitIndex(source, {
      sourceKey,
      upserts: [{
        doc: { ...b, sourceHash: "h2" },
        postings: [{ term: "gamma", tf: 1, fields: ["body"], lines: [2] }],
      }],
    });
    const second = await readTopManifest(source);
    const gen2 = await readGeneration(source, second!.current);
    if (gen1!.docs[aBucket] !== undefined) {
      assert.equal(gen2!.docs[aBucket], gen1!.docs[aBucket]);
    }
    const gone = await getPostings(source, ["beta", "gamma"]);
    assert.equal(gone.terms.has("beta"), false);
    assert.equal(gone.terms.get("gamma")?.df, 1);
    await commitIndex(source, { sourceKey, deletes: [a.docId] });
    const ids = await listDocIds(source);
    assert.deepEqual(ids.ids.sort(), [b.docId]);
    const alpha = await getPostings(source, ["alpha"]);
    assert.equal(alpha.terms.has("alpha"), false);
  });

  it("keeps the old generation if the pointer is not activated", async () => {
    const { source, sourceKey } = await vault();
    const a = doc(sourceKey, "a.md", { title: "old" });
    await commitIndex(source, {
      sourceKey,
      upserts: [{ doc: a, postings: [{ term: "old", tf: 1, fields: ["body"], lines: [1] }] }],
    });
    const staged = await stageIndex(source, {
      sourceKey,
      upserts: [{
        doc: { ...a, title: "new", sourceHash: "h2" },
        postings: [{ term: "new", tf: 1, fields: ["body"], lines: [1] }],
      }],
    });
    assert.equal(staged.ok, true);
    const visible = await getDocs(source, [a.docId]);
    assert.equal(visible.docs.get(a.docId)?.title, "old");
    const terms = await getPostings(source, ["old", "new"]);
    assert.equal(terms.terms.has("old"), true);
    assert.equal(terms.terms.has("new"), false);
    await activateIndex(source, staged);
    const after = await getDocs(source, [a.docId]);
    assert.equal(after.docs.get(a.docId)?.title, "new");
  });

  it("does not treat a missing generation as an empty complete index", async () => {
    const { source, sourceKey } = await vault();
    const a = doc(sourceKey, "a.md");
    await commitIndex(source, {
      sourceKey,
      upserts: [{ doc: a, postings: [{ term: "x", tf: 1, fields: ["body"], lines: [1] }] }],
    });
    const top = await readTopManifest(source);
    await writeFile(join(source, ".pi-kb", "index", "manifests", `${top!.current}.json`), "{not-json");
    const docs = await getDocs(source, [a.docId]);
    assert.equal(docs.ok, false);
  });

  it("rejects a second lock and recovers a dead owner", async () => {
    const { source } = await vault();
    const first = await acquireIndexLock(source);
    assert.equal(first.ok, true);
    const second = await acquireIndexLock(source);
    assert.equal(second.ok, false);
    await releaseIndexLock(source, first.token);
    const again = await acquireIndexLock(source);
    assert.equal(again.ok, true);
    await releaseIndexLock(source, again.token);

    const stalePath = join(source, ".pi-kb", "index.lock");
    await mkdir(join(source, ".pi-kb"), { recursive: true });
    await writeFile(stalePath, JSON.stringify({ pid: 2147483647, token: "dead", host: (await import("node:os")).hostname() }));
    assert.equal(processAlive(process.pid), true);
    const recovered = await acquireIndexLock(source);
    assert.equal(recovered.ok, true);
    await releaseIndexLock(source, recovered.token);
  });

  it("reads a pinned previous generation", async () => {
    const { source, sourceKey } = await vault();
    const a = doc(sourceKey, "a.md", { title: "old", sourceHash: "h1" });
    await commitIndex(source, {
      sourceKey,
      upserts: [{ doc: a, postings: [{ term: "old", tf: 1, fields: ["body"], lines: [1] }] }],
    });
    const first = await readTopManifest(source);
    await commitIndex(source, {
      sourceKey,
      upserts: [{
        doc: { ...a, title: "new", sourceHash: "h2" },
        postings: [{ term: "new", tf: 1, fields: ["body"], lines: [1] }],
      }],
    });
    const pinned = await getDocs(source, [a.docId], first!.current);
    assert.equal(pinned.ok, true);
    assert.equal(pinned.generation, first!.current);
    assert.equal(pinned.docs.get(a.docId)?.title, "old");
    const listed = await listDocs(source, first!.current);
    assert.equal(listed.docs.get(a.docId)?.title, "old");
  });

  it("scoped search does not let other docs fill candidates", async () => {
    const { source, sourceKey } = await vault();
    const upserts = [];
    for (let i = 0; i < 200; i++) {
      const rel = `b/${i}.md`;
      upserts.push({
        doc: doc(sourceKey, rel, { title: `B${i}`, sourceHash: `b${i}` }),
        postings: [{ term: "api", tf: 20, fields: ["body"], lines: [1] }],
      });
    }
    const a = doc(sourceKey, "a/correct.md", { title: "A正确", sourceHash: "a1" });
    upserts.push({
      doc: a,
      postings: [{ term: "api", tf: 1, fields: ["body"], lines: [1] }],
    });
    const committed = await commitIndex(source, { sourceKey, upserts });
    assert.equal(committed.ok, true);
    const open = await searchRootIndex(source, "api", { limit: 1 });
    assert.equal(open.ok, true);
    assert.notEqual(open.hits[0]?.docId, a.docId);
    const scoped = await searchRootIndex(source, "api", { limit: 1, visibleIds: new Set([a.docId]) });
    assert.equal(scoped.ok, true);
    assert.equal(scoped.hits.length, 1);
    assert.equal(scoped.hits[0].docId, a.docId);
    assert.equal(scoped.nDocs, 1);
    assert.equal(scoped.hits[0].relPath, "a/correct.md");
  });
});
