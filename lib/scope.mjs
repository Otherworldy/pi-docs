import { posix, win32 } from "node:path";
import { excluded, pathInside, pathKey, samePath } from "./source.mjs";

export const CONFIG_VERSION = 2;
export const RESERVED_PROJECT_IDS = new Set(["auto", "shared", "current", "all"]);

function api(platform = process.platform) {
  return platform === "win32" ? win32 : posix;
}

function fail(error) {
  return { ok: false, error };
}

export function posixRel(relPath) {
  return String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

export function isManagedRel(relPath) {
  const rel = posixRel(relPath);
  return rel === "digests" || rel === "lessons" || rel === ".pi-kb"
    || rel.startsWith("digests/") || rel.startsWith("lessons/") || rel.startsWith(".pi-kb/");
}

export function normalizeBindPath(rel) {
  if (typeof rel !== "string") return;
  const trimmed = rel.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === ".") return ".";
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return;
  const parts = trimmed.replace(/^\/+|\/+$/g, "").split("/");
  if (!parts.length || parts.some((p) => !p || p === "." || p === "..")) return;
  return parts.join("/");
}

export function parseProjectId(raw) {
  if (typeof raw !== "string" || !raw.trim()) return fail("项目 id 不能为空");
  const id = raw.trim();
  if (/\s/.test(id)) return fail(`项目 id 不能含空白: ${id}`);
  if (RESERVED_PROJECT_IDS.has(id.toLowerCase())) return fail(`项目 id 为保留字: ${id}`);
  return { ok: true, id };
}

export function parseScope(raw) {
  if (raw === "shared") return { ok: true, scope: { kind: "shared" } };
  if (raw === "unassigned") return { ok: true, scope: { kind: "unassigned" } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("scope 无效");
  const list = raw.projects;
  if (!Array.isArray(list) || !list.length) return fail("scope.projects 不能为空");
  const projects = [];
  const seen = new Set();
  for (const item of list) {
    const parsed = parseProjectId(item);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    projects.push(parsed.id);
  }
  return { ok: true, scope: { kind: "projects", projects } };
}

export function scopeToJson(scope) {
  if (scope.kind === "projects") return { projects: [...scope.projects] };
  return scope.kind;
}

export function scopesEqual(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind !== "projects") return true;
  if (a.projects.length !== b.projects.length) return false;
  const other = new Set(b.projects);
  return a.projects.every((id) => other.has(id));
}

export function parseProjects(raw) {
  if (raw === undefined) return fail("缺少 projects 数组");
  if (!Array.isArray(raw)) return fail("projects 必须是数组");
  const out = [];
  const ids = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail("project 必须是对象");
    const parsed = parseProjectId(item.id);
    if (!parsed.ok) return parsed;
    if (ids.has(parsed.id)) return fail(`重复的项目 id: ${parsed.id}`);
    ids.add(parsed.id);
    if (typeof item.name !== "string" || !item.name.trim()) return fail(`项目名称不能为空: ${parsed.id}`);
    if (!Array.isArray(item.workspaces)) return fail(`项目 ${parsed.id} 缺少 workspaces`);
    const workspaces = [];
    const seen = new Set();
    for (const ws of item.workspaces) {
      if (typeof ws !== "string" || !ws.trim()) return fail(`项目 ${parsed.id} 的工作目录无效`);
      const path = ws.trim();
      if (!path.startsWith("~") && !api().isAbsolute(path) && !win32.isAbsolute(path)) {
        return fail(`工作目录必须是绝对路径或 ~/：${parsed.id}`);
      }
      const key = pathKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      workspaces.push(path);
    }
    out.push({ id: parsed.id, name: item.name.trim(), workspaces });
  }
  return { ok: true, projects: out };
}

export function parseBindings(raw, rootNames, projectIds) {
  if (raw === undefined) return fail("缺少 bindings 数组");
  if (!Array.isArray(raw)) return fail("bindings 必须是数组");
  const roots = rootNames instanceof Set ? rootNames : new Set(rootNames);
  const projects = projectIds instanceof Set ? projectIds : new Set(projectIds);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail("binding 必须是对象");
    if (typeof item.root !== "string" || !item.root.trim()) return fail("binding.root 不能为空");
    const root = item.root.trim();
    if (!roots.has(root)) return fail(`绑定引用了未知 root: ${root}`);
    const path = normalizeBindPath(item.path);
    if (!path) return fail(`binding.path 无效: ${root} ${String(item.path)}`);
    const scope = parseScope(item.scope);
    if (!scope.ok) return fail(`${root}:${path} ${scope.error}`);
    if (scope.scope.kind === "projects") {
      for (const id of scope.scope.projects) {
        if (!projects.has(id)) return fail(`绑定引用了未知项目: ${id}`);
      }
    }
    const key = `${root}\n${path}`;
    if (seen.has(key)) return fail(`重复绑定: ${root}:${path}`);
    seen.add(key);
    out.push({ root, path, scope: scope.scope });
  }
  return { ok: true, bindings: out };
}

export function parseIsolationFields(raw, rootNames) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("配置必须是对象");
  if (raw.version !== CONFIG_VERSION) return fail(`不支持的配置版本: ${raw.version}`);
  const projects = parseProjects(raw.projects);
  if (!projects.ok) return projects;
  const bindings = parseBindings(raw.bindings, rootNames, projects.projects.map((p) => p.id));
  if (!bindings.ok) return bindings;
  return { ok: true, isolation: true, projects: projects.projects, bindings: bindings.bindings };
}

export function bindingTarget(rootPath, bindPath, platform = process.platform) {
  if (bindPath === ".") return rootPath;
  return api(platform).join(rootPath, ...bindPath.split("/"));
}

export function relToRoot(file, rootPath, platform = process.platform) {
  const p = api(platform);
  const rel = p.relative(p.resolve(rootPath), p.resolve(file));
  if (rel.startsWith(`..${p.sep}`) || rel === ".." || p.isAbsolute(rel)) return;
  return posixRel(rel) || ".";
}

function coveringBindings(file, roots, bindings, platform) {
  const covered = [];
  for (const root of roots) {
    const base = root.realPath ?? root.path;
    if (!base || !pathInside(file, base, platform)) continue;
    const fileRel = relToRoot(file, base, platform);
    if (!fileRel || fileRel === ".") continue;
    if (excluded(fileRel, root.exclude ?? [])) {
      return { excluded: true, hits: [] };
    }
    covered.push({ root, base, fileRel });
  }
  const managed = covered.some((c) => isManagedRel(c.fileRel));
  const hits = [];
  for (const { root, base, fileRel } of covered) {
    for (const binding of bindings) {
      if (binding.root !== root.name) continue;
      if (!bindingCovers(binding.path, fileRel)) continue;
      const exact = binding.path === fileRel;
      if (managed && !exact) continue;
      hits.push({
        root: root.name,
        path: binding.path,
        scope: binding.scope,
        exact,
        target: bindingTarget(base, binding.path, platform),
        targetKey: pathKey(bindingTarget(base, binding.path, platform), platform),
      });
    }
  }
  return { excluded: false, hits };
}

export function bindingCovers(bindPath, fileRel) {
  if (bindPath === ".") return true;
  return fileRel === bindPath || fileRel.startsWith(`${bindPath}/`);
}

export function resolveOwnership(file, roots, bindings, platform = process.platform) {
  const found = coveringBindings(file, roots, bindings, platform);
  if (found.excluded) return { excluded: true, kind: "unassigned", projects: [] };
  if (!found.hits.length) return { excluded: false, kind: "unassigned", projects: [] };
  let best = found.hits[0];
  for (const hit of found.hits.slice(1)) {
    const cmp = compareHits(best, hit, platform);
    if (cmp === 0) {
      if (!scopesEqual(best.scope, hit.scope)) {
        return { excluded: true, kind: "unassigned", projects: [], conflict: `${best.root}:${best.path} 与 ${hit.root}:${hit.path}` };
      }
      continue;
    }
    if (cmp < 0) best = hit;
  }
  if (best.scope.kind === "projects") {
    return { excluded: false, kind: "projects", projects: [...best.scope.projects] };
  }
  return { excluded: false, kind: best.scope.kind, projects: [] };
}

function compareHits(a, b, platform) {
  if (a.exact !== b.exact) return a.exact ? 1 : -1;
  if (a.targetKey === b.targetKey) return 0;
  if (pathInside(a.target, b.target, platform) && !samePath(a.target, b.target, platform)) return 1;
  if (pathInside(b.target, a.target, platform) && !samePath(a.target, b.target, platform)) return -1;
  const d = a.targetKey.length - b.targetKey.length;
  if (d) return d;
  return 0;
}

function coerceScope(raw) {
  if (!raw) return;
  if (raw.kind === "shared" || raw.kind === "unassigned") return { kind: raw.kind, projects: [] };
  if (raw.kind === "projects" && Array.isArray(raw.projects)) return { kind: "projects", projects: raw.projects };
  const parsed = parseScope(raw);
  if (parsed.ok) return parsed.scope.kind === "projects" ? parsed.scope : { kind: parsed.scope.kind, projects: [] };
}

export function ownershipForDoc(file, roots, bindings, doc, platform = process.platform) {
  const kind = doc?.kind;
  if (kind === "digest" || kind === "derived") {
    if (typeof doc.sourcePath !== "string" || !doc.sourcePath) {
      return { excluded: true, kind: "unassigned", projects: [] };
    }
    return resolveOwnership(doc.sourcePath, roots, bindings, platform);
  }
  const own = resolveOwnership(file, roots, bindings, platform);
  if (kind === "lesson" && !own.excluded && own.kind === "unassigned") {
    const meta = coerceScope(doc?.scope);
    if (meta) return { excluded: false, kind: meta.kind, projects: meta.projects ?? [] };
  }
  return own;
}

export function visibleInQuery(ownership, query) {
  if (ownership.excluded || ownership.conflict) return false;
  if (!query.isolation) return true;
  if (ownership.kind === "unassigned") return false;
  if (ownership.kind === "shared") return true;
  const ids = new Set(query.projectIds ?? []);
  return ownership.projects.some((id) => ids.has(id));
}

export function matchWorkspace(cwd, projects, platform = process.platform) {
  let best;
  let bestLen = -1;
  for (const project of projects) {
    for (const ws of project.workspaces) {
      const base = ws.realPath ?? ws.path ?? ws;
      if (typeof base !== "string" || !base) continue;
      if (!pathInside(cwd, base, platform)) continue;
      const len = pathKey(base, platform).length;
      if (len > bestLen) {
        best = { projectId: project.id, workspace: base };
        bestLen = len;
      } else if (len === bestLen && best && best.projectId !== project.id) {
        return fail("工作目录同时匹配多个项目");
      }
    }
  }
  return { ok: true, projectId: best?.projectId };
}

export function findWorkspaceConflicts(projects, platform = process.platform) {
  const byKey = new Map();
  for (const project of projects) {
    for (const ws of project.workspaces) {
      const base = ws.realPath ?? ws.path ?? ws;
      if (typeof base !== "string" || !base) continue;
      const key = pathKey(base, platform);
      const prev = byKey.get(key);
      if (prev && prev !== project.id) return `工作目录同时属于 ${prev} 和 ${project.id}`;
      byKey.set(key, project.id);
    }
  }
}

export function findBindingConflicts(roots, bindings, platform = process.platform) {
  const byTarget = new Map();
  for (const binding of bindings) {
    const root = roots.find((r) => r.name === binding.root);
    if (!root) continue;
    const base = root.realPath ?? root.path;
    if (!base) continue;
    const target = bindingTarget(base, binding.path, platform);
    const key = pathKey(target, platform);
    const prev = byTarget.get(key);
    if (prev && !scopesEqual(prev.scope, binding.scope)) {
      return `绑定冲突: ${prev.root}:${prev.path} 与 ${binding.root}:${binding.path}`;
    }
    if (!prev) byTarget.set(key, binding);
  }
}
