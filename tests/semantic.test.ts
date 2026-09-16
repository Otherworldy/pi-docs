import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { loadConfigFile, searchKb, type EnrichSettings } from "../lib/kb.ts";
import {
  splitChunks,
  startEnrichment,
  validateModelOutput,
  type ModelComplete,
} from "../lib/semantic.ts";

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const enrich: EnrichSettings = {
  provider: "test",
  model: "fake",
  maxOutputTokens: 256,
  timeoutMs: 5000,
};

describe("semantic", () => {
  it("rejects out-of-range evidence and accepts matching excerpts", () => {
    const doc = {
      path: "/n/a.md",
      relPath: "a.md",
      title: "t",
      catalog: [],
      sourceHash: "h",
      lines: ["条件是与关系", "不支持或"],
    };
    const bad = validateModelOutput({
      summary: "x",
      topics: [],
      aliases: [],
      questions: [],
      rules: [{ text: "or", startLine: 1, endLine: 1, excerpt: "不存在" }],
    }, doc, 1, 2);
    assert.equal("ok" in bad && bad.ok === false, true);
    const good = validateModelOutput({
      summary: "筛选",
      topics: ["Searchbar"],
      aliases: ["搜索栏"],
      questions: ["几个条件满足一个是否可以"],
      rules: [{ text: "AND", startLine: 2, endLine: 2, excerpt: "不支持或" }],
    }, doc, 1, 2);
    assert.equal("ok" in good, false);
  });

  it("splits long documents into covering chunks", () => {
    const lines = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `# h${i}` : "x".repeat(80)));
    const ranges = splitChunks({
      path: "/n/long.md",
      relPath: "long.md",
      title: "long",
      catalog: [],
      sourceHash: "h",
      lines,
    });
    assert.ok(ranges.length > 1);
    assert.equal(ranges[0].startLine, 1);
    assert.equal(ranges.at(-1)?.endLine, 400);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].startLine, ranges[i - 1].endLine + 1);
  });

  it("rule-only search does not call the model; aliases can match after enrich", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-sem-"));
    const notes = join(dir, "notes");
    await write(join(notes, "bar.md"), "搜索栏的所有条件之间是与关系，不支持或的关系\n");
    const configPath = join(dir, "pi-kb.json");
    await writeFile(configPath, JSON.stringify({
      roots: [{ name: "notes", path: notes }],
      enrich,
    }));
    const loaded = await loadConfigFile(configPath);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    let calls = 0;
    const miss = await searchKb(loaded, "几个条件 满足一个");
    assert.equal(miss.ok, true);
    if (!miss.ok) return;
    assert.equal(miss.hits.length, 0);
    assert.equal(calls, 0);

    const complete: ModelComplete = async () => {
      calls += 1;
      return {
        text: JSON.stringify({
          summary: "筛选条件全部 AND",
          topics: ["Searchbar"],
          aliases: ["搜索栏"],
          questions: ["几个条件满足一个是否可以"],
          rules: [{ text: "条件之间是与关系，不支持或", startLine: 1, endLine: 1, excerpt: "不支持或的关系" }],
        }),
        inputTokens: 10,
        outputTokens: 8,
      };
    };
    const status = await startEnrichment(loaded, "notes", complete);
    assert.match(status, /全量完成|1\/1/);
    assert.equal(calls, 1);
    const hit = await searchKb(loaded, "几个条件 满足一个", { root: "notes" });
    assert.equal(hit.ok, true);
    if (!hit.ok) return;
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].semanticMatch, true);
    assert.match(hit.hits[0].semanticEvidence ?? "", /几个条件满足一个/);
    await write(join(notes, "bar.md"), "正文已改，不再包含旧条件\n");
    const stale = await searchKb(loaded, "几个条件 满足一个", { root: "notes" });
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    assert.equal(stale.hits.length, 0);
  });

  it("invalid json fails the chunk; resume does not recall completed chunks; budget pauses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-sem2-"));
    const notes = join(dir, "notes");
    await write(join(notes, "a.md"), "alpha-token\\n");
    await write(join(notes, "b.md"), "beta-token\\n");
    const configPath = join(dir, "pi-kb.json");
    await writeFile(configPath, JSON.stringify({ roots: [{ name: "notes", path: notes }], enrich }));
    const loaded = await loadConfigFile(configPath);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    let calls = 0;
    const flaky: ModelComplete = async ({ user }) => {
      calls += 1;
      if (user.includes("alpha-token") && calls < 3) return { text: "not-json", inputTokens: 1, outputTokens: 1 };
      const token = user.includes("beta-token") ? "beta-token" : "alpha-token";
      return {
        text: JSON.stringify({
          summary: token,
          topics: [token],
          aliases: [],
          questions: [],
          rules: [{ text: token, startLine: 1, endLine: 1, excerpt: token }],
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const seen = new Set<string>();
    const counting: ModelComplete = async ({ user }) => {
      const token = user.includes("beta-token") ? "beta" : "alpha";
      seen.add(token);
      calls += 1;
      return {
        text: JSON.stringify({
          summary: token,
          topics: [token],
          aliases: [],
          questions: [],
          rules: [{ text: token, startLine: 1, endLine: 1, excerpt: `${token}-token` }],
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    await startEnrichment(loaded, "notes", flaky);
    assert.ok(calls >= 2);
    const after = calls;
    await startEnrichment(loaded, "notes", counting);
    assert.equal(seen.has("beta"), false);
    assert.ok(calls > after);

    const paused = await startEnrichment(loaded, "notes", async () => ({ text: "x", inputTokens: 1, outputTokens: 1, costUnknown: true }), { maxRequests: 0 });
    assert.match(paused, /部分完成|请求/);
  });

  it("enriches a writable vault", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-semw-"));
    const notes = join(dir, "notes");
    await write(join(notes, "bar.md"), "搜索栏的所有条件之间是与关系，不支持或的关系\n");
    await write(join(notes, "digests/x.md"), "digest-only\n");
    const configPath = join(dir, "pi-kb.json");
    await writeFile(configPath, JSON.stringify({
      roots: [{ name: "notes", path: notes, writable: true }],
      enrich,
    }));
    const loaded = await loadConfigFile(configPath);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    let calls = 0;
    const complete: ModelComplete = async () => {
      calls += 1;
      return {
        text: JSON.stringify({
          summary: "AND",
          topics: ["Searchbar"],
          aliases: [],
          questions: ["几个条件满足一个是否可以"],
          rules: [{ text: "AND", startLine: 1, endLine: 1, excerpt: "不支持或的关系" }],
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const status = await startEnrichment(loaded, "notes", complete);
    assert.match(status, /全量完成|1\/1/);
    assert.equal(calls, 1);
    const hit = await searchKb(loaded, "几个条件 满足一个", { root: "notes" });
    assert.equal(hit.ok, true);
    if (!hit.ok) return;
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].kind, "original");
  });
});
