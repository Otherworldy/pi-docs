import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createKbRuntime, workerFileUrl } from "../lib/kb-worker.mjs";
import { digestFileName, extractNoteTitle, parseShowDocReadme, pathKey } from "../lib/source.mjs";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const node22 = "/root/.nvm/versions/node/v22.19.0/bin/node";
const piBin = "/root/.nvm/versions/node/v24.15.0/bin/pi";

async function withRuntime(fn: (rt: ReturnType<typeof createKbRuntime>) => Promise<void>, options?: { execPath?: string }) {
  const rt = createKbRuntime(options);
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

describe("kb worker", () => {
  it("pings from the repo .mjs entry", async () => {
    await withRuntime(async (rt) => {
      const msg = await rt.request({ op: "ping" });
      assert.equal(msg.ok, true);
      assert.equal(typeof msg.node, "string");
      assert.notEqual(msg.threadId, 0);
      assert.match(String(workerFileUrl), /kb-worker\.mjs$/);
    });
  });

  it("runs extracted source helpers without changing results", async () => {
    await withRuntime(async (rt) => {
      const path = await rt.request({ op: "source", fn: "pathKey", args: ["C:\\Notes\\A.md", "win32"] });
      assert.equal(path.result, pathKey("C:\\Notes\\A.md", "win32"));
      const decoded = await rt.request({ op: "source", fn: "decodeEntities", args: ["headerField: &#39;observed.FullName&#39;"] });
      assert.equal(decoded.result, "headerField: 'observed.FullName'");
      const title = await rt.request({
        op: "source",
        fn: "extractNoteTitle",
        args: ["```\n# not\n```\n# 搜索栏Searchbar\n"],
      });
      assert.equal(title.result, extractNoteTitle("```\n# not\n```\n# 搜索栏Searchbar\n"));
      const mapped = await rt.request({
        op: "source",
        fn: "parseShowDocReadme",
        args: ["搜索栏Searchbar —— prefix_aaa.md\n"],
      });
      assert.equal(mapped.result.get("prefix_aaa.md"), parseShowDocReadme("搜索栏Searchbar —— prefix_aaa.md\n").get("prefix_aaa.md"));
      const digest = await rt.request({ op: "source", fn: "digestFileName", args: ["/Vault/A.md", "abc", "win32"] });
      assert.equal(digest.result, digestFileName("/Vault/A.md", "abc", "win32"));
    });
  });

  it("loads when the package is installed under node_modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-nm-"));
    const pkg = join(dir, "node_modules", "pi-kb");
    await mkdir(join(pkg, "lib"), { recursive: true });
    await cp(join(repoRoot, "lib", "source.mjs"), join(pkg, "lib", "source.mjs"));
    await cp(join(repoRoot, "lib", "kb-worker.mjs"), join(pkg, "lib", "kb-worker.mjs"));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "pi-kb", type: "module" }));
    const { createKbRuntime: createInstalled } = await import(pathToFileURL(join(pkg, "lib", "kb-worker.mjs")).href);
    const rt = createInstalled();
    try {
      const msg = await rt.request({ op: "ping" });
      assert.equal(msg.ok, true);
      const decoded = await rt.request({ op: "source", fn: "decodeEntities", args: ["&amp;lt;"] });
      assert.equal(decoded.result, "&lt;");
    } finally {
      await rt.close();
    }
  });

  it("runs on Node 22.19 when that binary is present", async (t) => {
    try {
      await access(node22);
    } catch {
      t.skip("Node 22.19 binary not installed");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-n22-"));
    const file = join(dir, "ping.mjs");
    await writeFile(file, [
      `import { createKbRuntime } from ${JSON.stringify(workerFileUrl.href)};`,
      "const rt = createKbRuntime();",
      "const msg = await rt.request({ op: \"ping\" });",
      "console.log(JSON.stringify({ ok: msg.ok, node: msg.node }));",
      "await rt.close();",
    ].join("\n"));
    const { stdout } = await execFileAsync(node22, [file], {
      timeout: 15_000,
      encoding: "utf8",
      cwd: repoRoot,
    });
    const msg = JSON.parse(stdout.trim());
    assert.equal(msg.ok, true);
    assert.match(msg.node, /^v22\./);
  });

  it("Pi can load the extension that imports the worker", async (t) => {
    try {
      await access(piBin);
    } catch {
      t.skip("pi binary not installed");
      return;
    }
    await execFileAsync(piBin, [
      "--offline",
      "--no-extensions",
      "-e",
      join(repoRoot, "extensions/index.ts"),
      "--list-models",
    ], {
      timeout: 20_000,
      encoding: "utf8",
      cwd: tmpdir(),
    });
  });
});
