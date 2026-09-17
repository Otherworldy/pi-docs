import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyProjectArg,
  applyScopeArg,
  backupConfigFile,
  loadConfigFile,
  parseConfigJson,
  saveConfigFile,
} from "../lib/kb.ts";
import {
  findBindingConflicts,
  findWorkspaceConflicts,
  matchWorkspace,
  resolveOwnership,
  visibleInQuery,
} from "../lib/scope.mjs";

describe("isolation config", () => {
  it("legacy config has isolation off", () => {
    const parsed = parseConfigJson({ roots: [{ name: "notes", path: "/vault" }] });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.isolation, false);
    assert.equal(parsed.projects.length, 0);
  });

  it("rejects unknown version and projects without version", () => {
    assert.equal(parseConfigJson({ version: 3, roots: [{ name: "n", path: "/x" }] }).ok, false);
    assert.equal(parseConfigJson({
      roots: [{ name: "n", path: "/x" }],
      projects: [],
      bindings: [],
    }).ok, false);
  });

  it("rejects reserved ids, unknown refs, and invalid binding paths", () => {
    const roots = [{ name: "notes", path: "/notes" }];
    assert.match(parseConfigJson({
      version: 2,
      roots,
      projects: [{ id: "auto", name: "A", workspaces: ["/a"] }],
      bindings: [],
    }).error ?? "", /保留字/);
    assert.match(parseConfigJson({
      version: 2,
      roots,
      projects: [{ id: "a", name: "A", workspaces: ["/a"] }],
      bindings: [{ root: "missing", path: ".", scope: "shared" }],
    }).error ?? "", /未知 root/);
    assert.match(parseConfigJson({
      version: 2,
      roots,
      projects: [{ id: "a", name: "A", workspaces: ["/a"] }],
      bindings: [{ root: "notes", path: "../x", scope: "shared" }],
    }).error ?? "", /path 无效/);
    assert.match(parseConfigJson({
      version: 2,
      roots,
      projects: [{ id: "a", name: "A", workspaces: ["/a"] }],
      bindings: [{ root: "notes", path: ".", scope: { projects: ["b"] } }],
    }).error ?? "", /未知项目/);
  });

  it("accepts v2 bindings and round-trips through saveConfigFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-iso-"));
    const notes = join(dir, "notes");
    const code = join(dir, "code");
    await mkdir(join(notes, "项目A"), { recursive: true });
    await mkdir(code);
    const configPath = join(dir, "pi-kb.json");
    const isolation = {
      projects: [{ id: "project-a", name: "项目 A", workspaces: [code] }],
      bindings: [
        { root: "notes", path: "项目A", scope: { kind: "projects" as const, projects: ["project-a"] } },
        { root: "notes", path: "通用技术", scope: { kind: "shared" as const } },
      ],
    };
    const saved = await saveConfigFile(configPath, [{ name: "notes", path: notes }], undefined, undefined, isolation);
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.isolation, true);
    assert.equal(saved.projects[0].id, "project-a");
    const extra = join(dir, "docs");
    await mkdir(extra);
    const added = await saveConfigFile(configPath, [
      { name: "notes", path: notes },
      { name: "docs", path: extra },
    ]);
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.isolation, true);
    assert.equal(added.bindings.length, 2);
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.bindings[0].scope.projects[0], "project-a");
  });

  it("project/scope commands reject unknown ids and keep extra range explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-cmd-"));
    const notes = join(dir, "notes");
    await mkdir(notes);
    const saved = await saveConfigFile(join(dir, "pi-kb.json"), [{ name: "notes", path: notes }], undefined, undefined, {
      projects: [{ id: "pa", name: "A", workspaces: [join(dir, "wa")] }],
      bindings: [],
    });
    assert.equal(applyProjectArg(saved, "auto").ok, true);
    assert.equal(applyProjectArg(saved, "missing").ok, false);
    assert.equal(applyScopeArg(saved, "current").ok, true);
    assert.deepEqual(applyScopeArg(saved, "all").ok ? applyScopeArg(saved, "all") : {}, { ok: true, extraIds: ["*"] });
    assert.equal(applyScopeArg(saved, "missing").ok, false);
    const bak = await backupConfigFile(join(dir, "pi-kb.json"));
    assert.equal(bak.ok, true);
    const again = await backupConfigFile(join(dir, "pi-kb.json"));
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.existed, true);
  });

  it("does not enable isolation for existing files without version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kb-legacy-"));
    const notes = join(dir, "notes");
    await mkdir(notes);
    const configPath = join(dir, "pi-kb.json");
    await writeFile(configPath, JSON.stringify({ roots: [{ name: "notes", path: notes }] }));
    const loaded = await loadConfigFile(configPath);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.isolation, false);
  });
});

describe("ownership", () => {
  const roots = [
    { name: "notes", path: "/notes", exclude: [] },
    { name: "agent", path: "/notes/agent", exclude: [] },
  ];

  it("parent shared does not leak a more specific project child", () => {
    const bindings = [
      { root: "notes", path: ".", scope: { kind: "shared" } },
      { root: "notes", path: "项目A", scope: { kind: "projects", projects: ["a"] } },
    ];
    const child = resolveOwnership("/notes/项目A/api.md", roots, bindings);
    const shared = resolveOwnership("/notes/通用/x.md", roots, bindings);
    assert.equal(child.kind, "projects");
    assert.deepEqual(child.projects, ["a"]);
    assert.equal(visibleInQuery(child, { isolation: true, projectIds: ["b"] }), false);
    assert.equal(visibleInQuery(shared, { isolation: true, projectIds: ["b"] }), true);
    assert.equal(visibleInQuery(child, { isolation: false, projectIds: [] }), true);
  });

  it("explicit shared child overrides a project parent", () => {
    const bindings = [
      { root: "notes", path: ".", scope: { kind: "projects", projects: ["a"] } },
      { root: "notes", path: "通用", scope: { kind: "shared" } },
    ];
    const own = resolveOwnership("/notes/通用/x.md", roots, bindings);
    assert.equal(own.kind, "shared");
  });

  it("exact file binding beats directory binding", () => {
    const bindings = [
      { root: "notes", path: "混放", scope: { kind: "shared" } },
      { root: "notes", path: "混放/b.md", scope: { kind: "projects", projects: ["b"] } },
    ];
    const file = resolveOwnership("/notes/混放/b.md", roots, bindings);
    const other = resolveOwnership("/notes/混放/a.md", roots, bindings);
    assert.equal(file.kind, "projects");
    assert.deepEqual(file.projects, ["b"]);
    assert.equal(other.kind, "shared");
  });

  it("unassigned and excluded are not visible when isolation is on", () => {
    const rootsEx = [{ name: "notes", path: "/notes", exclude: ["secret"] }];
    const none = resolveOwnership("/notes/x.md", rootsEx, []);
    const hidden = resolveOwnership("/notes/secret/x.md", rootsEx, [
      { root: "notes", path: "secret", scope: { kind: "shared" } },
    ]);
    assert.equal(none.kind, "unassigned");
    assert.equal(visibleInQuery(none, { isolation: true, projectIds: ["a"] }), false);
    assert.equal(hidden.excluded, true);
    assert.equal(visibleInQuery(hidden, { isolation: true, projectIds: ["a"] }), false);
  });

  it("directory bindings do not classify generated notes", () => {
    const bindings = [
      { root: "notes", path: ".", scope: { kind: "shared" } },
      { root: "agent", path: ".", scope: { kind: "projects", projects: ["a"] } },
      { root: "agent", path: "lessons/keep.md", scope: { kind: "projects", projects: ["b"] } },
    ];
    const auto = resolveOwnership("/notes/agent/lessons/old.md", roots, bindings);
    const keep = resolveOwnership("/notes/agent/lessons/keep.md", roots, bindings);
    assert.equal(auto.kind, "unassigned");
    assert.equal(keep.kind, "projects");
    assert.deepEqual(keep.projects, ["b"]);
  });

  it("unidentified query only sees shared", () => {
    const own = resolveOwnership("/notes/项目A/a.md", roots, [
      { root: "notes", path: "项目A", scope: { kind: "projects", projects: ["a"] } },
      { root: "notes", path: "通用", scope: { kind: "shared" } },
    ]);
    const shared = resolveOwnership("/notes/通用/x.md", roots, [
      { root: "notes", path: "通用", scope: { kind: "shared" } },
    ]);
    assert.equal(visibleInQuery(own, { isolation: true, projectIds: [] }), false);
    assert.equal(visibleInQuery(shared, { isolation: true, projectIds: [] }), true);
  });

  it("Windows paths use case-insensitive containment", () => {
    const winRoots = [{ name: "notes", path: "C:\\Notes", exclude: [] }];
    const own = resolveOwnership("c:/notes/项目A/a.md", winRoots, [
      { root: "notes", path: "项目A", scope: { kind: "projects", projects: ["a"] } },
    ], "win32");
    assert.equal(own.kind, "projects");
  });

  it("rejects overlapping workspaces and conflicting same-target bindings", () => {
    assert.match(findWorkspaceConflicts([
      { id: "a", workspaces: [{ path: "/code/a" }] },
      { id: "b", workspaces: [{ path: "/code/a" }] },
    ]) ?? "", /同时属于/);
    const conflict = findBindingConflicts(
      [{ name: "notes", path: "/notes" }, { name: "copy", path: "/notes" }],
      [
        { root: "notes", path: "x.md", scope: { kind: "shared" } },
        { root: "copy", path: "x.md", scope: { kind: "projects", projects: ["a"] } },
      ],
    );
    assert.match(conflict ?? "", /绑定冲突/);
  });

  it("matches the most specific workspace", () => {
    const projects = [
      { id: "a", workspaces: [{ path: "/code/a" }, { path: "/code/a-api" }] },
      { id: "b", workspaces: [{ path: "/code/b" }] },
    ];
    assert.equal(matchWorkspace("/code/a/src", projects).projectId, "a");
    assert.equal(matchWorkspace("/code/a-api", projects).projectId, "a");
    assert.equal(matchWorkspace("/tmp", projects).projectId, undefined);
  });
});
