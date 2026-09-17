import { createHash } from "node:crypto";
import { basename, extname, join, posix, win32 } from "node:path";

export const TEXT_EXTS = new Set([".md", ".mdx", ".txt", ".html", ".htm", ".json", ".yaml", ".yml"]);
export const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ".pi-kb", "pi-kb-cache"]);
export const TITLE_MAX = 120;
export const FILE_MAX = 1024 * 1024;
export const CACHE_DIRNAME = ".pi-kb";

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function pathApi(platform = process.platform) {
  return platform === "win32" ? win32 : posix;
}

/** Stable path identity: Windows is case-insensitive and slash-insensitive. */
export function pathKey(p, platform = process.platform) {
  const n = pathApi(platform).normalize(p);
  return platform === "win32" ? n.toLowerCase() : n;
}

export function samePath(a, b, platform = process.platform) {
  return pathKey(a, platform) === pathKey(b, platform);
}

export function pathInside(child, parent, platform = process.platform) {
  const api = pathApi(platform);
  const c = api.resolve(child);
  const p = api.resolve(parent);
  const rel = api.relative(p, c);
  return rel === "" || (!rel.startsWith(`..${api.sep}`) && rel !== ".." && !api.isAbsolute(rel));
}

export function excluded(relPath, rules) {
  const norm = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  for (const rule of rules) {
    const r = rule.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!r) continue;
    if (norm === r || norm.startsWith(`${r}/`)) return true;
  }
  return false;
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (whole, ent) => {
    const named = NAMED_ENTITIES[ent];
    if (named !== undefined) return named;
    let n;
    if (ent.startsWith("#x") || ent.startsWith("#X")) n = Number.parseInt(ent.slice(2), 16);
    else n = Number.parseInt(ent.slice(1), 10);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(n);
    } catch {
      return whole;
    }
  });
}

export function foldSpace(text) {
  return text.replace(/[ \t]+/g, " ");
}

export function asLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function normalizeNoteLines(text) {
  return asLines(stripBom(text)).map((line) => decodeEntities(line));
}

export function extractNoteTitle(text) {
  const lines = asLines(stripBom(text));
  let fence;
  for (const line of lines) {
    const trimmed = line.trim();
    const mark = /^(```+|~~~+)/.exec(trimmed);
    if (mark) {
      const ch = mark[1][0];
      if (!fence) fence = ch;
      else if (ch === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(\S.*)$/.exec(trimmed);
    if (heading) return heading[2].trim().slice(0, TITLE_MAX);
  }
}

export function digestFileName(sourcePath, sourceHash, platform = process.platform) {
  return `${sha256(pathKey(sourcePath, platform))}-${sourceHash}.md`;
}

export function cacheDirFor(sourcePath) {
  return join(sourcePath, CACHE_DIRNAME);
}

export function sourceCachePath(sourcePath) {
  return join(cacheDirFor(sourcePath), "snapshot.json");
}

export function parseShowDocReadme(text) {
  const fileToTitle = new Map();
  const conflict = new Set();
  for (const line of asLines(text)) {
    const m = line.match(/^\s*(.+?)\s+(?:——|--)\s+(\S+\.[A-Za-z0-9]+)\s*$/);
    if (!m) continue;
    const title = m[1].trim();
    const file = m[2].replaceAll("\\", "/");
    if (!title || file.includes("..")) {
      conflict.add(file);
      continue;
    }
    const prev = fileToTitle.get(file);
    if (prev && prev !== title) conflict.add(file);
    else fileToTitle.set(file, title);
  }
  for (const file of conflict) fileToTitle.delete(file);
  return fileToTitle;
}

function isShowDocInfo(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const pages = raw.pages;
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) return false;
  return Array.isArray(pages.pages) || Array.isArray(pages.catalogs);
}

function collectShowDocCatalogs(node, parents, out, dups) {
  for (const page of node.pages ?? []) {
    if (!page || typeof page !== "object") continue;
    const title = page.page_title;
    if (typeof title !== "string" || !title.trim()) continue;
    const key = title.trim();
    if (out.has(key) || dups.has(key)) {
      dups.add(key);
      out.delete(key);
      continue;
    }
    out.set(key, parents);
  }
  for (const cat of node.catalogs ?? []) {
    if (!cat || typeof cat !== "object") continue;
    const name = typeof cat.cat_name === "string" ? cat.cat_name.trim() : "";
    collectShowDocCatalogs(cat, name ? [...parents, name] : parents, out, dups);
  }
}

export function parseShowDocInfo(raw) {
  if (!isShowDocInfo(raw)) return null;
  const out = new Map();
  const dups = new Set();
  collectShowDocCatalogs(raw.pages, [], out, dups);
  return out;
}

export function sourceTitleFrom(path, text) {
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading) return heading[1].trim().slice(0, TITLE_MAX);
  return basename(path, extname(path));
}
