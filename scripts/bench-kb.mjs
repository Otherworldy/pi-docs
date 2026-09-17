import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { indexRoot } from "../lib/collect.mjs";
import { searchRootIndex } from "../lib/retrieval.mjs";

const count = Number(process.argv[2] ?? 200);
const dir = await mkdtemp(join(tmpdir(), "pi-kb-bench-"));
const notes = join(dir, "notes");
await mkdir(join(notes, "插件"), { recursive: true });
const samples = [
  "# 搜索栏Searchbar\n条件之间是与关系，不支持或。headerField 默认 person。\n",
  "# 同步数据离职人员的处理规范\n原则上不删除账号，只打离职标记。\n",
  "# selectCompare\n盘点场景 headerField 要传 observed.FullName。\n",
];
for (let i = 0; i < count; i++) {
  await writeFile(join(notes, "插件", `${i}.md`), `${samples[i % samples.length]}# ${i}\n`);
}

const t0 = performance.now();
const built = await indexRoot({ sourcePath: notes, sourceKey: "bench" });
const t1 = performance.now();
const q1 = await searchRootIndex(notes, "headerField observed.FullName", { limit: 8 });
const t2 = performance.now();
const q2 = await searchRootIndex(notes, "离职 标记", { limit: 8 });
const t3 = performance.now();
console.log(JSON.stringify({
  count,
  indexMs: Math.round(t1 - t0),
  searchHeaderFieldMs: Math.round(t2 - t1),
  searchLeaveMs: Math.round(t3 - t2),
  indexState: built.state,
  headerHits: q1.hits?.length ?? 0,
  leaveHits: q2.hits?.length ?? 0,
}, null, 2));
