import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { indexRoot } from "../lib/collect.mjs";
import { getPostings, listDocIds } from "../lib/index-store.mjs";
import { postingsForDoc } from "../lib/retrieval.mjs";

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("collect and tokens", () => {
  it("indexes Chinese bigrams and code identifiers", () => {
    const posts = postingsForDoc({
      relPath: "插件/selectCompare.md",
      title: "selectCompare 注意项",
      catalog: ["平台"],
      lines: ["headerField 默认 person", "盘点要传 observed.FullName", "不支持或"],
    });
    const terms = new Set(posts.map((p) => p.term));
    assert.equal(terms.has("离职"), false);
    assert.equal(terms.has("或"), true);
    assert.equal(terms.has("不支"), true);
    assert.equal(terms.has("selectcompare"), true);
    assert.equal(terms.has("headerfield"), true);
    assert.equal(terms.has("observed.fullname"), true);
    assert.equal(terms.has("fullname"), true);
  });

  it("indexes a vault, skips unchanged files, and drops deletes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-col-"));
    const notes = join(dir, "notes");
    await write(join(notes, "插件/selectCompare.md"), "headerField 默认 person\n");
    await write(join(notes, "done/old.md"), "gone soon\n");
    const first = await indexRoot({ sourcePath: notes, sourceKey: "n", exclude: ["done"] });
    assert.equal(first.ok, true);
    assert.equal(first.state, "ready");
    assert.ok(first.updated >= 1);
    const terms = await getPostings(notes, ["headerfield"]);
    assert.equal(terms.terms.get("headerfield")?.df, 1);
    const second = await indexRoot({ sourcePath: notes, sourceKey: "n", exclude: ["done"] });
    assert.equal(second.ok, true);
    assert.equal(second.updated, 0);
    await write(join(notes, "插件/selectCompare.md"), "headerField 改为 observed.FullName\n");
    const now = new Date(Date.now() + 2000);
    await utimes(join(notes, "插件/selectCompare.md"), now, now);
    const third = await indexRoot({ sourcePath: notes, sourceKey: "n", exclude: ["done"] });
    assert.equal(third.updated, 1);
    const after = await getPostings(notes, ["observed.fullname", "headerfield"]);
    assert.equal(after.terms.has("observed.fullname"), true);
    await write(join(notes, "prefix_readme.md"), "搜索栏Searchbar —— prefix_aaa.md\n");
    await write(join(notes, "prefix_aaa.md"), "条件之间是与\n");
    const mapped = await indexRoot({ sourcePath: notes, sourceKey: "n", exclude: ["done"] });
    assert.equal(mapped.ok, true);
    const ids = await listDocIds(notes);
    assert.equal(ids.ok, true);
    assert.ok(ids.ids.length >= 2);
  });
});
