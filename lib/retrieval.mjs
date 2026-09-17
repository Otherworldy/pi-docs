const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const IDENT_RE = /[A-Za-z0-9_]/;

function pushTerm(map, term, field, line) {
  if (!term) return;
  const rec = map.get(term) ?? { term, tf: 0, fields: new Set(), lines: [] };
  rec.tf += 1;
  rec.fields.add(field);
  if (rec.lines.length < 8 && !rec.lines.includes(line)) rec.lines.push(line);
  map.set(term, rec);
}

function splitCamel(ident) {
  const parts = ident.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
  return parts.map((p) => p.toLowerCase()).filter((p) => p && p !== ident.toLowerCase());
}

function addIdent(map, ident, field, line) {
  const full = ident.toLowerCase();
  pushTerm(map, full, field, line);
  for (const piece of ident.split(/[._]/)) {
    if (!piece) continue;
    const lower = piece.toLowerCase();
    if (lower !== full) pushTerm(map, lower, field, line);
    for (const camel of splitCamel(piece)) {
      if (camel !== full && camel !== lower) pushTerm(map, camel, field, line);
    }
  }
}

function addCjkRun(map, run, field, line) {
  for (const ch of run) pushTerm(map, ch, field, line);
  for (let i = 0; i < run.length - 1; i++) pushTerm(map, run.slice(i, i + 2), field, line);
}

export function addTextTokens(map, text, field, line) {
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE.test(ch)) {
      let j = i + 1;
      while (j < s.length && CJK_RE.test(s[j])) j += 1;
      addCjkRun(map, s.slice(i, j), field, line);
      i = j;
      continue;
    }
    if (IDENT_RE.test(ch)) {
      let j = i + 1;
      while (j < s.length && (IDENT_RE.test(s[j]) || s[j] === ".")) j += 1;
      if (s[j - 1] === ".") j -= 1;
      addIdent(map, s.slice(i, j), field, line);
      i = j;
      continue;
    }
    i += 1;
  }
}

export function postingsForDoc(input) {
  const map = new Map();
  addTextTokens(map, input.relPath.replaceAll("\\", "/"), "path", 1);
  addTextTokens(map, input.title ?? "", "title", 1);
  for (const cat of input.catalog ?? []) addTextTokens(map, cat, "catalog", 1);
  if (input.extra) addTextTokens(map, input.extra, "alias", 1);
  const lines = input.lines ?? [];
  for (let i = 0; i < lines.length; i++) addTextTokens(map, lines[i], "body", i + 1);
  const postings = [];
  for (const rec of map.values()) {
    postings.push({
      term: rec.term,
      tf: rec.tf,
      fields: [...rec.fields],
      lines: rec.lines,
    });
  }
  return postings;
}

export function parseSearchQuery(query) {
  const phrases = [];
  const rest = String(query).replace(/"([^"]+)"/g, (_, p) => {
    if (p.trim()) phrases.push(p.trim());
    return " ";
  });
  const groups = rest.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  return { groups, phrases };
}

export function needlesForGroup(group) {
  const map = new Map();
  addTextTokens(map, group, "q", 1);
  const tokens = [...map.keys()];
  const long = tokens.filter((t) => [...t].length >= 2);
  return long.length ? long : tokens;
}

function fieldBoost(fields) {
  let boost = 1;
  if (fields?.includes("title")) boost = Math.max(boost, 2.6);
  if (fields?.includes("path")) boost = Math.max(boost, 2.1);
  if (fields?.includes("catalog")) boost = Math.max(boost, 1.8);
  if (fields?.includes("alias")) boost = Math.max(boost, 1.3);
  return boost;
}

function bm25(tf, df, n) {
  const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  const k1 = 1.2;
  return idf * ((tf * (k1 + 1)) / (tf + k1));
}

export async function searchRootIndex(sourcePath, query, opts = {}) {
  const { getDocs, getPostings, readTopManifest, readGeneration } = await import("./index-store.mjs");
  const top = await readTopManifest(sourcePath);
  if (!top?.current) return { ok: true, hits: [], generation: 0, indexed: false };
  const wanted = Number.isInteger(opts.generation) ? opts.generation : top.current;
  let gen = await readGeneration(sourcePath, wanted);
  let used = wanted;
  if (!gen && wanted !== top.current) {
    gen = await readGeneration(sourcePath, top.current);
    used = top.current;
  }
  if (!gen) return { ok: false, error: "索引世代损坏" };
  const parsed = parseSearchQuery(query);
  const groupNeedles = parsed.groups.map(needlesForGroup).filter((n) => n.length);
  if (!groupNeedles.length && !parsed.phrases.length) return { ok: true, hits: [], generation: used, indexed: true };
  const uniqueTerms = [...new Set(groupNeedles.flat())];
  const postings = await getPostings(sourcePath, uniqueTerms, used);
  if (!postings.ok) return postings;
  const visible = opts.visibleIds instanceof Set ? opts.visibleIds : undefined;
  const n = Math.max(1, visible ? visible.size : (gen.docCount || 1));
  const scores = new Map();
  for (let g = 0; g < groupNeedles.length; g++) {
    const needles = groupNeedles[g];
    for (const term of needles) {
      const rec = postings.terms.get(term);
      if (!rec) continue;
      const rows = visible ? rec.postings.filter((p) => visible.has(p.docId)) : rec.postings;
      const df = visible ? rows.length : rec.df;
      if (!df) continue;
      for (const p of rows) {
        const cur = scores.get(p.docId) ?? { score: 0, groups: new Set(), lines: [] };
        cur.score += bm25(p.tf, df, n) * fieldBoost(p.fields);
        cur.groups.add(g);
        cur.lines.push(...(p.lines ?? []));
        scores.set(p.docId, cur);
      }
    }
  }
  const required = groupNeedles.length;
  let ranked = [...scores.entries()].map(([docId, rec]) => ({
    docId,
    score: rec.score,
    groups: rec.groups.size,
    partial: rec.groups.size < required,
    lines: rec.lines,
  }));
  ranked = ranked.filter((r) => required === 0 || r.groups === required || (required >= 2 && r.groups >= 2));
  ranked.sort((a, b) => b.groups - a.groups || b.score - a.score || a.docId.localeCompare(b.docId));
  const limit = opts.limit ?? 8;
  const picked = ranked.slice(0, Math.max(limit * 4, 20));
  const docs = await getDocs(sourcePath, picked.map((p) => p.docId), used);
  if (!docs.ok) return docs;
  const hits = [];
  for (const row of picked) {
    const doc = docs.docs.get(row.docId);
    if (!doc) continue;
    hits.push({
      kind: doc.kind ?? "original",
      relPath: doc.relPath,
      title: doc.title,
      catalog: doc.catalog,
      sourceHash: doc.sourceHash,
      sourcePath: doc.sourcePath,
      sourceFileHash: doc.sourceFileHash,
      scope: doc.scope,
      score: row.score,
      partial: row.partial,
      lines: [...new Set(row.lines)].slice(0, 8),
      phrases: parsed.phrases,
      needles: groupNeedles.flat(),
      docId: row.docId,
    });
    if (hits.length >= limit * 3) break;
  }
  return { ok: true, hits, generation: used, indexed: true, phrases: parsed.phrases, nDocs: n };
}
