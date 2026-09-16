import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  applyRootChange,
  configureKbInteractive,
  decodeEntities,
  digestFileName,
  excluded,
  findSecretKind,
  loadConfigFile,
  parseConfigJson,
  pathInside,
  pathKey,
  saveConfigFile,
  searchKb,
  sha256,
  writeDigest,
  writeLesson,
  type LoadedConfig,
} from "../lib/kb.ts";

async function tmp() {
  return mkdtemp(join(tmpdir(), "pi-kb-"));
}

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function cfg(dir: string, roots: unknown[]) {
  const configPath = join(dir, "pi-kb.json");
  await writeFile(configPath, JSON.stringify({ roots }));
  return loadConfigFile(configPath);
}

describe("config", () => {
  it("rejects relative paths, duplicate names, two writable roots", () => {
    assert.equal(parseConfigJson({ roots: [{ name: "a", path: "rel" }] }).ok, false);
    assert.equal(parseConfigJson({
      roots: [
        { name: "a", path: "/x", writable: true },
        { name: "a", path: "/y" },
      ],
    }).ok, false);
    assert.equal(parseConfigJson({
      roots: [
        { name: "a", path: "/x", writable: true },
        { name: "b", path: "/y", writable: true },
      ],
    }).ok, false);
  });

  it("accepts zero writable roots and ~/", () => {
    const ok = parseConfigJson({ roots: [{ name: "notes", path: "~/vault" }] });
    assert.equal(ok.ok, true);
  });

  it("missing config is a soft error", async () => {
    const loaded = await loadConfigFile("/no/such/pi-kb.json");
    assert.equal(loaded.ok, false);
    assert.match(loaded.error, /不存在/);
  });

  it("expands ~ and allows missing writable dir", async () => {
    const dir = await tmp();
    const notes = join(dir, "notes");
    await mkdir(notes);
    const loaded = await cfg(dir, [
      { name: "notes", path: notes },
      { name: "agent", path: join(dir, "notes", "agent"), writable: true },
    ]);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.roots[0].exists, true);
    assert.equal(loaded.writable?.exists, false);
    assert.equal(loaded.writable?.name, "agent");
  });

  it("pathInside does not treat /vault-evil as inside /vault", () => {
    assert.equal(pathInside("/vault/a.md", "/vault"), true);
    assert.equal(pathInside("/vault-evil/a.md", "/vault"), false);
  });

  it("Windows pathInside is case-insensitive and rejects prefix siblings", () => {
    assert.equal(pathInside("C:\\vault\\a.md", "C:\\vault", "win32"), true);
    assert.equal(pathInside("c:\\vault\\a.md", "C:\\Vault", "win32"), true);
    assert.equal(pathInside("C:\\vault-evil\\a.md", "C:\\vault", "win32"), false);
  });

  it("Windows pathKey / digest names ignore case and slash style", () => {
    assert.equal(pathKey("C:\\Notes\\A.md", "win32"), pathKey("c:/notes/a.md", "win32"));
    assert.equal(
      digestFileName("C:\\Notes\\A.md", "abc", "win32"),
      digestFileName("c:/notes/a.md", "abc", "win32"),
    );
  });

  it("applyRootChange add/remove/setWritable", () => {
    const added = applyRootChange([], { op: "add", name: "notes", path: "/vault", writable: true });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    const second = applyRootChange(added.roots, { op: "add", name: "agent", path: "/vault/agent", writable: true });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.roots.filter((r) => r.writable).length, 1);
    assert.equal(second.roots.find((r) => r.name === "agent")?.writable, true);
    const removed = applyRootChange(second.roots, { op: "remove", name: "notes" });
    assert.equal(removed.ok, true);
    if (!removed.ok) return;
    assert.equal(removed.roots.length, 1);
    const rel = applyRootChange([], { op: "add", name: "x", path: "rel" });
    assert.equal(rel.ok, false);
  });

  it("saveConfigFile round-trips and interactive add creates config", async () => {
    const dir = await tmp();
    const notes = join(dir, "notes");
    await mkdir(notes);
    const configPath = join(dir, "pi-kb.json");
    const saved = await saveConfigFile(configPath, [{ name: "notes", path: notes, writable: true }]);
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.writable?.name, "notes");

    const other = join(dir, "other");
    await mkdir(other);
    const selects = ["添加目录", "完成"];
    const inputs = ["docs", other];
    const ui = {
      select: async () => selects.shift(),
      input: async () => inputs.shift(),
      confirm: async () => false,
      notify() {},
    };
    const loaded = await configureKbInteractive(configPath, ui);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.roots.length, 2);
    assert.equal(loaded.roots.some((r) => r.name === "docs"), true);
    assert.equal(loaded.writable?.name, "notes");
  });

  it("exclude matches path segments, not prefixes", () => {
    assert.equal(excluded("日志/x.md", ["日志"]), true);
    assert.equal(excluded("日志\\x.md", ["日志"]), true);
    assert.equal(excluded("done/todo 1.md", ["done/todo 1.md"]), true);
    assert.equal(excluded("done-extra/x.md", ["done"]), false);
  });
});

describe("entities", () => {
  it("decodes named, decimal, hex once", () => {
    assert.equal(decodeEntities("headerField: &#39;observed.FullName&#39;"), "headerField: 'observed.FullName'");
    assert.equal(decodeEntities("=== &#34;已添加&#34;"), '=== "已添加"');
    assert.equal(decodeEntities("A &#x26; B"), "A & B");
    assert.equal(decodeEntities("&amp;lt;"), "&lt;");
    assert.equal(decodeEntities("&#999999999;"), "&#999999999;");
  });
});

describe("search", () => {
  async function fixture() {
    const dir = await tmp();
    const notes = join(dir, "notes");
    const agent = join(notes, "agent");
    await write(join(notes, "插件/selectCompare/selectCompare 注意项.md"), "headerField 默认是person. 盘点中用到 要传 headerField: &#39;observed.FullName&#39;\n");
    await write(join(notes, "插件/已添加的不可选.md"), 'if (rowData.Added === &#34;已添加&#34;) {\n  const x = 1 < 2;\n}\n<script>keep()</script>\n');
    await write(join(notes, "日志/吉林麻将.md"), "胡的话一定要有一个大叉\n");
    await write(join(notes, "done/secret-name.md"), "selectCompare 不该出现如果被 exclude\n");
    const loaded = await cfg(dir, [
      { name: "notes", path: notes, exclude: ["done"] },
      { name: "agent", path: agent, writable: true },
    ]);
    assert.equal(loaded.ok, true);
    return { dir, notes, agent, loaded: loaded as Extract<LoadedConfig, { ok: true }> };
  }

  it("hits Chinese + identifier via path and body, case-insensitive", async () => {
    const { loaded } = await fixture();
    const r = await searchKb(loaded, "selectCompare headerField");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.originalsSearched, true);
    assert.ok(r.hits.some((h) => h.path.includes("selectCompare")));
  });

  it("CRLF notes still match keywords and keep line numbers", async () => {
    const dir = await tmp();
    const notes = join(dir, "n");
    await write(join(notes, "win.md"), "headerField\r\nobserved.FullName\r\n");
    const loaded = await cfg(dir, [{ name: "notes", path: notes }]);
    const r = await searchKb(loaded, "observed.FullName");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hits[0].snippets[0].line, 2);
    assert.equal(r.hits[0].snippets[0].text.includes("\r"), false);
  });

  it("quoted query hits entity-encoded source and keeps script/line numbers", async () => {
    const { loaded } = await fixture();
    const r = await searchKb(loaded, 'rowData.Added === "已添加"');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const hit = r.hits.find((h) => h.path.includes("已添加"));
    assert.ok(hit);
    assert.equal(hit!.snippets[0].line, 1);
    assert.match(hit!.snippets[0].text, /"/);
    const r2 = await searchKb(loaded, "keep()");
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.ok(r2.hits.some((h) => h.snippets.some((s) => s.text.includes("<script>"))));
  });

  it("does not resurrect excluded files via nested writable root", async () => {
    const { loaded } = await fixture();
    const r = await searchKb(loaded, "不该出现");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hits.length, 0);
  });

  it("unknown root errors; missing readonly errors; missing writable is empty", async () => {
    const { loaded } = await fixture();
    const bad = await searchKb(loaded, "x", { root: "nope" });
    assert.equal(bad.ok, false);
    const empty = await searchKb(loaded, "anything", { root: "agent" });
    assert.equal(empty.ok, true);
    if (!empty.ok) return;
    assert.equal(empty.hits.length, 0);
    assert.equal(empty.originalsSearched, false);
  });

  it("skips symlink files/dirs and prefix-named sibling dirs", async () => {
    const dir = await tmp();
    const notes = join(dir, "vault");
    await write(join(notes, "ok.md"), "needle-token inside");
    await mkdir(join(dir, "vault-evil"));
    await write(join(dir, "vault-evil/trap.md"), "needle-token trap");
    await symlink(join(dir, "vault-evil/trap.md"), join(notes, "link.md"));
    const loaded = await cfg(dir, [{ name: "notes", path: notes }]);
    const r = await searchKb(loaded, "needle-token");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hits.length, 1);
    assert.ok(r.hits[0].path.endsWith("ok.md"));
  });

  it("reports skip for too-large and non-utf8 rather than zero-hit", async () => {
    const dir = await tmp();
    const notes = join(dir, "n");
    await write(join(notes, "big.md"), "x".repeat(1024 * 1024 + 10));
    await writeFile(join(notes, "bin.md"), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    await write(join(notes, "hit.md"), "keep-me");
    const loaded = await cfg(dir, [{ name: "notes", path: notes }]);
    const r = await searchKb(loaded, "keep-me");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hits.length, 1);
    assert.ok(r.skipped >= 2);
    assert.ok(r.skipReasons.length > 0);
  });
});

describe("ai-first search and write", () => {
  async function vault() {
    const dir = await tmp();
    const notes = join(dir, "notes");
    const agent = join(notes, "agent");
    await write(join(notes, "插件/selectCompare.md"), "headerField 默认 person\n");
    const loaded = await cfg(dir, [
      { name: "notes", path: notes },
      { name: "agent", path: agent, writable: true },
    ]);
    assert.equal(loaded.ok, true);
    return { dir, notes, agent, loaded: loaded as Extract<LoadedConfig, { ok: true }> };
  }

  it("prefers usable digest and does not search originals", async () => {
    const { notes, loaded } = await vault();
    const src = await realpath(join(notes, "插件/selectCompare.md"));
    const buf = Buffer.from("headerField 默认 person\n");
    const ref = { id: "r1", sourcePath: src, sourceHash: sha256(buf), sourceTitle: "selectCompare" };
    const w = await writeDigest(loaded, {
      title: "selectCompare 字段",
      body: "默认 headerField 是 person。",
      cwd: "/proj",
      ref,
    });
    assert.equal(w.ok, true);
    const r = await searchKb(loaded, "headerField");
    assert.equal(r.ok, true);
    if (!r.ok || !w.ok) return;
    assert.equal(r.originalsSearched, false);
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].kind, "digest");
    assert.equal(r.hits[0].sourceStatus, "unchanged");
    assert.equal(r.hits[0].path, w.path);
  });

  it("falls back to originals when digest source changed", async () => {
    const { notes, loaded } = await vault();
    const src = await realpath(join(notes, "插件/selectCompare.md"));
    const ref = { id: "r1", sourcePath: src, sourceHash: sha256(Buffer.from("headerField 默认 person\n")), sourceTitle: "selectCompare" };
    await writeDigest(loaded, { title: "old", body: "旧整理 headerField", cwd: "/p", ref });
    await writeFile(src, "headerField 已改为 observed.FullName\n");
    const r = await searchKb(loaded, "headerField");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.originalsSearched, true);
    assert.ok(r.hits.every((h) => h.kind === "original"));
    assert.ok(r.hits.some((h) => h.snippets.some((s) => s.text.includes("observed.FullName"))));
  });

  it("forced original root skips nested agent notes", async () => {
    const { notes, loaded } = await vault();
    const src = await realpath(join(notes, "插件/selectCompare.md"));
    const ref = { id: "r1", sourcePath: src, sourceHash: sha256(Buffer.from("headerField 默认 person\n")), sourceTitle: "selectCompare" };
    await writeDigest(loaded, { title: "d", body: "digest-only-token headerField", cwd: "/p", ref });
    const r = await searchKb(loaded, "digest-only-token", { root: "notes" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hits.length, 0);
  });

  it("writeDigest is idempotent and concurrent-safe; original file unchanged", async () => {
    const { notes, loaded } = await vault();
    const src = await realpath(join(notes, "插件/selectCompare.md"));
    const before = "headerField 默认 person\n";
    const ref = { id: "r1", sourcePath: src, sourceHash: sha256(Buffer.from(before)), sourceTitle: "selectCompare" };
    const [a, b] = await Promise.all([
      writeDigest(loaded, { title: "A", body: "一次整理 headerField", cwd: "/p", ref }),
      writeDigest(loaded, { title: "B", body: "二次整理 headerField", cwd: "/p", ref }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(a.path, b.path);
    assert.ok([a.status, b.status].includes("created"));
    assert.ok([a.status, b.status].includes("already_exists") || a.status === b.status);
    const again = await writeDigest(loaded, { title: "C", body: "三次", cwd: "/p", ref });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.status, "already_exists");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(src, "utf8"), before);
  });

  it("rejects digest after source change; writes lessons only under agent/lessons", async () => {
    const { notes, loaded } = await vault();
    const src = await realpath(join(notes, "插件/selectCompare.md"));
    const ref = { id: "r1", sourcePath: src, sourceHash: sha256(Buffer.from("headerField 默认 person\n")), sourceTitle: "x" };
    await writeFile(src, "changed\n");
    const bad = await writeDigest(loaded, { title: "x", body: "body", cwd: "/p", ref });
    assert.equal(bad.ok, false);
    const lesson = await writeLesson(loaded, { title: "坑", body: "验证过 headerField 要用 observed", cwd: "/proj" });
    assert.equal(lesson.ok, true);
    if (!lesson.ok) return;
    assert.match(lesson.path, /\/lessons\/\d{4}-\d{2}-\d{2}-.+\.md$/);
    const r = await searchKb(loaded, "observed");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hits[0].kind, "lesson");
  });

  it("secret scanner blocks labeled secrets without echoing them", () => {
    assert.equal(findSecretKind("-----BEGIN PRIVATE KEY-----\nabc"), "private-key");
    assert.equal(findSecretKind('password: "hunter2xx"'), "labeled-secret");
    assert.equal(findSecretKind("api_key: YOUR_KEY"), null);
    const err = findSecretKind("sk-abcdefghijklmnopqrstuvwxyz123456");
    assert.equal(err, "api-token");
  });

  it("writeLesson rejects secrets", async () => {
    const { loaded } = await vault();
    const w = await writeLesson(loaded, {
      title: "leak",
      body: "token sk-abcdefghijklmnopqrstuvwxyz123456",
      cwd: "/p",
    });
    assert.equal(w.ok, false);
    if (w.ok) return;
    assert.doesNotMatch(w.error, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  });
});
