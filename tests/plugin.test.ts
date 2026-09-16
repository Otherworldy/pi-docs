import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createKbExtension } from "../extensions/index.ts";
import { sha256 } from "../lib/kb.ts";

type Handler = (event: any, ctx: any) => any;

function mockPi() {
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const notifies: string[] = [];
  const pi = {
    on(name: string, fn: Handler) {
      handlers[name] = fn;
    },
    registerTool(def: any) {
      tools[def.name] = def;
    },
    registerCommand(name: string, def: any) {
      commands[name] = def;
    },
  };
  const ctx = {
    cwd: "/proj",
    hasUI: true,
    ui: { notify: (t: string) => notifies.push(t) },
  };
  return { pi, handlers, tools, commands, ctx, notifies };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-kb-ext-"));
  const notes = join(dir, "notes");
  const agent = join(notes, "agent");
  await mkdir(join(notes, "插件"), { recursive: true });
  const src = join(notes, "插件/selectCompare.md");
  const body = "headerField 默认是 person\n";
  await writeFile(src, body);
  const configPath = join(dir, "pi-kb.json");
  await writeFile(configPath, JSON.stringify({
    roots: [
      { name: "notes", path: notes },
      { name: "agent", path: agent, writable: true },
    ],
  }));
  const { pi, handlers, tools, commands, ctx, notifies } = mockPi();
  createKbExtension({ configPath })(pi as any);
  await handlers.session_start({}, ctx);
  return { dir, notes, agent, src, body, handlers, tools, commands, ctx, notifies };
}

describe("pi extension", () => {
  it("loads tools, /kb, and policy without crashing without UI", async () => {
    const { tools, commands, handlers, ctx } = await setup();
    assert.ok(tools.kb_search);
    assert.ok(tools.kb_write);
    assert.ok(commands.kb);
    const prompt = await handlers.before_agent_start({ systemPrompt: "BASE", prompt: "hi" }, ctx);
    assert.match(prompt.systemPrompt, /BASE/);
    assert.match(prompt.systemPrompt, /kb_search/);
    ctx.hasUI = false;
    await commands.kb.handler("", ctx);
  });

  it("kb_search finds originals then digest after write", async () => {
    const { tools, src, body, ctx } = await setup();
    const found = await tools.kb_search.execute("1", { query: "headerField" }, undefined, undefined, ctx);
    assert.equal(found.isError, undefined);
    assert.match(found.content[0].text, /selectCompare/);
    assert.match(found.content[0].text, /originalsSearched: true/);
  });

  it("complete original read issues readRef; truncated/partial does not; AI notes do not recurse", async () => {
    const { tools, handlers, src, body, ctx, agent } = await setup();
    const id = "call-1";
    await handlers.tool_call({ toolName: "read", toolCallId: id, input: { path: src } }, ctx);
    const full = await handlers.tool_result({
      toolName: "read",
      toolCallId: id,
      isError: false,
      content: [{ type: "text", text: body }],
      details: {},
    }, ctx);
    assert.match(full.content.at(-1).text, /readRef=/);
    const readRef = /readRef=([0-9a-f-]+)/.exec(full.content.at(-1).text)![1];

    const truncId = "call-2";
    await handlers.tool_call({ toolName: "read", toolCallId: truncId, input: { path: src, limit: 1 } }, ctx);
    const trunc = await handlers.tool_result({
      toolName: "read",
      toolCallId: truncId,
      isError: false,
      content: [{ type: "text", text: "headerField 默认是 person" }],
      details: { truncation: { truncated: true } },
    }, ctx);
    assert.equal(trunc, undefined);

    const written = await tools.kb_write.execute("w", {
      title: "selectCompare",
      body: "默认 headerField 是 person。",
      readRef,
    }, undefined, undefined, ctx);
    assert.doesNotMatch(written.content[0].text, /Error/);
    assert.match(written.content[0].text, /digest/);

    const search = await tools.kb_search.execute("2", { query: "headerField" }, undefined, undefined, ctx);
    assert.match(search.content[0].text, /originalsSearched: false/);

    const digestPath = written.content[0].text.split(/\s+/).at(-1);
    const dId = "call-3";
    await handlers.tool_call({ toolName: "read", toolCallId: dId, input: { path: digestPath } }, ctx);
    const nested = await handlers.tool_result({
      toolName: "read",
      toolCallId: dId,
      isError: false,
      content: [{ type: "text", text: await readFile(digestPath, "utf8") }],
      details: {},
    }, ctx);
    assert.equal(nested, undefined);

    const stale = await tools.kb_write.execute("w2", {
      title: "x",
      body: "y",
      readRef: "not-a-ref",
    }, undefined, undefined, ctx);
    assert.equal(stale.isError, true);

    await handlers.session_start({}, ctx);
    const afterReload = await tools.kb_write.execute("w3", {
      title: "x",
      body: "y",
      readRef,
    }, undefined, undefined, ctx);
    assert.equal(afterReload.isError, true);
  });

  it("hash mismatch after read does not issue readRef", async () => {
    const { handlers, src, ctx } = await setup();
    const id = "call-x";
    await handlers.tool_call({ toolName: "read", toolCallId: id, input: { path: src } }, ctx);
    await writeFile(src, "changed " + sha256("x"));
    const res = await handlers.tool_result({
      toolName: "read",
      toolCallId: id,
      isError: false,
      content: [{ type: "text", text: "headerField 默认是 person\n" }],
      details: {},
    }, ctx);
    assert.equal(res, undefined);
  });

  it("missing config does not crash tools", async () => {
    const { pi, handlers, tools, ctx } = mockPi();
    createKbExtension({ configPath: join(tmpdir(), "missing-pi-kb.json") })(pi as any);
    await handlers.session_start({}, ctx);
    const prompt = await handlers.before_agent_start({ systemPrompt: "B" }, ctx);
    assert.match(prompt.systemPrompt, /配置不可用/);
    const r = await tools.kb_search.execute("1", { query: "x" }, undefined, undefined, ctx);
    assert.equal(r.isError, true);
  });
});
