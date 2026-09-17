import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  manifestPath,
  processAlive,
  readGeneration,
  readTopManifest,
  releaseIndexLock,
  stageIndex,
} from "../lib/index-store.mjs";

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
});
