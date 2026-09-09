// src/index.ts
import { promises as fsp4 } from "node:fs";
import { join as join2, resolve as resolve2 } from "node:path";

// src/card.ts
import { randomBytes } from "node:crypto";

// src/frontmatter.ts
var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
function parseFrontmatter(raw) {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: null, body: raw, raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value === "") continue;
    if (key === "ID") meta.id = value;
    else if (key === "\u6807\u9898") meta.title = value;
    else if (key === "\u9886\u57DF") meta.domain = value;
    else if (key === "\u6765\u6E90") meta.source = value;
    else if (key === "\u72B6\u6001") meta.status = value;
    else if (key === "\u6A21\u677F") meta.template = value;
  }
  return { meta, body: raw.slice(m[0].length), raw };
}
function renderFrontmatter(meta) {
  const lines = ["---"];
  if (meta.id) lines.push(`ID: ${meta.id}`);
  if (meta.title) lines.push(`\u6807\u9898: ${meta.title}`);
  if (meta.domain) lines.push(`\u9886\u57DF: ${meta.domain}`);
  if (meta.source) lines.push(`\u6765\u6E90: ${meta.source}`);
  if (meta.status) lines.push(`\u72B6\u6001: ${meta.status}`);
  if (meta.template) lines.push(`\u6A21\u677F: ${meta.template}`);
  lines.push("---", "");
  return lines.join("\n");
}
function extractDefinition(body) {
  const concept = /^>\s*概念[:：]\s*(.+)$/m.exec(body);
  if (concept) return concept[1].trim();
  const section = /###\s*定义(?:（[^）]*）)?\s*[\r\n]+>\s*(.+)/.exec(body);
  if (section) return section[1].trim();
  const bare = /^>\s*([^\n]+)/.exec(body.trimStart());
  if (bare) return bare[1].trim();
  return null;
}
function firstHeading(body) {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

// src/cardmodel.ts
var HEADING_RE = /^(#{1,6})[ \t]+(\S.*?)[ \t]*$/gm;
function splitSections(body) {
  const text = String(body ?? "");
  const marks = [];
  HEADING_RE.lastIndex = 0;
  for (let m = HEADING_RE.exec(text); m !== null; m = HEADING_RE.exec(text)) {
    marks.push({ level: m[1].length, title: m[2].trim(), index: m.index, end: m.index + m[0].length });
  }
  if (marks.length === 0) return { lead: text.replace(/\s+$/, ""), sections: [] };
  const lead = text.slice(0, marks[0].index).replace(/\s+$/, "");
  const sections = marks.map((mark, i) => {
    const nextStart = i + 1 < marks.length ? marks[i + 1].index : text.length;
    return {
      level: mark.level,
      title: mark.title,
      body: text.slice(mark.end, nextStart).replace(/^[ \t]*\r?\n/, "").replace(/\s+$/, ""),
      start: mark.index,
      end: nextStart
    };
  });
  return { lead, sections };
}
function renderSections(lead, sections) {
  const parts = [];
  const head = String(lead ?? "").replace(/\s+$/, "");
  if (head.trim()) parts.push(head);
  for (const s of sections) {
    const hashes = "#".repeat(Math.min(Math.max(s.level, 1), 6));
    const heading = `${hashes} ${s.title}`;
    const body = String(s.body ?? "").replace(/\s+$/, "");
    parts.push(body ? `${heading}
${body}` : heading);
  }
  return parts.join("\n\n");
}
function matchesTitle(heading, title) {
  const h = String(heading ?? "").trim();
  const t = String(title ?? "").trim();
  if (!h || !t) return false;
  if (h === t) return true;
  if (!h.startsWith(t)) return false;
  return /^[（(：:—\-·\s]/.test(h.slice(t.length));
}
function findSection(sections, title) {
  return sections.find((s) => matchesTitle(s.title, title));
}
function hasSection(sections, title) {
  return findSection(sections, title) !== void 0;
}
function insertBlockBefore(body, block, beforeTitle = "\u5173\u8054\u5361\u7247") {
  const text = String(body ?? "");
  const { lead, sections } = splitSections(text);
  const trimmed = String(block ?? "").replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!trimmed) return renderSections(lead, sections);
  const idx = sections.findIndex((s) => matchesTitle(s.title, beforeTitle));
  const at = idx === -1 ? text.length : sections[idx].start;
  const head = text.slice(0, at).replace(/\s+$/, "");
  const tail = text.slice(at).replace(/^\s+/, "");
  if (!tail) return `${head}

${trimmed}`;
  if (!head) return `${trimmed}

${tail}`;
  return `${head}

${trimmed}

${tail}`;
}
function codeFenceLanguages(body) {
  const out = [];
  let inFence = false;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = /^[ \t]*(```+|~~~+)[ \t]*([^\s`~]*)/.exec(line);
    if (!m) continue;
    if (inFence) {
      inFence = false;
      continue;
    }
    inFence = true;
    out.push(m[2] ?? "");
  }
  return out;
}
function layerNumbers(body) {
  const found = /* @__PURE__ */ new Set();
  const text = String(body ?? "");
  const re = /第\s*(\d+)\s*层/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}
function countListItems(body) {
  return (String(body ?? "").match(/^[ \t]*(?:\d+[.)]|[-*+])[ \t]+\S/gm) ?? []).length;
}
function blankOutBlocks(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  let fence = null;
  let inDetails = 0;
  return lines.map((line) => {
    const fenceMatch = /^[ \t]*(```+|~~~+)/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return "";
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return "";
    }
    if (inDetails > 0) {
      if (/<\/details>/i.test(line)) inDetails -= 1;
      return "";
    }
    if (/<details\b/i.test(line)) {
      if (!/<\/details>/i.test(line)) inDetails += 1;
      return "";
    }
    return line;
  }).join("\n");
}

// src/history.ts
function checkDetails(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  let depth = 0;
  let opens = 0;
  let closes = 0;
  const unclosed = [];
  lines.forEach((line, i) => {
    const openMatches = line.match(/<details\b/gi) ?? [];
    const closeMatches = line.match(/<\/details>/gi) ?? [];
    for (let n = 0; n < openMatches.length; n++) {
      if (depth === 0) unclosed.push(i + 1);
      depth += 1;
      opens += 1;
    }
    for (let n = 0; n < closeMatches.length; n++) {
      closes += 1;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        unclosed.pop();
      }
    }
  });
  return { balanced: depth === 0 && opens === closes, opens, closes, unclosed };
}
function extractHistory(body) {
  const text = String(body ?? "");
  const { sections } = splitSections(text);
  const blocks = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  for (const section of sections) {
    if (/^版本更新/.test(section.title)) {
      blocks.push({ kind: "version", title: section.title, body: section.body, line: lineOf(section.start), endLine: lineOf(section.end) });
    } else if (/^勘误/.test(section.title)) {
      blocks.push({ kind: "errata", title: section.title, body: section.body, line: lineOf(section.start), endLine: lineOf(section.end) });
    }
  }
  const lines = text.split(/\r?\n/);
  let start = -1;
  let depth = 0;
  let buffer = [];
  lines.forEach((line, i) => {
    if (/<details\b/i.test(line) && depth === 0) {
      start = i;
      buffer = [];
      depth = 0;
    }
    if (start !== -1) {
      buffer.push(line);
      depth += (line.match(/<details\b/gi) ?? []).length;
      depth -= (line.match(/<\/details>/gi) ?? []).length;
      if (depth <= 0) {
        const raw = buffer.join("\n");
        const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(raw);
        blocks.push({
          kind: "details",
          title: summary ? summary[1].trim() : "\u5386\u53F2\u7248\u672C",
          body: raw.replace(/<\/?details\b[^>]*>/gi, "").replace(/<summary>[\s\S]*?<\/summary>/i, "").trim(),
          line: start + 1,
          endLine: i + 1
        });
        start = -1;
        buffer = [];
      }
    }
  });
  return blocks.sort((a, b) => a.line - b.line);
}
function versionBlock(source, changes) {
  return `### \u7248\u672C\u66F4\u65B0\uFF08\u6765\u6E90\uFF1A${source}\uFF09
${String(changes ?? "").trim()}`;
}
function errataBlock(changes) {
  return `### \u52D8\u8BEF
${String(changes ?? "").trim()}`;
}
function insertHistoryBlock(body, block) {
  return insertBlockBefore(body, block, "\u5173\u8054\u5361\u7247");
}
function dropDetailsBlocks(text, blocks) {
  if (blocks.length === 0) return text;
  const targets = new Set(blocks.map((b) => b.line));
  const lines = text.split(/\r?\n/);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    if (targets.has(lineNo)) {
      const target = blocks.find((b) => b.line === lineNo);
      i = target.endLine;
      continue;
    }
    kept.push(lines[i]);
    i += 1;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/, "");
}
function stripHistory(body, opts = {}) {
  const text = String(body ?? "");
  const warnings = [];
  const check = checkDetails(text);
  if (!check.balanced) {
    warnings.push(`<details> \u6807\u7B7E\u4E0D\u914D\u5BF9\uFF08\u5F00 ${check.opens} / \u95ED ${check.closes}\uFF09\uFF0C\u672A\u95ED\u5408\u5757\u4E0D\u4F1A\u88AB\u5220\u9664${check.unclosed.length > 0 ? `\uFF08\u8D77\u59CB\u884C ${check.unclosed.join("\u3001")}\uFF09` : ""}`);
  }
  const kinds = new Set(opts.kinds ?? ["version", "errata", "details"]);
  const removed = extractHistory(text).filter((b) => kinds.has(b.kind));
  if (removed.length === 0) return { text, removed, warnings };
  const { lead, sections } = splitSections(text);
  const kept = sections.filter((s) => {
    if (kinds.has("version") && /^版本更新/.test(s.title)) return false;
    if (kinds.has("errata") && /^勘误/.test(s.title)) return false;
    return true;
  });
  let next = renderSections(lead, kept);
  if (kinds.has("details")) next = dropDetailsBlocks(next, removed.filter((b) => b.kind === "details"));
  return { text: next, removed, warnings };
}
function formatHistory(blocks) {
  if (blocks.length === 0) return "\uFF08\u65E0\u5386\u53F2\u5757\uFF1A\u8BE5\u5361\u6CA1\u6709\u7248\u672C\u66F4\u65B0/\u52D8\u8BEF/\u5386\u53F2\u6298\u53E0\uFF09";
  const label = { version: "\u7248\u672C\u66F4\u65B0", errata: "\u52D8\u8BEF", details: "\u5386\u53F2\u6298\u53E0" };
  return blocks.map((b) => `- [${label[b.kind]}] \u7B2C ${b.line}-${b.endLine} \u884C\uFF1A${b.title}${b.body ? `\uFF08${b.body.replace(/\s+/g, " ").slice(0, 60)}\u2026\uFF09` : ""}`).join("\n");
}

// src/template.ts
var TEMPLATE_TYPES = ["\u7406\u8BBA\u578B", "\u5DE5\u7A0B\u578B", "\u5BF9\u6BD4\u578B"];
var SEC = (title, hint, mainline = false) => ({ title, hint, mainline });
var COMMON_SECTIONS = [
  SEC("\u6838\u5FC3\u601D\u60F3", "\u4E00\u53E5\u8BDD\u8BB2\u6E05 + \u4E3A\u4EC0\u4E48\u91CD\u8981 + \u8BB0\u5FC6\u951A\u70B9", true),
  SEC("\u4E3B\u5E72\u7EBF", "\u95EE\u9898 \u2192 \u5173\u952E\u7EA6\u675F \u2192 \u89E3\u6CD5 \u2192 \u4EE3\u4EF7 \u2192 \u9A8C\u8BC1\u65B9\u5F0F\uFF08\u4E00\u6761\u56E0\u679C\u94FE\uFF09", true),
  SEC("\u9636\u68AF\u5F0F\u89E3\u5256", "\u7B2C 1 \u5C42\u76F4\u89C9 \u2192 \u7B2C 2 \u5C42\u673A\u5236 \u2192 \u7B2C 3 \u5C42\u7EC6\u8282\u63A8\u5BFC \u2192 \u7B2C 4 \u5C42\u8FB9\u754C\u53CD\u4F8B\uFF084~6 \u5C42\uFF0C\u5E26\u5E8F\u53F7\uFF09", true),
  SEC("\u5B9E\u4F8B\u8D70\u67E5", "\u4EE3\u5165\u5177\u4F53\u6570\u5B57/\u4EE3\u7801\u9010\u6B65\u8D70\u5B8C\uFF08\u7406\u8BBA\u578B\u6570\u503C\u4EE3\u5165\u3001\u5DE5\u7A0B\u578B\u4EE3\u7801\u8D70\u67E5\uFF09"),
  SEC("\u6613\u9519\u70B9", "\u5751 + \u4E3A\u4EC0\u4E48\u9519"),
  SEC("\u81EA\u6D4B\u9898", "2~3 \u9898\uFF0C\u6BCF\u9898\u5E26 \u2192 \u7B54\u6848\u8981\u70B9\u4E0E\u300C\u7B54\u4E0D\u51FA \u2192 \u56DE\u770B X\u300D\u6307\u9488")
];
var REENTRY_SECTION = SEC("\u91CD\u5165\u70B9", "30 \u79D2 / 5 \u5206\u949F / 30 \u5206\u949F\u4E09\u79CD\u8BFB\u6CD5\uFF0C\u4ECE\u4EFB\u610F\u8D77\u70B9\u91CD\u5EFA");
var PREREQ_SECTION = SEC("\u524D\u7F6E\u68C0\u67E5", "\u9700\u8981\u77E5\u9053\uFF1A\u6982\u5FF5 A\uFF08\u5361\u7247 ID\uFF09\u2026\uFF1B\u4E0D\u9700\u8981\u77E5\u9053\uFF1A\u660E\u786E\u6392\u9664");
var ENGINEERING_SECTIONS = [
  SEC("\u9A8C\u8BC1\u5B9E\u9A8C", '\u53EF\u6267\u884C\u6B65\u9AA4 \u22653 \u6B65\uFF0C\u6BCF\u6B65\u4E00\u53E5"\u770B\u5230\u4EC0\u4E48\u8BF4\u660E\u4EC0\u4E48"'),
  SEC("\u6392\u969C\u5224\u636E", "\u8868\u683C\uFF1A\u75C7\u72B6 | \u5224\u636E | \u4FEE\u590D")
];
var COMPARISON_SECTIONS = [
  SEC("\u5BF9\u6BD4\u8868", "\u22652 \u4E2A\u5BF9\u8C61\u7684\u5BF9\u6BD4\uFF1B\u5217\u6570 \u22644\uFF0C\u5217\u540D\u77ED"),
  SEC("\u9009\u578B\u53E3\u8BC0", "\u4E00\u53E5\u8BDD\u51B3\u7B56\u89C4\u5219"),
  SEC("\u573A\u666F\u8D70\u67E5", "\u6309\u573A\u666F\u4EE3\u5165\uFF1A\u4EC0\u4E48\u60C5\u51B5\u4E0B\u9009\u8C01")
];
var SPECS = {
  \u7406\u8BBA\u578B: {
    type: "\u7406\u8BBA\u578B",
    answers: "\u4E3A\u4EC0\u4E48",
    required: COMMON_SECTIONS,
    optional: [REENTRY_SECTION, PREREQ_SECTION]
  },
  \u5DE5\u7A0B\u578B: {
    type: "\u5DE5\u7A0B\u578B",
    answers: "\u600E\u4E48\u505A",
    required: [...COMMON_SECTIONS, ...ENGINEERING_SECTIONS],
    optional: [REENTRY_SECTION, PREREQ_SECTION]
  },
  \u5BF9\u6BD4\u578B: {
    type: "\u5BF9\u6BD4\u578B",
    answers: "\u600E\u4E48\u9009",
    required: [
      SEC("\u6838\u5FC3\u601D\u60F3", "\u4E00\u53E5\u8BDD\u8BB2\u6E05 + \u4E3A\u4EC0\u4E48\u91CD\u8981 + \u8BB0\u5FC6\u951A\u70B9", true),
      SEC("\u4E3B\u5E72\u7EBF", "\u95EE\u9898 \u2192 \u5173\u952E\u7EA6\u675F \u2192 \u89E3\u6CD5 \u2192 \u4EE3\u4EF7 \u2192 \u9A8C\u8BC1\u65B9\u5F0F\uFF08\u4E00\u6761\u56E0\u679C\u94FE\uFF09", true),
      ...COMPARISON_SECTIONS,
      SEC("\u6613\u9519\u70B9", "\u5751 + \u4E3A\u4EC0\u4E48\u9519"),
      SEC("\u81EA\u6D4B\u9898", "2~3 \u9898\uFF0C\u6BCF\u9898\u5E26 \u2192 \u7B54\u6848\u8981\u70B9\u4E0E\u300C\u7B54\u4E0D\u51FA \u2192 \u56DE\u770B X\u300D\u6307\u9488")
    ],
    optional: [REENTRY_SECTION, PREREQ_SECTION]
  }
};
function templateSpec(type) {
  const key = String(type ?? "").trim();
  return SPECS[key] ?? SPECS["\u7406\u8BBA\u578B"];
}
function isTemplateType(value) {
  return TEMPLATE_TYPES.includes(value);
}
var ENGINEERING_DOMAINS = ["\u56FE\u5F62\u5B66", "Unity", "Shader", "URP", "\u6E32\u67D3"];
var ENGINEERING_TITLE_HINTS = ["\u63A5\u5165", "\u914D\u7F6E", "\u53C2\u6570", "\u5751", "\u5B9E\u73B0", "\u6E90\u7801", "\u53D8\u4F53"];
var COMPARISON_TITLE_HINTS = ["\u5BF9\u6BD4", "\u8C31\u7CFB", "\u9009\u578B", "\u53D6\u820D", "\u5DEE\u5F02", "\u4E4B\u4E89", "vs"];
function inferTemplate(input) {
  const title = String(input.title ?? "");
  const domain = String(input.domain ?? "");
  const folder = String(input.mappedFolder ?? "");
  if (COMPARISON_TITLE_HINTS.some((h) => title.includes(h))) return "\u5BF9\u6BD4\u578B";
  const domainText = `${domain} ${folder}`;
  if (ENGINEERING_DOMAINS.some((d) => domainText.includes(d))) return "\u5DE5\u7A0B\u578B";
  if (ENGINEERING_TITLE_HINTS.some((h) => title.includes(h))) return "\u5DE5\u7A0B\u578B";
  return "\u7406\u8BBA\u578B";
}
function checkTemplate(type, body) {
  const spec = templateSpec(type);
  const text = String(body ?? "");
  const sections = splitSections(text).sections;
  const has = (title) => hasSection(sections, title);
  const present = spec.required.filter((s) => has(s.title)).map((s) => s.title);
  return {
    type: spec.type,
    present,
    missing: spec.required.filter((s) => !has(s.title)),
    missingOptional: spec.optional.filter((s) => !has(s.title))
  };
}

// src/card.ts
var VALID_STATUS = ["\u8349\u7A3F", "\u5DF2\u786E\u8BA4", "\u9700\u66F4\u65B0"];
var TEMPLATE_SECTIONS = templateSpec("\u7406\u8BBA\u578B").required.map((s) => ({ title: s.title, hint: s.hint }));
function generateId(now = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}_${randomBytes(2).toString("hex")}`;
}
function todayLocal(now = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
var DEFINITION_TARGET = 30;
var DEFINITION_MAX = 60;
function validateDefinition(definition) {
  const errors = [];
  const warnings = [];
  const def = String(definition ?? "");
  if (!def.trim()) {
    errors.push("definition\uFF08\u4E00\u53E5\u8BDD\u5B9A\u4E49\uFF09\u4E0D\u80FD\u4E3A\u7A7A");
  } else if (def.length > DEFINITION_MAX) {
    errors.push(`\u5B9A\u4E49 ${def.length} \u5B57\uFF0C\u8D85\u8FC7 ${DEFINITION_MAX} \u5B57\u786C\u4E0A\u9650\uFF1B\u8BF7\u7CBE\u7B80\u5230 \u2264${DEFINITION_MAX} \u5B57\uFF08${DEFINITION_TARGET} \u5B57\u5DE6\u53F3\u6700\u4F73\uFF09`);
  } else if (def.length > DEFINITION_TARGET) {
    const tier = def.length >= 46 ? `\u5B9A\u4E49 ${def.length} \u5B57\uFF0C\u504F\u957F\uFF08\u63A5\u8FD1 ${DEFINITION_MAX} \u5B57\u4E0A\u9650\uFF09` : `\u5B9A\u4E49 ${def.length} \u5B57\uFF0C\u7A0D\u957F\uFF08\u2264${DEFINITION_TARGET} \u5B57\u6700\u4F73\uFF09`;
    warnings.push(`${tier}\uFF1B\u5141\u8BB8\u653E\u884C\uFF0C\u5EFA\u8BAE\u7CBE\u7B80\u5230 \u2264${DEFINITION_TARGET} \u5B57`);
  }
  return { errors, warnings };
}
function resolveTemplate(input, opts = {}) {
  const declared = String(opts.template ?? input.template ?? "").trim();
  if (declared) {
    if (!isTemplateType(declared)) {
      return { type: "\u7406\u8BBA\u578B", error: `template \u5FC5\u987B\u662F \u7406\u8BBA\u578B/\u5DE5\u7A0B\u578B/\u5BF9\u6BD4\u578B \u4E4B\u4E00\uFF0C\u6536\u5230 "${declared}"` };
    }
    return { type: declared };
  }
  return { type: inferTemplate({ title: String(input.title ?? ""), domain: String(input.domain ?? ""), mappedFolder: opts.mappedFolder }) };
}
function validateCard(input, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!input.title?.trim()) errors.push("title \u4E0D\u80FD\u4E3A\u7A7A");
  if (!input.domain?.trim()) errors.push("domain \u4E0D\u80FD\u4E3A\u7A7A");
  if (!input.source?.trim()) errors.push("source\uFF08\u8D44\u6599\u540D\u79F0\uFF09\u4E0D\u80FD\u4E3A\u7A7A");
  if (!input.status?.trim()) errors.push("status \u4E0D\u80FD\u4E3A\u7A7A");
  else if (!VALID_STATUS.includes(input.status)) {
    errors.push(`status \u5FC5\u987B\u662F ${VALID_STATUS.join("/")} \u4E4B\u4E00\uFF0C\u6536\u5230 "${input.status}"`);
  }
  const template = resolveTemplate(input, opts);
  if (template.error) errors.push(template.error);
  const defResult = validateDefinition(input.definition ?? "");
  errors.push(...defResult.errors);
  warnings.push(...defResult.warnings);
  if (!input.content?.trim()) errors.push("content\uFF08\u6838\u5FC3\u5185\u5BB9\uFF09\u4E0D\u80FD\u4E3A\u7A7A");
  if (String(input.content ?? "").trim()) {
    const check = checkTemplate(template.type, String(input.content));
    for (const section of check.missing) {
      warnings.push(`\u6B63\u6587\u7F3A\u5C11 "### ${section.title}" \u5C0F\u8282\uFF08${template.type}\u5FC5\u586B\uFF1A${section.hint}\uFF09`);
    }
    for (const section of check.missingOptional) {
      warnings.push(`\u6B63\u6587\u7F3A\u5C11 "### ${section.title}" \u5C0F\u8282\uFF08${template.type}\u63A8\u8350\uFF1A${section.hint}\uFF09`);
    }
  }
  return { errors, warnings };
}
function linksSection(links) {
  if (!links) return "";
  const lines = [];
  if (links.prev?.length) lines.push(`- \u524D\u7F6E\uFF1A${links.prev.join("\u3001")}`);
  if (links.next?.length) lines.push(`- \u540E\u7EED\uFF1A${links.next.join("\u3001")}`);
  if (links.conflict?.length) lines.push(`- \u6613\u6DF7\u6DC6\uFF1A${links.conflict.join("\u3001")}`);
  if (lines.length === 0) return "";
  return `
### \u5173\u8054\u5361\u7247
${lines.join("\n")}
`;
}
function renderCard(card) {
  const tags = [.../* @__PURE__ */ new Set([card.domain, ...card.tags ?? []])];
  const meta = {
    id: card.id,
    title: card.title,
    domain: tags.map((t) => `#${t}`).join(" "),
    source: card.source,
    status: card.status,
    template: card.template
  };
  const body = `> ${card.definition}

${card.content.trim()}
` + linksSection(card.links);
  return `${renderFrontmatter(meta)}
${body}`;
}
function applyUpdate(raw, id, payload) {
  const warnings = [];
  if (payload.mode === "append-version") {
    if (!payload.changes?.trim()) throw new Error("append-version \u6A21\u5F0F\u9700\u8981 changes \u5185\u5BB9");
    const src = payload.source?.trim() || "\u5B66\u4E60\u8865\u5145";
    return { text: insertHistoryBlock(raw, versionBlock(src, payload.changes)), warnings };
  }
  if (payload.mode === "errata") {
    if (!payload.changes?.trim()) throw new Error("errata \u6A21\u5F0F\u9700\u8981 changes \u5185\u5BB9\uFF08\u542B\u7EA0\u6B63\u539F\u56E0\uFF09");
    return { text: insertHistoryBlock(raw, errataBlock(payload.changes)), warnings };
  }
  if (payload.mode === "definition") {
    const result = validateDefinition(payload.definition ?? "");
    if (result.errors.length > 0) {
      throw new Error(`definition \u6A21\u5F0F\u6821\u9A8C\u5931\u8D25\uFF1A${result.errors.join("\uFF1B")}`);
    }
    warnings.push(...result.warnings);
    const parsed = parseFrontmatter(raw);
    const fm = raw.slice(0, raw.length - parsed.body.length);
    const body = parsed.body;
    const trimmed = body.trimStart();
    if (!trimmed.startsWith(">")) {
      throw new Error("definition \u6A21\u5F0F\u8981\u6C42\u5361\u7247\u6B63\u6587\u9996\u884C\u4E3A\u5B9A\u4E49\u5F15\u7528\u5757\uFF08> \u5B9A\u4E49\uFF09\uFF1B\u975E\u6807\u51C6\u5361\u7247\u8BF7\u7528 replace \u6216\u624B\u52A8\u4FEE\u6B63");
    }
    const lead = body.slice(0, body.length - trimmed.length);
    const lineEndRel = trimmed.indexOf("\n");
    const lineEnd = lead.length + (lineEndRel === -1 ? trimmed.length : lineEndRel);
    const next = `${body.slice(0, lead.length)}> ${payload.definition.trim()}${body.slice(lineEnd)}`;
    return { text: `${fm}${next}`, warnings };
  }
  if (payload.mode === "replace") {
    if (!payload.card) throw new Error("replace \u6A21\u5F0F\u9700\u8981 card \u5B57\u6BB5\uFF08\u65B0\u5361\u5185\u5BB9\uFF09");
    const oldTemplate = parseFrontmatter(raw).meta?.template;
    const resolved = resolveTemplate(
      { ...payload.card, template: payload.card.template ?? oldTemplate },
      { mappedFolder: payload.mappedFolder }
    );
    const card = { ...payload.card, template: resolved.type };
    const result = validateCard(card);
    if (result.errors.length > 0) throw new Error(`replace \u65B0\u5361\u6821\u9A8C\u5931\u8D25\uFF1A${result.errors.join("\uFF1B")}`);
    warnings.push(...result.warnings);
    const oldBody = parseFrontmatter(raw).body.trim();
    const rendered = renderCard({ ...card, id }).trimEnd();
    const date = todayLocal();
    const history = `

<details>
<summary>\u5386\u53F2\u7248\u672C\uFF08${date}\uFF09</summary>

${oldBody}

</details>
`;
    return { text: rendered + history, warnings };
  }
  throw new Error(`\u672A\u77E5\u66F4\u65B0\u6A21\u5F0F "${String(payload.mode)}"\uFF0C\u53EF\u7528\uFF1Aappend-version / errata / definition / replace`);
}
function stripMocDatePrefix(title) {
  return String(title ?? "").trim().replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, "").trim();
}
var LINK_LABELS = {
  prev: "\u524D\u7F6E",
  next: "\u540E\u7EED",
  conflict: "\u6613\u6DF7\u6DC6"
};
function linkTargetTitle(label) {
  return String(label ?? "").replace(/`/g, "").replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
}
function linkTargetId(label) {
  const m = /[（(]([^（()）]*)[)）]\s*$/.exec(String(label ?? ""));
  return m ? m[1].trim() : "";
}
function normalizeLinkLabel(label) {
  const text = String(label ?? "").trim();
  if (!text || text.includes("`")) return text;
  const title = linkTargetTitle(text);
  const anchor = linkTargetId(text);
  if (!title) return text;
  return anchor ? `\`${title}\`\uFF08${anchor}\uFF09` : `\`${title}\``;
}
function addLink(raw, kind, targetLabel, targetId) {
  const label = LINK_LABELS[kind];
  const title = linkTargetTitle(targetLabel);
  const anchor = targetId?.trim() || linkTargetId(targetLabel);
  const bodyText = parseFrontmatter(raw).body;
  const existing = bodyText.split(/\r?\n/).filter((line2) => /^[ \t]*-/.test(line2));
  const duplicated = existing.some((line2) => {
    const lineTitle = linkTargetTitle(line2.replace(/^[ \t]*-\s*(?:前置|后续|易混淆)\s*[：:]\s*/, ""));
    const lineAnchor = linkTargetId(line2);
    if (anchor && lineAnchor && lineAnchor === anchor) return true;
    return Boolean(title) && lineTitle === title;
  });
  if (duplicated) return raw;
  const parsed = parseFrontmatter(raw);
  const fm = raw.slice(0, raw.length - parsed.body.length);
  const body = parsed.body.trimEnd();
  const heading = "### \u5173\u8054\u5361\u7247";
  const line = `- ${label}\uFF1A${normalizeLinkLabel(targetLabel)}
`;
  const idx = body.indexOf(heading);
  if (idx === -1) {
    return `${fm}${body}

${heading}
${line}`;
  }
  const afterHeading = body.indexOf("\n", idx + heading.length);
  const insertAt = afterHeading === -1 ? body.length : afterHeading + 1;
  return `${fm}${body.slice(0, insertAt)}${line}${body.slice(insertAt)}`;
}
function renderMoc(title, date, entries) {
  const groups = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const list = groups.get(e.domain) ?? [];
    list.push(e);
    groups.set(e.domain, list);
  }
  const lines = [`# ${title}`, "", `> \u77E5\u8BC6\u76EE\u5F55\uFF08MOC\uFF09\xB7 ${date}`, ""];
  for (const [domain, list] of groups) {
    lines.push(`## ${domain}`);
    for (const e of list) lines.push(`- [[${e.fileName.replace(/\.md$/, "")}]]\uFF08${e.id}\uFF09${e.title !== e.fileName.replace(/\.md$/, "") ? `\xB7 ${e.title}` : ""}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}
`;
}

// src/insight.ts
var SKIP_TABLE_COLUMNS = /* @__PURE__ */ new Set(["\u75C7\u72B6", "\u5224\u636E", "\u4FEE\u590D", "\u73B0\u8C61", "\u539F\u56E0", "\u5904\u7406", "\u5C42", "\u5C42\u7EA7", "\u5E8F\u53F7"]);
function normalizeValue(value) {
  return String(value ?? "").replace(/[`*]/g, "").replace(/[。；;,，\s]+$/g, "").replace(/\s+/g, " ").trim();
}
function normalizeKey(key) {
  return String(key ?? "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
}
function extractFacts(cardLabel, body) {
  const facts = [];
  const text = String(body ?? "");
  const { sections } = splitSections(text);
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  for (const section of sections) {
    const startLine = lineOf(section.start);
    const lines = section.body.split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      const tableMatch = /^\|(.+)\|\s*$/.exec(trimmed);
      if (tableMatch) {
        const cells = tableMatch[1].split("|").map((c) => c.trim());
        if (cells.length >= 2 && !/^:?-{2,}:?$/.test(cells[0]) && cells[0] !== "") {
          const key = normalizeKey(cells[0]);
          const value = normalizeValue(cells[1]);
          if (key && value && !SKIP_TABLE_COLUMNS.has(key) && !/^:?-{2,}:?$/.test(value)) {
            facts.push({ key, value, card: cardLabel, section: section.title, line: startLine + i + 1 });
          }
        }
        return;
      }
      const formula = /\$\s*([A-Za-z\\][^$=]{0,24})\s*=\s*([^$]{1,32})\$/.exec(trimmed) ?? /^([A-Za-z\u0370-\u03ff][\w\s]{0,16})\s*=\s*([^=]{1,32})$/.exec(trimmed);
      if (formula) {
        const key = normalizeKey(formula[1]);
        const value = normalizeValue(formula[2]);
        if (key && value) facts.push({ key, value, card: cardLabel, section: section.title, line: startLine + i + 1 });
      }
    });
  }
  return facts;
}
function crossCardConflicts(cards) {
  const byKey = /* @__PURE__ */ new Map();
  for (const card of cards) {
    for (const fact of extractFacts(card.label, card.body)) {
      const values = byKey.get(fact.key) ?? /* @__PURE__ */ new Map();
      const cards4Value = values.get(fact.value) ?? /* @__PURE__ */ new Set();
      cards4Value.add(fact.card);
      values.set(fact.value, cards4Value);
      byKey.set(fact.key, values);
    }
  }
  const groups = [];
  for (const [key, values] of byKey) {
    if (values.size < 2) continue;
    const variants = [...values.entries()].map(([value, cards4Value]) => ({ value, cards: [...cards4Value] }));
    const cards2 = new Set(variants.flatMap((v) => v.cards)).size;
    groups.push({ key, variants, cards: cards2 });
  }
  return groups.sort((a, b) => b.cards - a.cards || a.key.localeCompare(b.key));
}
function formatConflicts(groups, limit = 20) {
  if (groups.length === 0) return "\u8DE8\u5361\u4E00\u81F4\u6027\uFF1A\u672A\u53D1\u73B0\u540C\u952E\u53D6\u503C\u51B2\u7A81\u3002";
  const lines = [`\u8DE8\u5361\u4E00\u81F4\u6027\uFF1A${groups.length} \u7EC4\u540C\u952E\u53D6\u503C\u51B2\u7A81\uFF08\u540C\u952E \u22652 \u79CD\u503C\uFF09`];
  for (const group of groups.slice(0, limit)) {
    lines.push(`- ${group.key}\uFF08${group.cards} \u5F20\u5361\uFF09`);
    for (const v of group.variants) {
      lines.push(`    = ${v.value}  \u2190 ${v.cards.slice(0, 3).join("\u3001")}${v.cards.length > 3 ? " \u7B49" : ""}`);
    }
  }
  return lines.join("\n");
}
function dateOfCardId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(id ?? ""));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
function isoWeek(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function qualityTrend(entries) {
  const buckets = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const date = dateOfCardId(entry.id);
    const week = date ? isoWeek(date) : null;
    if (!week) continue;
    const bucket = buckets.get(week) ?? { scores: [], rules: /* @__PURE__ */ new Map() };
    bucket.scores.push(entry.report.score);
    for (const rule of new Set(entry.report.findings.map((f) => f.rule))) {
      bucket.rules.set(rule, (bucket.rules.get(rule) ?? 0) + 1);
    }
    buckets.set(week, bucket);
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, bucket]) => ({
    week,
    cards: bucket.scores.length,
    averageScore: Math.round(bucket.scores.reduce((s, v) => s + v, 0) / bucket.scores.length),
    topRules: [...bucket.rules.entries()].map(([rule, cards]) => ({ rule, cards })).sort((a, b) => b.cards - a.cards).slice(0, 3)
  }));
}
function formatTrend(buckets) {
  if (buckets.length === 0) return "\u8D28\u91CF\u8D8B\u52BF\uFF1A\u5361\u7247 ID \u65E0\u6CD5\u89E3\u6790\u65E5\u671F\uFF08\u6216\u6CA1\u6709\u5361\u7247\uFF09\u3002";
  const lines = [`\u8D28\u91CF\u8D8B\u52BF\uFF08${buckets.length} \u5468\uFF0C\u6309\u5361\u7247 ID \u65E5\u671F\u5F52\u5468\uFF09\uFF1A`];
  for (const bucket of buckets) {
    const rules = bucket.topRules.map((r) => `${r.rule}\xD7${r.cards}`).join("\u3001");
    lines.push(`- ${bucket.week}\uFF1A${bucket.cards} \u5F20\uFF0C\u5747\u5206 ${bucket.averageScore}${rules ? `\uFF0C\u77ED\u677F\uFF1A${rules}` : ""}`);
  }
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (buckets.length > 1) {
    const delta = last.averageScore - first.averageScore;
    lines.push(`\u8D8B\u52BF\uFF1A${first.week} ${first.averageScore} \u2192 ${last.week} ${last.averageScore}\uFF08${delta >= 0 ? "+" : ""}${delta}\uFF09`);
  }
  return lines.join("\n");
}
function executabilityOf(body) {
  const sections = splitSections(body).sections;
  const hasCode = codeFenceLanguages(body).length > 0;
  const hasExperiment = findSection(sections, "\u9A8C\u8BC1\u5B9E\u9A8C") !== void 0;
  if (hasCode && hasExperiment) return "\u80FD\u8DD1";
  const hasQuery = findSection(sections, "\u6392\u969C\u5224\u636E") !== void 0 || findSection(sections, "\u5BF9\u6BD4\u8868") !== void 0;
  return hasQuery ? "\u80FD\u67E5" : "\u53EA\u80FD\u8BFB";
}
function executabilitySummary(entries) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const rating = executabilityOf(entry.body);
    counts.set(rating, (counts.get(rating) ?? 0) + 1);
  }
  return ["\u80FD\u8DD1", "\u80FD\u67E5", "\u53EA\u80FD\u8BFB"].map((rating) => ({ rating, count: counts.get(rating) ?? 0 })).filter((row) => row.count > 0);
}

// src/lintrules.ts
var RESIDUE_PATH_RE = /(?:[A-Za-z]:\\|Assets[\\/]|\.(?:shader|unity|mat|asset|hlsl|cs|cginc|compute)\b)/;
var RESIDUE_LINE_RE = /\bL\d+(?:\s*[-–]\s*L?\d+)?\b/;
var RESIDUE_PERSON_RE = /你|我们|咱们/;
var RESIDUE_TIME_RE = /上次|本次|刚才|刚刚|昨天|前天|前几讲/;
var RESIDUE_PHASE_RE = /\b(?:P[0-3]|W[1-9])\b/;
var RESIDUE_SESSION_RE = /本工程|本卡会话|实测|排查顺序|先证据后结论|课上/;
var LINE_WHITELIST_RE = /\bL[0-2]\b(?!\s*[-–~]\s*L?\d)|LOD/;
var LECTURE_REF_RE = /(?:[A-Za-z]+\s*)?L\d+\b[^。；\n]{0,12}(?:讲|课|课件)|第\s*\d+\s*讲|Lecture\s*\d+/i;
var SUGGESTIONS = {
  path: '\u5220\u6389\u672C\u673A\u8DEF\u5F84\uFF0C\u6539\u6210"\u6E90\u7801\u91CC XX \u51FD\u6570"\u8FD9\u7C7B\u4E0D\u4F9D\u8D56\u673A\u5668\u7684\u8BF4\u6CD5',
  line: '\u5220\u6389\u884C\u53F7\u6216\u6539\u6210\u7B26\u53F7\u540D\uFF08\u5982"RealtimeLights \u91CC\u7684 XXX \u51FD\u6570"\uFF09\uFF1B\u884C\u53F7\u4F1A\u968F\u7248\u672C\u5931\u6548',
  person: '\u6539\u6210\u7B2C\u4E09\u4EBA\u79F0\u9648\u8FF0\uFF08"shader \u9700\u8981\u2026"\uFF09\uFF0C\u5361\u7247\u9762\u5411\u534A\u5E74\u540E\u7684\u81EA\u5DF1',
  time: "\u5220\u6389\u4F1A\u8BDD\u76F8\u5BF9\u65F6\u95F4\uFF0C\u6539\u6210\u7EDD\u5BF9\u51FA\u5904\uFF08\u4E66\u540D/\u7AE0\u8282/\u65E5\u671F\uFF09",
  phase: '\u628A\u9636\u6BB5\u4EE3\u53F7\u6362\u6210\u5B83\u7684\u542B\u4E49\uFF08\u5982"W2"\u2192"\u63A5\u5165 IBL \u4E4B\u540E"\uFF09',
  session: "\u5220\u6389\u4F1A\u8BDD\u53E3\u543B\u8BCD\uFF0C\u6539\u6210\u5BF9\u73B0\u8C61\u7684\u5BA2\u89C2\u63CF\u8FF0"
};
function excerptOf(line, index, width = 16) {
  const start = Math.max(0, index - width);
  return line.slice(start, index + width + 12).replace(/\s+/g, " ").trim();
}
function scanResidue(body) {
  const text = blankOutBlocks(body);
  const lines = text.split(/\r?\n/);
  const hits = [];
  const push = (rule, lineNo, line, index) => {
    hits.push({ rule, line: lineNo, excerpt: excerptOf(line, index), suggestion: SUGGESTIONS[rule] });
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (!line.trim()) return;
    const quoted = /^[ \t]*>/.test(line);
    const lineMatch = RESIDUE_LINE_RE.exec(line);
    if (lineMatch && !LINE_WHITELIST_RE.test(lineMatch[0]) && !LECTURE_REF_RE.test(line)) {
      const before = line.slice(0, lineMatch.index);
      const after = line.slice(lineMatch.index + lineMatch[0].length);
      const nearFile = /\.[a-z0-9]{2,6}[`）)\s]*$/i.test(before);
      const isRange = /[-–]\s*L?\d/.test(lineMatch[0]);
      const fileAfter = /^[`\s]*[\w./\\-]+\.[a-z0-9]{2,6}/i.test(after);
      if (nearFile || isRange || fileAfter) push("line", lineNo, line, lineMatch.index);
    }
    const pathMatch = RESIDUE_PATH_RE.exec(line);
    if (pathMatch) push("path", lineNo, line, pathMatch.index);
    if (!quoted) {
      const personMatch = RESIDUE_PERSON_RE.exec(line);
      if (personMatch) push("person", lineNo, line, personMatch.index);
      const timeMatch = RESIDUE_TIME_RE.exec(line);
      if (timeMatch) push("time", lineNo, line, timeMatch.index);
      const phaseMatch = RESIDUE_PHASE_RE.exec(line);
      if (phaseMatch) push("phase", lineNo, line, phaseMatch.index);
      const sessionMatch = RESIDUE_SESSION_RE.exec(line);
      if (sessionMatch) push("session", lineNo, line, sessionMatch.index);
      const milestone = /\bM[1-3]\b/.exec(line);
      if (milestone && /工程|阶段|里程碑|排期/.test(line)) push("phase", lineNo, line, milestone.index);
    }
  });
  return hits;
}
function checkCodeFences(body) {
  const langs = codeFenceLanguages(body);
  const unlabeledIndexes = langs.map((l, i) => l.trim() === "" ? i + 1 : 0).filter((n) => n > 0);
  return { total: langs.length, unlabeled: unlabeledIndexes.length, unlabeledIndexes };
}
function checkSelfTest(body) {
  const section = findSection(splitSections(body).sections, "\u81EA\u6D4B\u9898");
  const text = section?.body ?? "";
  const qn = [...text.matchAll(/^[ \t]*(?:[-*+][ \t]*)?\*{0,2}Q(\d+)\*{0,2}[ \t]*[:：]/gm)];
  const numbered = [...text.matchAll(/^[ \t]*(\d+)[.)][ \t]+\S/gm)];
  const usesQn = qn.length > 0;
  const usesNumbered = !usesQn && numbered.length > 0;
  const questions = usesQn ? qn.length : numbered.length;
  const missing = [];
  let answered = 0;
  if (usesQn) {
    for (const m of qn) {
      const start = (m.index ?? 0) + m[0].length;
      const nextIdx = text.indexOf("\n", start);
      const line = text.slice(m.index ?? 0, nextIdx === -1 ? text.length : nextIdx);
      if (line.includes("\u2192")) answered += 1;
      else missing.push(Number(m[1]));
    }
  } else {
    const lines = text.split(/\r?\n/).filter((l) => /^[ \t]*\d+[.)][ \t]+\S/.test(l));
    lines.forEach((line, i) => {
      if (line.includes("\u2192")) answered += 1;
      else missing.push(i + 1);
    });
  }
  return { questions, answered, missing, usesQn, usesNumbered };
}
function checkLayers(body) {
  const section = findSection(splitSections(body).sections, "\u9636\u68AF\u5F0F\u89E3\u5256");
  const text = section ? `${section.title}
${section.body}` : body;
  const layers = layerNumbers(text);
  const sequential = layers.length > 0 && layers.every((n, i) => n === i + 1);
  return { layers, inRange: layers.length >= 4 && layers.length <= 6, sequential, hasNumbers: layers.length > 0 };
}
function checkDomainTags(tags, knownKeys = []) {
  const list = tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
  const keys = knownKeys.map((k) => String(k));
  const roots = [];
  const children = [];
  for (const tag of list) {
    const isRoot = list.some((other) => other !== tag && other.startsWith(`${tag}-`)) || keys.some((k) => k.startsWith(`${tag}-`));
    if (isRoot) {
      roots.push(tag);
      continue;
    }
    const isChild = tag.includes("-") && (list.some((other) => other !== tag && tag.startsWith(`${other}-`)) || keys.some((k) => tag.startsWith(`${k}-`)));
    if (isChild) children.push(tag);
  }
  return { tags: list, roots, children, mixed: roots.length > 0 && children.length > 0 };
}
function checkLinksBlock(body) {
  const section = findSection(splitSections(body).sections, "\u5173\u8054\u5361\u7247");
  if (!section) return { present: false, malformed: [], lines: [] };
  const lines = section.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("-"));
  const malformed = lines.filter((l) => !/^-\s*(?:前置|后续|易混淆)\s*[：:]\s*\S/.test(l));
  return { present: true, malformed, lines };
}
function checkExperiments(body) {
  const section = findSection(splitSections(body).sections, "\u9A8C\u8BC1\u5B9E\u9A8C");
  if (!section) return { present: false, steps: 0 };
  const items = countListItems(section.body);
  return { present: true, steps: items > 0 ? items : section.body.trim() ? 1 : 0 };
}
function checkMainline(body) {
  const sections = splitSections(body).sections.filter((s) => matchesTitle(s.title, "\u4E3B\u5E72\u7EBF"));
  return { count: sections.length };
}
function bodyLength(body) {
  return blankOutBlocks(body).replace(/\s+/g, "").length;
}

// src/lint.ts
var LINT_DEFINITION_MAX = 60;
var RULE_TITLES = {
  "session-residue": "\u4F1A\u8BDD\u6B8B\u7559",
  "definition-length": "\u5B9A\u4E49\u957F\u5EA6",
  "template-sections": "\u6A21\u677F\u5FC5\u586B\u5C0F\u8282",
  "mainline": "\u4E3B\u5E72\u7EBF\u552F\u4E00",
  "prereq-check": "\u524D\u7F6E\u68C0\u67E5",
  "reentry-point": "\u91CD\u5165\u70B9",
  "verify-experiment": "\u9A8C\u8BC1\u5B9E\u9A8C",
  "troubleshoot-criteria": "\u6392\u969C\u5224\u636E",
  "code-language": "\u4EE3\u7801\u5757\u8BED\u8A00",
  "selftest-answer": "\u81EA\u6D4B\u9898\u7B54\u6848",
  "layer-number": "\u5C42\u7EA7\u5E8F\u53F7",
  "links-format": "\u5173\u8054\u5757\u683C\u5F0F",
  "domain-tag": "\u9886\u57DF\u6807\u7B7E",
  "walkthrough": "\u5B9E\u4F8B\u8D70\u67E5"
};
var WEIGHTS = {
  "session-residue": 10,
  "definition-length": 8,
  "template-sections": 5,
  "mainline": 5,
  "prereq-check": 3,
  "reentry-point": 3,
  "verify-experiment": 5,
  "troubleshoot-criteria": 5,
  "code-language": 3,
  "selftest-answer": 3,
  "layer-number": 3,
  "links-format": 3,
  "domain-tag": 3,
  "walkthrough": 3
};
function ruleIds() {
  return Object.keys(WEIGHTS);
}
function ruleTitle(id) {
  return RULE_TITLES[id] ?? id;
}
var RESIDUE_LABEL = {
  path: "\u672C\u673A\u8DEF\u5F84",
  line: "\u6E90\u7801\u884C\u53F7",
  person: "\u7B2C\u4E8C\u4EBA\u79F0",
  time: "\u4F1A\u8BDD\u65F6\u95F4\u8BCD",
  phase: "\u9636\u6BB5\u4EE3\u53F7",
  session: "\u4F1A\u8BDD\u53E3\u543B"
};
function finding(rule, severity, message, extra = {}) {
  return {
    rule,
    severity,
    title: ruleTitle(rule),
    message,
    line: extra.line ?? 0,
    excerpt: extra.excerpt,
    suggestion: extra.suggestion,
    weight: WEIGHTS[rule]
  };
}
function lintCard(input, ctx = {}) {
  const body = String(input.body ?? "");
  const definition = String(input.definition ?? "");
  const off = new Set(ctx.rulesOff ?? []);
  const findings = [];
  const passed = {};
  const spec = templateSpec(input.template);
  const sections = splitSections(body).sections;
  const mark = (rule, ok) => {
    passed[rule] = ok;
  };
  const residue = scanResidue(body);
  const residueLevel = ctx.residueLevel ?? "warn";
  const residueFindings = residueLevel === "off" || off.has("session-residue") ? [] : residue.map((h) => finding(
    "session-residue",
    residueLevel === "error" ? "error" : "warn",
    `\u7B2C ${h.line} \u884C\uFF1A${RESIDUE_LABEL[h.rule]}\u300C${h.excerpt}\u300D`,
    { line: h.line, excerpt: h.excerpt, suggestion: h.suggestion }
  ));
  findings.push(...residueFindings);
  mark("session-residue", residueFindings.length === 0);
  if (!off.has("definition-length")) {
    const len = definition.length;
    if (len > LINT_DEFINITION_MAX) {
      findings.push(finding("definition-length", "warn", `\u5B9A\u4E49 ${len} \u5B57\uFF0C\u8D85\u8FC7 ${LINT_DEFINITION_MAX} \u5B57\u786C\u4E0A\u9650\uFF08card_create \u4F1A\u76F4\u63A5\u62D2\u7EDD\uFF09`, { suggestion: "\u7CBE\u7B80\u5230 30 \u5B57\u5DE6\u53F3" }));
    }
    mark("definition-length", len <= LINT_DEFINITION_MAX);
  }
  if (!off.has("template-sections")) {
    const check = checkTemplate(spec.type, body);
    for (const missing of check.missing) {
      findings.push(finding("template-sections", "warn", `\u7F3A\u5C11 "### ${missing.title}" \u5C0F\u8282\uFF08${spec.type}\uFF1A${missing.hint}\uFF09`, { suggestion: `\u8865\u5199 ${missing.title}` }));
    }
    mark("template-sections", check.missing.length === 0);
  }
  if (!off.has("mainline")) {
    const { count } = checkMainline(body);
    if (count === 0) findings.push(finding("mainline", "warn", '\u7F3A\u5C11 "### \u4E3B\u5E72\u7EBF"\uFF08\u7528\u4E00\u53E5\u8BDD\u5199"\u95EE\u9898 \u2192 \u7EA6\u675F \u2192 \u89E3\u6CD5 \u2192 \u4EE3\u4EF7 \u2192 \u9A8C\u8BC1"\uFF09', { suggestion: "\u8865\u5199\u4E3B\u5E72\u7EBF" }));
    else if (count > 1) findings.push(finding("mainline", "warn", `\u51FA\u73B0 ${count} \u4E2A "### \u4E3B\u5E72\u7EBF" \u5C0F\u8282\uFF0C\u4E3B\u5E72\u7EBF\u5FC5\u987B\u552F\u4E00`, { suggestion: "\u5408\u5E76\u4E3A\u4E00\u6761" }));
    mark("mainline", count === 1);
  }
  if (!off.has("prereq-check")) {
    const links = findSection(sections, "\u5173\u8054\u5361\u7247");
    const hasPrev = links ? /^[ \t]*-[ \t]*前置[：:]/m.test(links.body) : false;
    const ok = hasSection(sections, "\u524D\u7F6E\u68C0\u67E5") || !hasPrev;
    if (!ok) findings.push(finding("prereq-check", "warn", '\u5361\u5185\u6709"\u524D\u7F6E"\u5173\u8054\u4F46\u7F3A "### \u524D\u7F6E\u68C0\u67E5"\uFF08\u5217\u51FA\u9700\u8981\u77E5\u9053\u7684\u6982\u5FF5\u4E0E\u5361\u7247 ID\uFF09', { suggestion: "\u8865\u5199\u524D\u7F6E\u68C0\u67E5" }));
    mark("prereq-check", ok);
  }
  if (!off.has("reentry-point")) {
    const chars2 = bodyLength(body);
    const ok = hasSection(sections, "\u91CD\u5165\u70B9") || chars2 <= 3e3;
    if (!ok) findings.push(finding("reentry-point", "warn", `\u6B63\u6587 ${chars2} \u5B57\uFF08>3000\uFF09\u4F46\u7F3A "### \u91CD\u5165\u70B9"\uFF0830 \u79D2 / 5 \u5206\u949F / 30 \u5206\u949F\u4E09\u79CD\u8BFB\u6CD5\uFF09`, { suggestion: "\u8865\u5199\u91CD\u5165\u70B9" }));
    mark("reentry-point", ok);
  }
  if (!off.has("verify-experiment")) {
    const required = spec.required.some((s) => s.title === "\u9A8C\u8BC1\u5B9E\u9A8C");
    const { present, steps } = checkExperiments(body);
    const ok = !required || present && steps >= 3;
    if (required && !present) findings.push(finding("verify-experiment", "warn", '\u5DE5\u7A0B\u578B\u5361\u7247\u7F3A "### \u9A8C\u8BC1\u5B9E\u9A8C"\uFF08\u22653 \u6B65\uFF0C\u6BCF\u6B65\u4E00\u53E5"\u770B\u5230\u4EC0\u4E48\u8BF4\u660E\u4EC0\u4E48"\uFF09', { suggestion: "\u8865\u5199\u9A8C\u8BC1\u5B9E\u9A8C" }));
    else if (required && steps < 3) findings.push(finding("verify-experiment", "warn", `\u9A8C\u8BC1\u5B9E\u9A8C\u53EA\u6709 ${steps} \u6B65\uFF08\u5DE5\u7A0B\u578B\u8981\u6C42 \u22653 \u6B65\uFF09`, { suggestion: "\u8865\u8DB3\u6B65\u9AA4" }));
    mark("verify-experiment", ok);
  }
  if (!off.has("troubleshoot-criteria")) {
    const required = spec.required.some((s) => s.title === "\u6392\u969C\u5224\u636E");
    const ok = !required || hasSection(sections, "\u6392\u969C\u5224\u636E");
    if (!ok) findings.push(finding("troubleshoot-criteria", "warn", '\u5DE5\u7A0B\u578B\u5361\u7247\u7F3A "### \u6392\u969C\u5224\u636E"\uFF08\u8868\u683C\uFF1A\u75C7\u72B6 | \u5224\u636E | \u4FEE\u590D\uFF09', { suggestion: "\u8865\u5199\u6392\u969C\u5224\u636E" }));
    mark("troubleshoot-criteria", ok);
  }
  if (!off.has("code-language")) {
    const check = checkCodeFences(body);
    if (check.unlabeled > 0) {
      findings.push(finding("code-language", "warn", `${check.unlabeled}/${check.total} \u4E2A\u4EE3\u7801\u5757\u672A\u6807\u8BED\u8A00\uFF08\u7B2C ${check.unlabeledIndexes.join("\u3001")} \u5757\uFF09`, { suggestion: "\u6807\u6CE8 hlsl/cpp/csharp/python/plaintext \u7B49" }));
    }
    mark("code-language", check.unlabeled === 0);
  }
  if (!off.has("selftest-answer")) {
    const check = checkSelfTest(body);
    if (check.missing.length > 0) {
      findings.push(finding("selftest-answer", "warn", `\u81EA\u6D4B\u9898\u7B2C ${check.missing.join("\u3001")} \u9898\u6CA1\u6709\u7B54\u6848\uFF08\u5E94\u4E3A "Qn\uFF1A\u2026 \u2192 \u7B54\u6848\u8981\u70B9"\uFF09`, { suggestion: '\u8865\u7B54\u6848\u8981\u70B9\uFF0C\u5E76\u52A0"\u7B54\u4E0D\u51FA \u2192 \u56DE\u770B X"' }));
    }
    if (check.usesNumbered) {
      findings.push(finding("selftest-answer", "warn", '\u81EA\u6D4B\u9898\u7528\u4E86 "1./2." \u7F16\u53F7\u5199\u6CD5\uFF0C\u89C4\u8303\u4E3A "**Q1**\uFF1A\u2026"', { suggestion: "\u6539\u4E3A Qn \u5199\u6CD5" }));
    }
    mark("selftest-answer", check.missing.length === 0 && !check.usesNumbered);
  }
  if (!off.has("layer-number")) {
    const check = checkLayers(body);
    const ok = check.hasNumbers && check.inRange && check.sequential;
    if (check.hasNumbers && !check.inRange) {
      findings.push(finding("layer-number", "warn", `\u9636\u68AF\u5F0F\u89E3\u5256\u4E3A ${check.layers.length} \u5C42\uFF08\u89C4\u8303 4~6 \u5C42\uFF09`, { suggestion: "\u5408\u5E76\u6216\u8865\u5145\u5C42\u7EA7" }));
    } else if (check.hasNumbers && !check.sequential) {
      findings.push(finding("layer-number", "warn", `\u5C42\u7EA7\u5E8F\u53F7\u4E0D\u8FDE\u7EED\uFF1A\u7B2C ${check.layers.join("\u3001")} \u5C42`, { suggestion: "\u6309 1\u2192N \u8FDE\u7EED\u7F16\u53F7" }));
    } else if (!check.hasNumbers && hasSection(sections, "\u9636\u68AF\u5F0F\u89E3\u5256")) {
      findings.push(finding("layer-number", "warn", '\u9636\u68AF\u5F0F\u89E3\u5256\u7F3A\u5C11 "\u7B2C N \u5C42" \u5E8F\u53F7', { suggestion: "\u8865\u5C42\u7EA7\u5E8F\u53F7" }));
    }
    mark("layer-number", ok);
  }
  if (!off.has("links-format")) {
    const check = checkLinksBlock(body);
    if (check.malformed.length > 0) {
      findings.push(finding("links-format", "warn", `\u5173\u8054\u5757\u6709 ${check.malformed.length} \u884C\u4E0D\u7B26\u5408 "- \u524D\u7F6E/\u540E\u7EED/\u6613\u6DF7\u6DC6\uFF1A\`\u6807\u9898\`\uFF08ID\uFF09" \u683C\u5F0F\uFF1A${check.malformed.slice(0, 2).join(" / ")}`, { suggestion: "\u7EDF\u4E00\u4E3A\u5E26 ID \u7684\u5173\u8054\u884C" }));
    }
    mark("links-format", check.malformed.length === 0);
  }
  if (!off.has("domain-tag")) {
    const check = checkDomainTags(input.tags ?? [], ctx.knownDomains ?? []);
    if (check.mixed) {
      findings.push(finding("domain-tag", "warn", `\u9886\u57DF\u6807\u7B7E\u540C\u65F6\u6302\u4E86\u6839\u57DF\u4E0E\u5B50\u57DF\uFF1A${check.roots.join("\u3001")} + ${check.children.join("\u3001")}`, { suggestion: "\u53EA\u4FDD\u7559\u7CBE\u786E\u7684\u5B50\u57DF\u952E\uFF08\u6216\u53EA\u4FDD\u7559\u6839\u57DF\uFF09" }));
    }
    mark("domain-tag", !check.mixed);
  }
  if (!off.has("walkthrough")) {
    const ok = hasSection(sections, "\u5B9E\u4F8B\u8D70\u67E5");
    if (!ok) findings.push(finding("walkthrough", "warn", '\u7F3A "### \u5B9E\u4F8B\u8D70\u67E5"\uFF08\u81F3\u5C11\u4E00\u79CD\uFF1A\u6570\u503C\u4EE3\u5165 / \u4EE3\u7801\u8D70\u67E5 / \u573A\u666F\u8D70\u67E5\uFF09', { suggestion: "\u8865\u5B9E\u4F8B\u8D70\u67E5" }));
    mark("walkthrough", ok);
  }
  const deducted = findings.reduce((sum, f) => sum + f.weight, 0);
  let score = Math.max(0, 100 - deducted);
  if (findings.some((f) => f.severity === "error")) score = Math.min(score, 59);
  const chars = bodyLength(body);
  return {
    title: String(input.title ?? "").trim() || "\uFF08\u65E0\u6807\u9898\uFF09",
    template: spec.type,
    score,
    chars,
    findings,
    passed
  };
}
var ICON = { error: "\u2717", warn: "\u26A0", info: "\xB7" };
function formatReport(report) {
  const lines = [`\u5361\u7247\uFF1A${report.title}  \u6A21\u677F\uFF1A${report.template}  \u603B\u5206\uFF1A${report.score}/100\uFF08\u6B63\u6587 ${report.chars} \u5B57\uFF09`];
  const okRules = Object.entries(report.passed).filter(([, ok]) => ok).map(([rule]) => ruleTitle(rule));
  if (okRules.length > 0) lines.push(`  \u2713 \u901A\u8FC7\uFF1A${okRules.join("\u3001")}`);
  for (const f of report.findings) {
    lines.push(`  ${ICON[f.severity]} ${f.title}\uFF1A${f.message}`);
    if (f.suggestion) lines.push(`      \u5EFA\u8BAE\uFF1A${f.suggestion}`);
  }
  if (report.findings.length === 0) lines.push("  \u2713 \u65E0\u95EE\u9898");
  return lines.join("\n");
}
function summarizeLint(reports, titles) {
  const ruleMap = /* @__PURE__ */ new Map();
  const buckets = /* @__PURE__ */ new Map();
  for (const report of reports) {
    const seen = /* @__PURE__ */ new Set();
    for (const f of report.findings) {
      const entry = ruleMap.get(f.rule) ?? { cards: 0, hits: 0 };
      entry.hits += 1;
      if (!seen.has(f.rule)) {
        entry.cards += 1;
        seen.add(f.rule);
      }
      ruleMap.set(f.rule, entry);
    }
    buckets.set(Math.floor(report.score / 10) * 10, (buckets.get(Math.floor(report.score / 10) * 10) ?? 0) + 1);
  }
  const total = reports.length;
  const averageScore = total === 0 ? 0 : Math.round(reports.reduce((s, r) => s + r.score, 0) / total);
  return {
    total,
    averageScore,
    distribution: [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([lo, count]) => ({ range: `${lo}~${lo + 9}`, count })),
    rules: [...ruleMap.entries()].map(([rule, v]) => ({ rule, title: ruleTitle(rule), cards: v.cards, hits: v.hits })).sort((a, b) => b.cards - a.cards || a.rule.localeCompare(b.rule)),
    rows: reports.map((r, i) => ({
      title: titles[i] ?? r.title,
      template: r.template,
      score: r.score,
      chars: r.chars,
      findingCount: r.findings.length,
      topRules: [...new Set(r.findings.map((f) => f.title))].slice(0, 3)
    }))
  };
}
function formatBatch(batch, limit = 20) {
  const lines = [
    `\u6279\u91CF lint\uFF1A${batch.total} \u5F20\u5361\uFF0C\u5E73\u5747 ${batch.averageScore}/100`,
    `\u5206\u6570\u5206\u5E03\uFF1A${batch.distribution.map((d) => `${d.range} \u5206 ${d.count} \u5F20`).join("\uFF0C") || "\u2014"}`
  ];
  if (batch.rules.length > 0) {
    lines.push("\u89C4\u5219\u547D\u4E2D\uFF08\u6309\u547D\u4E2D\u5361\u7247\u6570\u6392\u5E8F\uFF09\uFF1A");
    for (const r of batch.rules) lines.push(`  - ${r.title}\uFF1A${r.cards} \u5F20 / ${r.hits} \u5904`);
  } else {
    lines.push("\u89C4\u5219\u547D\u4E2D\uFF1A\u65E0");
  }
  const worst = [...batch.rows].sort((a, b) => a.score - b.score).slice(0, limit);
  if (worst.length > 0) {
    lines.push(`\u6700\u4F4E\u5206 ${worst.length} \u5F20\uFF1A`);
    for (const row of worst) {
      lines.push(`  - ${row.score}/100 ${row.title}\uFF08${row.template}\uFF0C${row.chars} \u5B57\uFF09${row.topRules.length ? `\uFF1A${row.topRules.join("\u3001")}` : ""}`);
    }
  }
  return lines.join("\n");
}

// src/memory.ts
import { promises as fsp2 } from "node:fs";
import { dirname as dirname2 } from "node:path";

// src/vault.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { promises as fsp, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, basename } from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set([".obsidian", ".trash", ".study", ".git", "node_modules"]);
function skipSetFor(extra) {
  return /* @__PURE__ */ new Set([...SKIP_DIRS, ...extra ?? []]);
}
function sanitizeFilename(title) {
  const cleaned = title.replace(/["'“”‘’]/g, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const capped = cleaned.slice(0, 80).trim();
  return capped.length > 0 ? capped : "\u672A\u547D\u540D";
}
function findSimilarDomainKeys(domain, keys) {
  const d = String(domain ?? "").trim();
  if (!d) return [];
  const scored = [];
  for (const raw of keys) {
    const key = String(raw);
    if (key === d) continue;
    const common = [.../* @__PURE__ */ new Set([...d])].filter((ch) => key.includes(ch)).length;
    const score = common / Math.max(d.length, key.length);
    if (score >= 0.6) scored.push({ key, score });
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored.slice(0, 2).map((s) => s.key);
}
function withinRoot(root, p) {
  const r = relative(root, p);
  return r === "" || !r.startsWith("..") && !isAbsolute(r);
}
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}
async function atomicWrite(file, content) {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp-${randomBytes2(4).toString("hex")}`;
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {
    });
    throw error;
  }
}
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
async function walk(root, skip = skipSetFor(), rootLabel = "vault") {
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) continue;
        await rec(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
        try {
          const st = await fsp.stat(full);
          out.push({ path: full, rel: relative(root, full), root: rootLabel, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size });
        } catch {
        }
      }
    }
  }
  await rec(root);
  return out;
}
async function walkRoots(roots, skip = skipSetFor()) {
  const out = [];
  for (const r of roots) {
    out.push(...await walk(r.path, skip, r.label));
  }
  return out;
}
function canonicalRootKey(p) {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}
function containsRoot(outer, inner) {
  const o = canonicalRootKey(outer);
  const i = canonicalRootKey(inner);
  const sep = o.includes("\\") ? "\\" : "/";
  return i === o || i.startsWith(o.endsWith(sep) ? o : `${o}${sep}`);
}
function dedupeRoots(roots) {
  const kept = [];
  for (const r of roots) {
    if (kept.some((k) => containsRoot(k.path, r.path))) continue;
    kept.push(r);
  }
  return kept;
}
function dedupeFiles(files) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const f of files) {
    const key = canonicalRootKey(f.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
function resolveSearchRoots(vaultRoot, raw) {
  const roots = [];
  const used = /* @__PURE__ */ new Set(["vault", "\u5DE5\u4F5C\u76EE\u5F55"]);
  for (const entry of raw ?? []) {
    const abs = resolve(vaultRoot, String(entry));
    if (canonicalRootKey(abs) === canonicalRootKey(resolve("/"))) {
      throw new Error(`searchRoots \u4E0D\u80FD\u662F\u6587\u4EF6\u7CFB\u7EDF\u6839\uFF1A${abs}`);
    }
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st?.isDirectory()) {
      throw new Error(`searchRoots \u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BFB\uFF1A${abs}\uFF08\u68C0\u67E5 preset \u884C config.searchRoots\uFF09`);
    }
    const base = basename(abs) || "root";
    let label = base;
    let n = 2;
    while (used.has(label)) label = `${base}(${n++})`;
    used.add(label);
    roots.push({ path: abs, label });
  }
  return roots;
}
function cardDirFor(layout, domain) {
  const mapped = layout.domainFolders?.[domain];
  const rel = mapped ?? join(layout.fallbackDir, sanitizeFilename(domain));
  const abs = resolve(layout.vaultRoot, rel);
  if (!withinRoot(layout.vaultRoot, abs)) {
    throw new Error(`\u5361\u7247\u76EE\u5F55\u8D8A\u754C\uFF1A${rel} \u4E0D\u5728 vault \u6839\u76EE\u5F55\u5185`);
  }
  return abs;
}
async function uniqueCardPath(dir, title, id) {
  const base = sanitizeFilename(title);
  const first = join(dir, `${base}.md`);
  if (!await exists(first)) return first;
  const second = join(dir, `${base}_${id.slice(-4)}.md`);
  if (!await exists(second)) return second;
  const third = join(dir, `${base}_${id}.md`);
  if (!await exists(third)) return third;
  throw new Error(`\u5361\u7247\u6587\u4EF6\u540D\u51B2\u7A81\uFF1A${base}.md \u5DF2\u6709\u591A\u4E2A\u540C\u540D\u6587\u4EF6\uFF0C\u8BF7\u6539\u6807\u9898`);
}
function fileNameOf(p) {
  return basename(p);
}
function mocPathFor(layout, title, date) {
  const rel = join(layout.mocDir, `${sanitizeFilename(`${date}_${title}`)}.md`);
  const abs = resolve(layout.vaultRoot, rel);
  if (!withinRoot(layout.vaultRoot, abs)) throw new Error("MOC \u8DEF\u5F84\u8D8A\u754C");
  return abs;
}

// src/memory.ts
var MAX_MEMORY_VALUE = 4e3;
var MAX_MEMORY_KEY = 64;
var SUMMARY_KEY = "lastSummary";
var AUTO_PREFS_KEY = "_autoPrefs";
var AUTO_PREFS_VALUES = ["on", "off"];
async function readMemory(file) {
  try {
    const raw = await fsp2.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { notes: {} };
    const notes = {};
    if (parsed.notes && typeof parsed.notes === "object" && !Array.isArray(parsed.notes)) {
      for (const [key, value] of Object.entries(parsed.notes)) {
        if (typeof key === "string" && typeof value === "string" && key.length > 0) notes[key] = value;
      }
    }
    const state = { notes };
    if (typeof parsed.updatedAt === "string") state.updatedAt = parsed.updatedAt;
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return { notes: {} };
    throw new Error(`\u8BB0\u5FC6\u6587\u4EF6\u635F\u574F\uFF1A${error.message}`);
  }
}
async function writeMemory(file, state) {
  await ensureDir(dirname2(file));
  const next = { ...state, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}
`);
}
function normalizeMemoryKey(key) {
  const k = String(key).trim();
  if (!k) throw new Error("\u8BB0\u5FC6\u952E\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (k.length > MAX_MEMORY_KEY) throw new Error(`\u8BB0\u5FC6\u952E\u540D\u8FC7\u957F\uFF08\u2264${MAX_MEMORY_KEY} \u5B57\u7B26\uFF09\uFF1A${k.slice(0, 20)}\u2026`);
  if (/[\u0000-\u001f]/.test(k)) throw new Error("\u8BB0\u5FC6\u952E\u540D\u4E0D\u80FD\u5305\u542B\u63A7\u5236\u5B57\u7B26");
  return k;
}
function checkMemoryValue(value) {
  const v = String(value);
  if (v.length > MAX_MEMORY_VALUE) {
    throw new Error(`\u8BB0\u5FC6\u5185\u5BB9\u8FC7\u957F\uFF08\u2264${MAX_MEMORY_VALUE} \u5B57\u7B26\uFF0C\u5F53\u524D ${v.length}\uFF09\uFF0C\u8BF7\u7CBE\u7B80\u540E\u518D\u8BB0`);
  }
  return v;
}
var PROGRESS_SENTENCE_RE = /现学|正在学|当前学习|现在学到/;
function findProgressSentences(notes) {
  const hits = [];
  for (const [key, value] of Object.entries(notes)) {
    if (isControlKey(key)) continue;
    if (!PROGRESS_SENTENCE_RE.test(value)) continue;
    const m = PROGRESS_SENTENCE_RE.exec(value);
    const start = Math.max(0, (m?.index ?? 0) - 8);
    const snippet = value.slice(start, start + 40).replace(/\s+/g, " ").trim();
    hits.push({ key, snippet });
    if (hits.length >= 3) break;
  }
  return hits;
}
function isControlKey(key) {
  return key.startsWith("_");
}
function normalizeAutoPrefsValue(value) {
  const v = String(value).trim();
  if (v !== "on" && v !== "off") {
    throw new Error(`\u81EA\u8FED\u4EE3\u5F00\u5173\u53EA\u63A5\u53D7 on/off\uFF08\u6536\u5230 "${v.slice(0, 20)}"\uFF09\uFF1B\u7528 "\u5F00\u542F\u81EA\u8FED\u4EE3" / "\u5173\u95ED\u81EA\u8FED\u4EE3" \u5207\u6362`);
  }
  return v;
}
function formatAutoPrefs(value) {
  if (value === void 0) return `\u81EA\u8FED\u4EE3\u8BB0\u5FC6\uFF1A\u5173\u95ED\uFF08\u9ED8\u8BA4\uFF1B"\u5F00\u542F\u81EA\u8FED\u4EE3"\u6253\u5F00\uFF09`;
  if (!AUTO_PREFS_VALUES.includes(value)) {
    return `\u81EA\u8FED\u4EE3\u8BB0\u5FC6\uFF1A\u5F02\u5E38\u503C\uFF08${value.slice(0, 40)}\uFF09\u2014\u2014\u8BF7\u91CD\u65B0\u8BBE\u7F6E\u4E3A on/off`;
  }
  return `\u81EA\u8FED\u4EE3\u8BB0\u5FC6\uFF1A${value === "on" ? "\u5F00\u542F\uFF08\u81EA\u52A8\u8BB0\u5F55\u504F\u597D\uFF09" : "\u5173\u95ED"}`;
}
function formatMemory(state) {
  const entries = Object.entries(state.notes).filter(([key]) => !isControlKey(key)).sort(([a], [b]) => a === SUMMARY_KEY ? -1 : b === SUMMARY_KEY ? 1 : a.localeCompare(b));
  const lines = [];
  if (state.notes[AUTO_PREFS_KEY] !== void 0) lines.push(formatAutoPrefs(state.notes[AUTO_PREFS_KEY]));
  if (entries.length === 0) return lines.length > 0 ? lines.join("\n") : "\u6682\u65E0\u8BB0\u5FC6\u3002";
  lines.push(`\u8BB0\u5FC6\uFF08${entries.length} \u6761\uFF09`);
  for (const [key, value] of entries) {
    lines.push(key === SUMMARY_KEY ? `\u4E0A\u6B21\u5C0F\u7ED3\uFF1A${value}` : `- ${key}\uFF1A${value}`);
  }
  return lines.join("\n");
}

// src/opener.ts
import { randomUUID } from "node:crypto";
var OPENER_SECTION_NAME = "study:memory-mandate";
var OPENER_SECTION_ORDER = -1;
var MANDATE = "## \u5F00\u573A\u95E8\u7981\n\u5BF9\u8BDD\u5386\u53F2\u4E3A\u7A7A\u65F6\u7684\u9996\u6761\u7528\u6237\u6D88\u606F\uFF1A\u5FC5\u987B\u5148\u4F9D\u6B21\u8C03\u7528 study_memory(get) \u4E0E study_progress(get)\uFF1B\u8BFB\u53D6\u7ED3\u679C\u8FD4\u56DE\u524D\u4E0D\u5F97\u56DE\u7B54\u3001\u4E0D\u5F97\u6267\u884C\u5176\u4ED6\u5DE5\u5177\uFF1B\u8BFB\u5B8C\u518D\u6309\u7528\u6237\u6307\u4EE4\u529E\u4E8B\u3002";
var REMINDER = "\u3010\u5F00\u573A\u95E8\u7981\u3011\u8FD9\u662F\u672C\u4F1A\u8BDD\u7B2C\u4E00\u6761\u6D88\u606F\u3002\u8BF7\u5148\u8C03\u7528 study_memory(get) \u4E0E study_progress(get) \u8BFB\u53D6\u8DE8\u4F1A\u8BDD\u8BB0\u5FC6\u4E0E\u5B66\u4E60\u8FDB\u5EA6\uFF08\u4E0D\u7528\u590D\u8FF0\u5185\u5BB9\uFF09\uFF0C\u7ED3\u679C\u8FD4\u56DE\u524D\u4E0D\u8981\u56DE\u7B54\u3001\u4E0D\u8981\u6267\u884C\u5176\u4ED6\u5DE5\u5177\uFF1B\u8BFB\u5B8C\u540E\u6309\u7528\u6237\u6307\u4EE4\u54CD\u5E94\u3002\uFF08\u82E5\u672C\u4F1A\u8BDD\u5DF2\u8BFB\u8FC7\u8BB0\u5FC6\uFF0C\u5FFD\u7565\u672C\u6761\u3002\uFF09";
function shouldInjectOpener(turn, step, hasPriorUserMessage2) {
  return turn === 1 && step === 1 && !hasPriorUserMessage2;
}
function buildOpenerReminder(id = randomUUID()) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: REMINDER }],
    source: { kind: "plugin", plugin: "dsh-study-buddy" }
  };
}
function applyOpenerDecision(decision, reminder) {
  if (decision.kind === "reject") return decision;
  return { ...decision, messages: [...decision.messages, reminder] };
}
function hasPriorUserMessage(payload) {
  const session = payload?.agent?.session;
  const events = Array.isArray(session?.events) ? session?.events : typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : void 0;
  return Array.isArray(events) && events.some((event) => event?.type === "user/message");
}

// src/rename.ts
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function replaceCardTitle(raw, newTitle) {
  const title = String(newTitle ?? "").trim();
  const { body } = parseFrontmatter(raw);
  const head = raw.slice(0, raw.length - body.length);
  if (/^标题:/m.test(head)) return `${head.replace(/^标题:.*$/m, `\u6807\u9898: ${title}`)}${body}`;
  return `---
\u6807\u9898: ${title}
---
${body}`;
}
function cardTitleOf(raw) {
  const { meta, body } = parseFrontmatter(raw);
  if (meta?.title) return meta.title;
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : "";
}
function rewriteCardLinks(body, opts) {
  const { lead, sections } = splitSections(body);
  const samples = [];
  let changed = 0;
  const idRe = opts.targetId ? new RegExp(`\uFF08${escapeRe(opts.targetId)}\uFF09`) : null;
  const next = sections.map((section) => {
    if (!/^关联卡片/.test(section.title)) return section;
    const lines = section.body.split(/\r?\n/).map((line) => {
      if (!/^[ \t]*-/.test(line)) return line;
      const hit = idRe ? idRe.test(line) : line.includes(`\`${opts.oldTitle}\``);
      if (!hit) return line;
      const replaced = line.split(opts.oldTitle).join(opts.newTitle);
      if (replaced === line) return line;
      changed += 1;
      if (samples.length < 3) samples.push(`${line.trim()} \u2192 ${replaced.trim()}`);
      return replaced;
    });
    return { ...section, body: lines.join("\n") };
  });
  return { text: renderSections(lead, next), changed, samples };
}
function rewriteWikilinks(body, oldBase, newBase) {
  const samples = [];
  let changed = 0;
  const re = new RegExp(`\\[\\[${escapeRe(oldBase)}(\\|[^\\]]*|#[^\\]]*)?\\]\\]`, "g");
  const text = String(body ?? "").replace(re, (match, tail) => {
    changed += 1;
    const replaced = `[[${newBase}${tail ?? ""}]]`;
    if (samples.length < 3) samples.push(`${match} \u2192 ${replaced}`);
    return replaced;
  });
  return { text, changed, samples };
}
function detectBrokenLinks(body, opts = { oldTitle: "" }) {
  const section = findSection(splitSections(body).sections, "\u5173\u8054\u5361\u7247");
  if (!section) return [];
  const hits = [];
  const text = String(body ?? "");
  const baseLine = text.slice(0, section.start).split("\n").length;
  section.body.split(/\r?\n/).forEach((line, i) => {
    if (!/^[ \t]*-/.test(line)) return;
    const lineNo = baseLine + i;
    const pointsToOld = opts.oldTitle && line.includes(opts.oldTitle) && !(opts.newTitle && line.includes(opts.newTitle)) && !(opts.oldId && line.includes(`\uFF08${opts.oldId}\uFF09`));
    if (pointsToOld) {
      hits.push({ line: lineNo, text: line.trim(), reason: `\u4ECD\u6307\u5411\u65E7\u6807\u9898\u300C${opts.oldTitle}\u300D` });
      return;
    }
    if (!/^[ \t]*-\s*(?:前置|后续|易混淆)\s*[：:]/.test(line)) {
      hits.push({ line: lineNo, text: line.trim(), reason: '\u5173\u8054\u884C\u683C\u5F0F\u4E0D\u7B26\uFF08\u5E94\u4E3A "- \u6807\u7B7E\uFF1A`\u6807\u9898`\uFF08ID\uFF09"\uFF09' });
    }
  });
  return hits;
}
function sanitize(name2) {
  return String(name2).replace(/["'“”‘’]/g, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim() || "\u672A\u547D\u540D";
}
function planRename(input) {
  const oldBase = input.fileName.replace(/\.md$/i, "");
  const newBase = sanitize(input.newTitle);
  const expected = sanitize(input.oldTitle);
  if (oldBase === newBase) return { renameFile: false, oldBase, newBase, reason: "\u65B0\u6807\u9898\u6E05\u6D17\u540E\u4E0E\u539F\u6587\u4EF6\u540D\u76F8\u540C\uFF0C\u65E0\u9700\u6539\u540D" };
  if (oldBase === expected) return { renameFile: true, oldBase, newBase, reason: "\u6587\u4EF6\u540D\u4E0E\u65E7\u6807\u9898\u4E00\u81F4\uFF0C\u540C\u6B65\u6539\u540D\u4E3A\u65B0\u6807\u9898" };
  return { renameFile: false, oldBase, newBase, reason: `\u6587\u4EF6\u540D\u300C${oldBase}\u300D\u4E0E\u65E7\u6807\u9898\u300C${input.oldTitle}\u300D\u4E0D\u4E00\u81F4\uFF08\u5386\u53F2\u9057\u7559\uFF09\uFF0C\u4FDD\u7559\u6587\u4EF6\u540D\uFF0C\u53EA\u6539\u6807\u9898\u4E0E\u5165\u94FE` };
}
function formatRenameReport(input) {
  const lines = [];
  lines.push(`${input.dryRun ? "[dryRun] " : ""}\u6539\u540D\uFF1A${input.oldTitle} \u2192 ${input.newTitle}\uFF08ID\uFF1A${input.id}\uFF09`);
  lines.push(`\u6587\u4EF6\u540D\uFF1A${input.plan.renameFile ? `${input.plan.oldBase}.md \u2192 ${input.plan.newBase}.md` : `\u4E0D\u53D8\uFF08${input.plan.reason}\uFF09`}`);
  if (input.filesChanged.length === 0) lines.push("\u5165\u94FE\uFF1A\u65E0\u6539\u52A8");
  else {
    lines.push(`\u5165\u94FE\uFF1A${input.filesChanged.length} \u4E2A\u6587\u4EF6`);
    for (const f of input.filesChanged) {
      lines.push(`  - ${f.rel}\uFF08${f.kind}\uFF0C${f.changed} \u884C\uFF09`);
      for (const s of f.samples) lines.push(`      ${s}`);
    }
  }
  if (input.broken.length > 0) {
    lines.push(`\u65AD\u94FE\u68C0\u6D4B\uFF1A${input.broken.length} \u5904`);
    for (const b of input.broken) lines.push(`  - \u7B2C ${b.line} \u884C\uFF1A${b.reason}\uFF1A${b.text}`);
  } else {
    lines.push("\u65AD\u94FE\u68C0\u6D4B\uFF1A\u65E0");
  }
  return lines.join("\n");
}

// src/search.ts
var CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;
var WORD_RE = /[a-z0-9_]+/g;
function tokenize(text) {
  const tokens = [];
  const lowered = text.toLowerCase();
  for (const m of lowered.match(WORD_RE) ?? []) {
    if (m.length >= 2) tokens.push(m);
  }
  for (const run of lowered.match(CJK_RE) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}
function tokenizeQuery(text) {
  const tokens = tokenize(text);
  const extra = [];
  const lowered = text.toLowerCase();
  for (const run of lowered.match(CJK_RE) ?? []) {
    if (run.length > 1 && run.length <= 4) extra.push(...run.split(""));
  }
  return [...tokens, ...extra];
}
function countTokens(tokens) {
  const map = /* @__PURE__ */ new Map();
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}
function indexNote(file, raw) {
  const parsed = parseFrontmatter(raw);
  const tags = parsed.meta?.domain ? parsed.meta.domain.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean) : [];
  const inferredDomain = file.rel.split(/[\\/]/)[0] || "";
  const title = parsed.meta?.title ?? firstHeading(parsed.body) ?? fileNameOf(file.path).replace(/\.md$/i, "");
  const definition = extractDefinition(parsed.body);
  const root = file.root;
  return {
    id: parsed.meta?.id ?? null,
    title,
    path: file.path,
    rel: file.rel,
    root,
    fullRel: `${root}/${file.rel.replace(/\\/g, "/")}`,
    fileName: fileNameOf(file.path),
    kind: parsed.meta?.id ? "card" : "note",
    domain: tags[0] ?? null,
    tags,
    status: parsed.meta?.status ?? null,
    source: parsed.meta?.source ?? null,
    definition,
    inferredDomain,
    titleTokens: countTokens(tokenize(title)),
    defTokens: countTokens(tokenize(definition ?? "")),
    tagTokens: countTokens(tokenize(tags.join(" "))),
    bodyTokens: countTokens(tokenize(parsed.body)),
    body: parsed.body
  };
}
var SNIPPET_MAX = 100;
function snippetOf(card, queryTokens) {
  const lines = card.body.split(/\r?\n/);
  const hit = lines.find((line) => {
    const lt = line.toLowerCase();
    return queryTokens.some((t) => lt.includes(t));
  });
  const text = hit ?? lines.find((l) => l.trim() !== "") ?? "";
  const trimmed = text.trim();
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}\u2026` : trimmed;
}
var SearchIndex = class {
  cards = [];
  inverted = /* @__PURE__ */ new Map();
  titleInverted = /* @__PURE__ */ new Map();
  defInverted = /* @__PURE__ */ new Map();
  tagInverted = /* @__PURE__ */ new Map();
  rebuild(cards, multiRoot = false) {
    this.cards = cards.map((c) => ({ ...c, fullRel: multiRoot ? c.fullRel : c.rel.replace(/\\/g, "/") }));
    this.inverted.clear();
    this.titleInverted.clear();
    this.defInverted.clear();
    this.tagInverted.clear();
    this.cards.forEach((card, idx) => {
      for (const t of card.bodyTokens.keys()) this.push(this.inverted, t, idx);
      for (const t of card.titleTokens.keys()) this.push(this.titleInverted, t, idx);
      for (const t of card.defTokens.keys()) this.push(this.defInverted, t, idx);
      for (const t of card.tagTokens.keys()) this.push(this.tagInverted, t, idx);
    });
  }
  push(map, token, idx) {
    const list = map.get(token) ?? [];
    list.push(idx);
    map.set(token, list);
  }
  get size() {
    return this.cards.length;
  }
  all() {
    return this.cards;
  }
  byId(id) {
    return this.cards.find((c) => c.id === id);
  }
  byTitle(title) {
    const wanted = title.toLowerCase();
    return this.cards.find((c) => c.title.toLowerCase() === wanted);
  }
  /**
   * 按引用串找候选：优先完整展示路径（root/rel，多根时）、各根内 rel，最后（仅当引用是纯文件名时）按文件名。
   * 返回全部候选（0/1/多个），由调用方决定唯一或报歧义。
   */
  candidatesForRef(ref) {
    const q = ref.replace(/\\/g, "/");
    const pureName = !q.includes("/");
    const wanted = q.toLowerCase();
    return this.cards.filter((c) => {
      const cRel = c.rel.replace(/\\/g, "/");
      const cFull = `${c.root}/${cRel}`;
      if (cFull === q || cRel === q || c.fullRel === q) return true;
      return pureName && c.fileName.toLowerCase() === wanted;
    });
  }
  byRel(rel) {
    return this.candidatesForRef(rel)[0];
  }
  search(query, opts = {}) {
    const tokens = tokenizeQuery(query);
    const scores = /* @__PURE__ */ new Map();
    for (const t of tokens) {
      for (const idx of this.titleInverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 4);
      }
      for (const idx of this.defInverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 3);
      }
      for (const idx of this.tagInverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 2);
      }
      for (const idx of this.inverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 1);
      }
    }
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 5;
    const hits = [];
    for (const [idx, score] of scores) {
      if (score <= 0) continue;
      const card = this.cards[idx];
      if (opts.domain && card.domain !== opts.domain && card.inferredDomain !== opts.domain) continue;
      if (opts.status && card.status !== opts.status) continue;
      if (opts.kind && card.kind !== opts.kind) continue;
      hits.push({
        id: card.id,
        title: card.title,
        domain: card.domain,
        tags: card.tags,
        status: card.status,
        source: card.source,
        definition: card.definition,
        path: card.path,
        rel: card.rel,
        root: card.root,
        fullRel: card.fullRel,
        fileName: card.fileName,
        kind: card.kind,
        inferredDomain: card.inferredDomain,
        score,
        snippet: snippetOf(card, tokens)
      });
    }
    hits.sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === "card" ? -1 : 1) || a.fullRel.localeCompare(b.fullRel));
    return hits.slice(0, limit);
  }
};

// src/state.ts
import { promises as fsp3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
async function readProgress(file) {
  try {
    const raw = await fsp3.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state = {};
    if (typeof parsed.currentMaterial === "string") state.currentMaterial = parsed.currentMaterial;
    if (typeof parsed.currentSection === "string") state.currentSection = parsed.currentSection;
    if (Array.isArray(parsed.pendingQuestions)) {
      state.pendingQuestions = parsed.pendingQuestions.filter((q) => typeof q === "string");
    }
    if (Array.isArray(parsed.touchedCardIds)) {
      state.touchedCardIds = parsed.touchedCardIds.filter((q) => typeof q === "string");
    }
    if (typeof parsed.updatedAt === "string") state.updatedAt = parsed.updatedAt;
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`\u5B66\u4E60\u8FDB\u5EA6\u6587\u4EF6\u635F\u574F\uFF1A${error.message}`);
  }
}
async function writeProgress(file, state) {
  await ensureDir(dirname3(file));
  const next = { ...state, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}
`);
}

// src/tools.ts
var renderText = (_args, value) => [{ type: "text", text: value }];
var output = { schema: { type: "string" }, render: renderText };
function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return cwd && String(cwd).trim() ? String(cwd) : void 0;
}
function stringList(value) {
  return Array.isArray(value) ? value.map(String) : void 0;
}
function linksOf(value) {
  if (!value || typeof value !== "object") return void 0;
  const raw = value;
  return { prev: stringList(raw.prev), next: stringList(raw.next), conflict: stringList(raw.conflict) };
}
function buildToolDefs(store) {
  return [
    {
      name: "card_search",
      description: "\u5168\u5E93\u68C0\u7D22 vault \u5361\u7247\u4E0E\u65E7\u7B14\u8BB0\uFF08\u542B\u914D\u7F6E searchRoots \u4E0E\u5DE5\u4F5C\u76EE\u5F55\u65E7\u7B14\u8BB0\u2014\u2014\u65E7\u7B14\u8BB0=\u65E0 ID \u7684 .md\uFF09\u3002\u6444\u5165\u65B0\u8D44\u6599\u3001\u5F15\u7528\u65E7\u5361\u3001\u589E\u91CF\u66F4\u65B0\u5224\u65AD\u524D\u5FC5\u67E5\u91CD\u53E0\u3002\u8FD4\u56DE\u5019\u9009\u7684\u6807\u9898/ID/\u7C7B\u578B\uFF08\u5361\u7247\u6216\u65E7\u7B14\u8BB0\uFF09/\u8DEF\u5F84/\u9886\u57DF/\u72B6\u6001/\u6765\u6E90/\u5B9A\u4E49/\u7247\u6BB5\uFF1B\u53EC\u56DE\u7531\u63D2\u4EF6\u505A\uFF0C\u8BED\u4E49\u5224\u65AD\u7531\u4F60\u5B8C\u6210\u3002",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "\u68C0\u7D22\u8BCD\uFF08\u6982\u5FF5/\u672F\u8BED/\u6807\u9898\u7247\u6BB5\uFF09" },
          domain: { type: "string", description: "\u9886\u57DF\u8FC7\u6EE4\uFF08\u5982 \u56FE\u5F62\u5B66\uFF09" },
          status: { type: "string", description: "\u72B6\u6001\u8FC7\u6EE4\uFF1A\u8349\u7A3F/\u5DF2\u786E\u8BA4/\u9700\u66F4\u65B0" },
          kind: { type: "string", enum: ["card", "note"], description: "\u7C7B\u578B\u8FC7\u6EE4\uFF1Acard=\u5361\u7247\uFF0Cnote=\u65E7\u7B14\u8BB0" },
          limit: { type: "number", description: "\u8FD4\u56DE\u6761\u6570\uFF0C\u9ED8\u8BA4 5" }
        },
        required: ["query"]
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.search(String(args.query ?? ""), {
        domain: args.domain ? String(args.domain) : void 0,
        status: args.status ? String(args.status) : void 0,
        kind: args.kind === "card" || args.kind === "note" ? args.kind : void 0,
        limit: Number(args.limit) > 0 ? Number(args.limit) : void 0
      }, { sessionCwd: sessionCwdOf(exec) })
    },
    {
      name: "card_get",
      description: '\u6309 ID\u3001\u6807\u9898\u3001\u6839\u9650\u5B9A\u8DEF\u5F84\uFF08\u5982 "\u5DE5\u4F5C\u76EE\u5F55/\u5B50\u76EE\u5F55/\u7B14\u8BB0.md"\uFF09\u3001\u76F8\u5BF9\u8DEF\u5F84\u6216\u6587\u4EF6\u540D\u8BFB\u53D6\u4E00\u7BC7\u6587\u6863\u7684\u5B8C\u6574\u539F\u6587\uFF08\u5361\u7247\u6216\u65E7\u7B14\u8BB0\uFF09\u3002',
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: '\u5361\u7247 ID\u3001\u6807\u9898\u6216\u8DEF\u5F84/\u6587\u4EF6\u540D\uFF08\u8DE8\u6839\u8DEF\u5F84\u6B67\u4E49\u65F6\u7528"\u6839/\u76F8\u5BF9\u8DEF\u5F84"\uFF09' }
        },
        required: ["ref"]
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.get(String(args.ref ?? ""), { sessionCwd: sessionCwdOf(exec) })
    },
    {
      name: "card_id",
      description: "\u751F\u6210\u5361\u7247 ID\uFF08YYYYMMDDHHmm_\u968F\u673A4\u4F4D\uFF09\u3002\u6CE8\u610F\uFF1Acard_create \u4F1A\u81EA\u52A8\u751F\u6210 ID\uFF0C\u4E0D\u6D88\u8D39\u672C\u5DE5\u5177\u7684\u9884\u53D6\u503C\u2014\u2014\u9700\u8981\u5F15\u7528\u65F6\u4EE5 card_create \u8FD4\u56DE\u7684 ID \u4E3A\u51C6\uFF1B\u672C\u5DE5\u5177\u4EC5\u7528\u4E8E\u67E5\u770B ID \u683C\u5F0F\u3002",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "\u6570\u91CF\uFF0C\u9ED8\u8BA4 1\uFF0C\u4E0A\u9650 20" }
        }
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args) => {
        const n = Math.min(Math.max(1, Math.trunc(Number(args?.count) || 1)), 20);
        return Array.from({ length: n }, () => generateId()).join("\n");
      }
    },
    {
      name: "card_create",
      description: '\u628A\u4E00\u5F20\u539F\u5B50\u5361\u7247\u5199\u5165 vault \u5BF9\u5E94\u5206\u7C7B\u76EE\u5F55\uFF08\u9886\u57DF\u2192\u76EE\u5F55\u6620\u5C04\uFF1B\u672A\u6620\u5C04\u843D"\u672A\u5206\u7C7B"\u5E76\u56DE\u663E\u53EF\u7528\u9886\u57DF\u952E\u4E0E\u8FD1\u4F3C\u952E\u5EFA\u8BAE\uFF09\u3002\u77E5\u8BC6\u5373\u5361\u7247\uFF1A\u4E0E\u65E7\u7B14\u8BB0\u540C\u5E93\u3002\u81EA\u52A8\u751F\u6210\u552F\u4E00 ID\u3001\u5199 frontmatter\uFF08ID/\u6807\u9898/\u9886\u57DF/\u6765\u6E90/\u72B6\u6001/\u6A21\u677F\uFF09\uFF1B\u6B63\u6587=\u88F8\u5F15\u7528\u5757\u5B9A\u4E49+\u5206\u578B\u5C0F\u8282\uFF08\u7406\u8BBA\u578B/\u5DE5\u7A0B\u578B/\u5BF9\u6BD4\u578B\uFF0C\u81EA\u52A8\u63A8\u65AD\uFF0C\u53EF\u7528 template \u8986\u76D6\uFF09+\u5173\u8054\u5361\u7247\u3002\u8FD4\u56DE\u6574\u5361\uFF1B\u8FD4\u56DE\u6587\u672C\u542B"\u9886\u57DF\u6620\u5C04"\u884C\uFF08\u952E \u2192 \u76EE\u5F55\uFF09\u4E0E\u6807\u9898\u6E05\u6D17\u63D0\u793A\uFF08\u975E\u6CD5\u5B57\u7B26/\u5F15\u53F7\u4F1A\u88AB\u6E05\u6D17\uFF0C\u6587\u4EF6\u540D\u4EE5\u8FD4\u56DE\u7684 rel \u4E3A\u51C6\uFF09\u3002',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: '\u6982\u5FF5\u540D\u79F0\uFF0C\u5982"\u5149\u7EBF\u4E0E\u8868\u9762\u7684\u4E24\u79CD\u4EA4\u4E92\uFF1A\u6563\u5C04\u4E0E\u5438\u6536"\uFF08\u907F\u514D / \\ : * ? " < > | \u4E0E\u5F15\u53F7\uFF1B\u4F1A\u88AB\u81EA\u52A8\u6E05\u6D17\uFF09' },
          domain: { type: "string", description: "\u9886\u57DF\u952E\uFF0C\u51B3\u5B9A\u843D\u76D8\u76EE\u5F55\uFF08\u952E\u540D\u8868\u89C1 card-format \u6280\u80FD\uFF1B\u672A\u6620\u5C04\u4F1A\u56DE\u663E\u53EF\u7528\u952E\u4E0E\u8FD1\u4F3C\u952E\uFF09" },
          tags: { type: "array", items: { type: "string" }, description: "\u989D\u5916\u4E2D\u6587\u9886\u57DF\u6807\u7B7E" },
          source: { type: "string", description: "\u8D44\u6599\u540D\u79F0" },
          status: { type: "string", enum: [...VALID_STATUS], description: "\u8349\u7A3F/\u5DF2\u786E\u8BA4/\u9700\u66F4\u65B0" },
          definition: { type: "string", description: "\u4E00\u53E5\u8BDD\u5B9A\u4E49\uFF1A\u226430 \u5B57\u6700\u4F73\uFF0C\u226460 \u5B57\u786C\u4E0A\u9650\uFF0831~60 \u5B57\u4EC5\u63D0\u793A\u7CBE\u7B80\uFF09" },
          template: { type: "string", enum: [...TEMPLATE_TYPES], description: "\u5361\u7247\u6A21\u677F\uFF1A\u7406\u8BBA\u578B\uFF08\u4E3A\u4EC0\u4E48\uFF09/\u5DE5\u7A0B\u578B\uFF08\u600E\u4E48\u505A\uFF09/\u5BF9\u6BD4\u578B\uFF08\u600E\u4E48\u9009\uFF09\uFF1B\u4E0D\u4F20\u5219\u6309\u9886\u57DF\u4E0E\u6807\u9898\u81EA\u52A8\u63A8\u65AD" },
          content: {
            type: "string",
            description: "\u6B63\u6587 Markdown\u3002\u5FC5\u542B\u5C0F\u8282\uFF1A\u6838\u5FC3\u601D\u60F3 / \u4E3B\u5E72\u7EBF / \u9636\u68AF\u5F0F\u89E3\u5256\uFF08\u7B2C 1~N \u5C42\uFF0C4~6 \u5C42\uFF09/ \u5B9E\u4F8B\u8D70\u67E5 / \u6613\u9519\u70B9 / \u81EA\u6D4B\u9898\uFF08**Qn**\uFF1A\u2026 \u2192 \u7B54\u6848\uFF09\uFF1B\u5DE5\u7A0B\u578B\u53E6\u9700 \u9A8C\u8BC1\u5B9E\u9A8C\uFF08\u22653 \u6B65\uFF09+ \u6392\u969C\u5224\u636E\uFF08\u8868\u683C\uFF09\uFF1B\u5BF9\u6BD4\u578B\u53E6\u9700 \u5BF9\u6BD4\u8868 + \u9009\u578B\u53E3\u8BC0 + \u573A\u666F\u8D70\u67E5\uFF1B\u957F\u5361\uFF08>3000 \u5B57\uFF09\u8865 \u91CD\u5165\u70B9\uFF0C\u6709\u524D\u7F6E\u5361\u65F6\u8865 \u524D\u7F6E\u68C0\u67E5\u3002\u6B63\u6587\u957F\u5EA6\u4E0D\u8BBE\u9650\uFF0C\u6309\u4FE1\u606F\u5B8C\u5907\u6027\u5199\u3002"
          },
          links: {
            type: "object",
            description: '\u5173\u8054\u5361\u7247\uFF08\u53EF\u9884\u683C\u5F0F\u5316\uFF0C\u5982"`\u6F2B\u53CD\u5C04\u6A21\u578B`\uFF08ID\uFF09"\uFF09',
            properties: {
              prev: { type: "array", items: { type: "string" }, description: "\u524D\u7F6E" },
              next: { type: "array", items: { type: "string" }, description: "\u540E\u7EED" },
              conflict: { type: "array", items: { type: "string" }, description: "\u6613\u6DF7\u6DC6" }
            }
          }
        },
        required: ["title", "domain", "source", "status", "definition", "content"]
      },
      output,
      execute: (args) => store.create({
        title: String(args.title ?? ""),
        domain: String(args.domain ?? ""),
        source: String(args.source ?? ""),
        status: String(args.status ?? ""),
        definition: String(args.definition ?? ""),
        template: args.template ? String(args.template) : void 0,
        content: String(args.content ?? ""),
        tags: stringList(args.tags),
        links: linksOf(args.links)
      }).then((r) => r.text)
    },
    {
      name: "card_update",
      description: '\u589E\u91CF\u66F4\u65B0\uFF1Aappend-version=\u52A0"\u7248\u672C\u66F4\u65B0\uFF08\u6765\u6E90\uFF09"\uFF08\u8865\u5145\u4E0D\u63A8\u7FFB\u65E7\u7ED3\u8BBA\uFF0C\u63D2\u5728\u300C\u5173\u8054\u5361\u7247\u300D\u4E4B\u524D\uFF09\uFF1Berrata=\u4FDD\u7559\u65E7\u5185\u5BB9\u52A0"\u52D8\u8BEF"\uFF08changes \u542B\u7EA0\u6B63\u539F\u56E0\uFF09\uFF1Bdefinition=\u53EA\u66FF\u6362\u4E00\u53E5\u8BDD\u5B9A\u4E49\uFF08\u5B57\u6BB5\u7EA7\u5FAE\u8C03\uFF1A\u4E0D\u91CD\u4F20\u6B63\u6587\u3001\u4E0D\u4EA7\u751F\u5386\u53F2\u6298\u53E0\uFF0C\u4E0D\u7B97\u77E5\u8BC6\u66F4\u65B0\uFF09\uFF1Breplace=\u6574\u5361\u66FF\u6362\uFF08\u65E7\u7248\u5165\u5386\u53F2\u6298\u53E0\u5757\uFF0C\u53EF\u4F20 links \u91CD\u5EFA\u5173\u8054\u5361\u7247\uFF09\u3002\u5148\u7ED9\u7528\u6237\u65B0\u65E7\u5BF9\u6BD4\u3001\u786E\u8BA4\u540E\u624D\u8C03\u7528\uFF1B\u51B3\u5B9A\u6743\u5728\u7528\u6237\u3002\u8FD4\u56DE\u6574\u5361\u3002',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "\u5361\u7247 ID/\u6807\u9898/\u8DEF\u5F84" },
          mode: { type: "string", description: "append-version/errata/definition/replace" },
          changes: { type: "string", description: "append/errata \u7684\u8FFD\u52A0\u5185\u5BB9" },
          source: { type: "string", description: "\u7248\u672C\u66F4\u65B0\u6765\u6E90\uFF08append-version \u7528\uFF09" },
          title: { type: "string", description: "replace\uFF1A\u65B0\u6807\u9898" },
          domain: { type: "string", description: "replace\uFF1A\u9886\u57DF\u952E" },
          tags: { type: "array", items: { type: "string" }, description: "replace\uFF1A\u989D\u5916\u9886\u57DF\u6807\u7B7E" },
          template: { type: "string", enum: [...TEMPLATE_TYPES], description: "replace\uFF1A\u5361\u7247\u6A21\u677F\uFF08\u4E0D\u4F20\u5219\u6CBF\u7528\u539F\u5361\u6216\u6309\u6807\u9898\u63A8\u65AD\uFF09" },
          status: { type: "string", enum: [...VALID_STATUS], description: "replace\uFF1A\u8349\u7A3F/\u5DF2\u786E\u8BA4/\u9700\u66F4\u65B0" },
          definition: { type: "string", description: "definition/replace\uFF1A\u4E00\u53E5\u8BDD\u5B9A\u4E49\uFF08\u226430 \u5B57\u6700\u4F73\uFF0C\u226460 \u5B57\u786C\u4E0A\u9650\uFF09" },
          content: { type: "string", description: "replace\uFF1A\u65B0\u6B63\u6587 Markdown\uFF08\u5C0F\u8282\u8981\u6C42\u540C card_create\uFF09" },
          links: {
            type: "object",
            description: "replace\uFF1A\u65B0\u5173\u8054\u5361\u7247\uFF08\u53EF\u9009\uFF1B\u4E0D\u4F20\u5219\u65B0\u5361\u65E0\u5173\u8054\u5C0F\u8282\uFF0C\u65E7\u5173\u8054\u7559\u5728\u5386\u53F2\u6298\u53E0\u5757\uFF09",
            properties: {
              prev: { type: "array", items: { type: "string" }, description: "\u524D\u7F6E" },
              next: { type: "array", items: { type: "string" }, description: "\u540E\u7EED" },
              conflict: { type: "array", items: { type: "string" }, description: "\u6613\u6DF7\u6DC6" }
            }
          }
        },
        required: ["id", "mode"]
      },
      output,
      execute: (args) => {
        const mode = String(args.mode ?? "");
        const payload = { mode };
        if (mode === "append-version" || mode === "errata") {
          payload.changes = args.changes ? String(args.changes) : void 0;
          if (mode === "append-version" && args.source) payload.source = String(args.source);
        }
        if (mode === "definition") {
          payload.definition = args.definition ? String(args.definition) : void 0;
        }
        if (mode === "replace") {
          payload.card = {
            title: String(args.title ?? ""),
            domain: String(args.domain ?? ""),
            source: String(args.source ?? ""),
            status: String(args.status ?? ""),
            definition: String(args.definition ?? ""),
            template: args.template ? String(args.template) : void 0,
            content: String(args.content ?? ""),
            tags: stringList(args.tags),
            links: linksOf(args.links)
          };
        }
        return store.update(String(args.id ?? ""), payload);
      }
    },
    {
      name: "card_link",
      description: '\u7EF4\u62A4\u4E24\u7BC7\u6587\u6863\u7684\u5173\u8054\uFF08\u524D\u7F6E/\u540E\u7EED/\u6613\u6DF7\u6DC6\uFF09\uFF0C\u53CC\u5411\u5199\u5165\u5361\u7247\u4FA7\uFF1B\u5173\u8054\u884C\u5F52\u4E00\u4E3A `- \u6807\u7B7E\uFF1A`\u6807\u9898`\uFF08ID\uFF09`\uFF0C\u540C\u4E00\u76EE\u6807\u6309"\u6807\u9898\u6216 ID \u4EFB\u4E00\u547D\u4E2D"\u53BB\u91CD\uFF08\u4E0D\u4EA7\u751F\u91CD\u590D\u884C\uFF09\u3002\u65E0 ID \u7684\u65E7\u7B14\u8BB0\u9ED8\u8BA4\u4E0D\u5199\u5165\uFF08\u65E7\u7B14\u8BB0\u4E0D\u78B0\u4E0D\u52A8\uFF09\uFF1A\u5361\u7247\u2194\u65E7\u7B14\u8BB0\u53EA\u5199\u5361\u7247\u4FA7\uFF1B\u65E7\u7B14\u8BB0\u2194\u65E7\u7B14\u8BB0\u9700 config.linkIntoNotes \u5F00\u542F\u3002',
      parameters: {
        type: "object",
        properties: {
          fromId: { type: "string", description: '\u5361\u7247 ID/\u6807\u9898/\u8DEF\u5F84\uFF08\u65E7\u7B14\u8BB0\u7528"\u5DE5\u4F5C\u76EE\u5F55/\u76F8\u5BF9\u8DEF\u5F84"\uFF09' },
          toId: { type: "string", description: "\u5361\u7247 ID/\u6807\u9898/\u8DEF\u5F84" },
          kind: { type: "string", description: "prev=toId \u662F fromId \u7684\u524D\u7F6E / next=\u540E\u7EED / conflict=\u6613\u6DF7\u6DC6" }
        },
        required: ["fromId", "toId", "kind"]
      },
      output,
      execute: (args, exec) => {
        const kind = String(args.kind ?? "");
        if (!["prev", "next", "conflict"].includes(kind)) throw new Error("kind \u5FC5\u987B\u662F prev / next / conflict");
        return store.link(String(args.fromId ?? ""), String(args.toId ?? ""), kind, { sessionCwd: sessionCwdOf(exec) });
      }
    },
    {
      name: "card_moc",
      description: '\u751F\u6210 MOC\uFF08\u9886\u57DF\u5206\u7EC4 + Obsidian wikilink\uFF09\u5199\u5165"\u76EE\u5F55"\u76EE\u5F55\u5E76\u8FD4\u56DE\u6587\u672C\u3002\u5F52\u6863\u6536\u5C3E\u65F6\u7528\uFF1A\u4F20\u672C\u6B21\u6D89\u53CA\u7684\u5361\u7247 ID\u3002\u53EA\u6536\u5F55\u6709 ID \u7684\u5361\u7247\uFF0C\u65E7\u7B14\u8BB0\u81EA\u52A8\u8DF3\u8FC7\u3002title \u53EA\u4F20\u4E3B\u9898\u540D\uFF08\u5982 "\u56FE\u5F62\u5B66 MOC \u76EE\u5F55"\uFF09\u2014\u2014\u65E5\u671F\u524D\u7F00\u4E0E\u6587\u4EF6\u540D\u7531\u5DE5\u5177\u81EA\u52A8\u751F\u6210\uFF08\u6587\u4EF6\u540D = \u65E5\u671F_\u6807\u9898.md\uFF09\uFF0C\u8FD4\u56DE\u6587\u672C\u56DE\u663E \u6587\u4EF6\u540D/\u6807\u9898/\u65E5\u671F\uFF1B\u6807\u9898\u5E26\u65E5\u671F\u524D\u7F00\u4F1A\u88AB\u81EA\u52A8\u5265\u79BB\uFF0C\u52FF\u518D\u624B\u5199\u65E5\u671F\u3002',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "MOC \u4E3B\u9898\u540D\uFF0C\u53EA\u5199\u4E3B\u9898\uFF08\u5982 \u56FE\u5F62\u5B66 MOC \u76EE\u5F55\uFF1B\u9ED8\u8BA4 \u77E5\u8BC6\u76EE\u5F55\uFF0C\u65E5\u671F\u7531\u5DE5\u5177\u81EA\u52A8\u751F\u6210\uFF09" },
          cardIds: { type: "array", items: { type: "string" }, description: "\u672C\u6B21\u6D89\u53CA\u7684\u5361\u7247 ID/\u6807\u9898" },
          domain: { type: "string", description: "\u53EF\u9009\uFF1A\u53EA\u6536\u5F55\u8BE5\u9886\u57DF" }
        },
        required: ["cardIds"]
      },
      output,
      execute: (args, exec) => store.moc({
        title: args.title ? String(args.title) : void 0,
        cardIds: stringList(args.cardIds) ?? [],
        domain: args.domain ? String(args.domain) : void 0
      }, { sessionCwd: sessionCwdOf(exec) })
    },
    {
      name: "card_lint",
      description: '\u5361\u7247\u8D28\u91CF\u4F53\u68C0\uFF082026-09 \u91CD\u8BBE\u8BA1\u65B0\u589E\uFF09\uFF1A\u6309 14 \u6761\u89C4\u5219\u6253\u5206\u5E76\u7ED9\u51FA\u6539\u5199\u5EFA\u8BAE\u2014\u2014\u4F1A\u8BDD\u6B8B\u7559\uFF08\u8DEF\u5F84/\u884C\u53F7/\u7B2C\u4E8C\u4EBA\u79F0/\u4F1A\u8BDD\u65F6\u95F4\u8BCD/\u9636\u6BB5\u4EE3\u53F7\uFF09\u3001\u6A21\u677F\u5FC5\u586B\u5C0F\u8282\u3001\u4E3B\u5E72\u7EBF\u552F\u4E00\u3001\u524D\u7F6E\u68C0\u67E5\u3001\u91CD\u5165\u70B9\u3001\u9A8C\u8BC1\u5B9E\u9A8C\u6B65\u6570\u3001\u6392\u969C\u5224\u636E\u3001\u4EE3\u7801\u5757\u8BED\u8A00\u3001\u81EA\u6D4B\u9898\u7B54\u6848\u7387\u3001\u5C42\u7EA7\u5E8F\u53F7\u3001\u5173\u8054\u5757\u683C\u5F0F\u3001\u9886\u57DF\u6807\u7B7E\u3001\u5B9E\u4F8B\u8D70\u67E5\u3002\u5168\u90E8\u4E3A\u8B66\u544A\u7EA7\uFF08\u4E0D\u963B\u585E\u843D\u76D8\uFF09\u3002ref \u7ED9\u5355\u5361\uFF1Bscope="vault" \u6279\u91CF\u4F53\u68C0\uFF08limit \u63A7\u5236\u660E\u7EC6\u6761\u6570\uFF0C\u9ED8\u8BA4 20\uFF09\u3002cross=true \u505A\u8DE8\u5361\u4E00\u81F4\u6027\u68C0\u67E5\uFF08\u540C\u4E00\u7B26\u53F7/\u5E38\u91CF/\u53E3\u5F84\u5728\u591A\u5361\u53D6\u503C\u51B2\u7A81\uFF09\uFF1Btrend=true \u6309\u5468\u7EDF\u8BA1\u8D28\u91CF\u8D8B\u52BF\uFF1Brating=true \u8F93\u51FA\u53EF\u6267\u884C\u6027\u5206\u5E03\uFF08\u80FD\u8DD1/\u80FD\u67E5/\u53EA\u80FD\u8BFB\uFF09\u3002\u5F52\u6863\u540E\u81EA\u68C0\u3001\u6216\u7528\u6237\u95EE"\u5361\u7247\u8D28\u91CF/\u6709\u6CA1\u6709\u5199\u6B6A/\u53E3\u5F84\u662F\u5426\u4E00\u81F4"\u65F6\u7528\u3002',
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5355\u5361\uFF1A\u5361\u7247 ID/\u6807\u9898/\u8DEF\u5F84\uFF08\u4E0E scope \u4E8C\u9009\u4E00\uFF09" },
          scope: { type: "string", enum: ["vault", "all"], description: "\u6279\u91CF\uFF1Avault=\u53EA\u4F53\u68C0\u5361\u7247\uFF0Call=\u542B\u65E7\u7B14\u8BB0\uFF08\u65E7\u7B14\u8BB0\u65E0\u6A21\u677F\u8981\u6C42\uFF09" },
          limit: { type: "number", description: "\u6279\u91CF\u65F6\u8FD4\u56DE\u7684\u6700\u4F4E\u5206\u660E\u7EC6\u6761\u6570\uFF0C\u9ED8\u8BA4 20" },
          rule: { type: "string", enum: ruleIds(), description: "\u53EA\u770B\u67D0\u6761\u89C4\u5219\uFF08\u5982 session-residue\uFF09" },
          cross: { type: "boolean", description: "\u8DE8\u5361\u4E00\u81F4\u6027\u68C0\u67E5\uFF1A\u540C\u952E\uFF08\u8868\u683C\u9996\u5217/\u516C\u5F0F\u5DE6\u4FA7\uFF09\u5728\u591A\u5361\u53D6\u503C\u4E0D\u4E00\u81F4\u65F6\u5217\u51FA\u51B2\u7A81" },
          trend: { type: "boolean", description: "\u8D28\u91CF\u8D8B\u52BF\uFF1A\u6309\u5361\u7247 ID \u65E5\u671F\u5206\u5468\u8F93\u51FA\u5747\u5206\u4E0E\u77ED\u677F\u5206\u5E03" },
          rating: { type: "boolean", description: "\u53EF\u6267\u884C\u6027\u8BC4\u7EA7\uFF1A\u80FD\u8DD1\uFF08\u4EE3\u7801+\u9A8C\u8BC1\u5B9E\u9A8C\uFF09/\u80FD\u67E5\uFF08\u6392\u969C\u5224\u636E\u6216\u5BF9\u6BD4\u8868\uFF09/\u53EA\u80FD\u8BFB" }
        }
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.lint({
        ref: args.ref ? String(args.ref) : void 0,
        scope: args.scope === "vault" || args.scope === "all" ? args.scope : void 0,
        limit: Number(args.limit) > 0 ? Number(args.limit) : void 0,
        rule: args.rule ? String(args.rule) : void 0,
        cross: args.cross === true,
        trend: args.trend === true,
        rating: args.rating === true
      }, { sessionCwd: sessionCwdOf(exec) })
    },
    {
      name: "card_history",
      description: '\u7BA1\u7406\u5361\u7247\u7684\u7248\u672C\u66F4\u65B0 / \u52D8\u8BEF / \u5386\u53F2\u6298\u53E0\u5757\uFF1Aaction="list" \u5217\u51FA\u5404\u5757\uFF08\u7C7B\u578B/\u884C\u53F7/\u6458\u8981\uFF09\uFF1Baction="strip" \u6E05\u9664\u5386\u53F2\u5757\uFF08\u6B63\u6587\u4E0E\u5173\u8054\u4FDD\u7559\uFF0C\u5148\u6821\u9A8C <details> \u914D\u5BF9\uFF0C\u4E0D\u914D\u5BF9\u53EA\u8B66\u544A\u4E0D\u5220\uFF09\u3002\u7528\u6237\u8BF4"\u6E05\u6389\u5386\u53F2\u7248\u672C/\u8FD9\u5F20\u5361\u592A\u957F\u4E86/\u53EA\u7559\u6700\u65B0\u7248"\u65F6\u7528\uFF1BdryRun=true \u53EA\u770B\u4F1A\u5220\u4EC0\u4E48\u3002',
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5361\u7247 ID/\u6807\u9898/\u8DEF\u5F84" },
          action: { type: "string", enum: ["list", "strip"], description: "list=\u5217\u51FA\uFF1Bstrip=\u6E05\u9664" },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["version", "errata", "details"] },
            description: "strip \u65F6\u53EA\u6E05\u6307\u5B9A\u7C7B\u578B\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF1Aversion=\u7248\u672C\u66F4\u65B0\uFF0Cerrata=\u52D8\u8BEF\uFF0Cdetails=\u5386\u53F2\u6298\u53E0\u5757\uFF09"
          },
          dryRun: { type: "boolean", description: "strip \u65F6\u53EA\u62A5\u544A\u5C06\u5220\u9664\u7684\u5757\uFF0C\u4E0D\u5199\u76D8" }
        },
        required: ["ref", "action"]
      },
      output,
      execute: (args) => store.history(String(args.ref ?? ""), String(args.action ?? ""), {
        kinds: stringList(args.kinds),
        dryRun: args.dryRun === true
      })
    },
    {
      name: "card_rename",
      description: '\u6539\u5361\u7247\u6807\u9898\u5E76\u540C\u6B65\u4E00\u5207\u5F15\u7528\uFF082026-09 \u91CD\u8BBE\u8BA1\u65B0\u589E\uFF09\uFF1Afrontmatter \u6807\u9898 + \u6587\u4EF6\u540D\uFF08\u4EC5\u5F53\u6587\u4EF6\u540D\u4E0E\u65E7\u6807\u9898\u4E00\u81F4\u65F6\uFF09+ \u5168\u5E93\u5165\u94FE\uFF08`\u6807\u9898`\uFF08ID\uFF09\u4E0E [[wikilink]]\uFF09+ \u65AD\u94FE\u68C0\u6D4B\u3002dryRun=true \u53EA\u9884\u6F14\u3002\u7528\u6237\u8BF4"\u8FD9\u5F20\u5361\u6807\u9898\u6539\u6210 X/\u540D\u5B57\u5199\u9519\u4E86"\u65F6\u7528\uFF1B\u65E7\u7B14\u8BB0\uFF08\u65E0 ID\uFF09\u4E0D\u652F\u6301\u6539\u540D\u3002',
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "\u5361\u7247 ID/\u6807\u9898/\u8DEF\u5F84" },
          newTitle: { type: "string", description: "\u65B0\u6807\u9898\uFF08\u975E\u6CD5\u5B57\u7B26\u4F1A\u88AB\u6E05\u6D17\u4E3A\u6587\u4EF6\u540D\uFF09" },
          dryRun: { type: "boolean", description: "\u53EA\u9884\u6F14\uFF1A\u8FD4\u56DE\u5C06\u6539\u52A8\u7684\u6587\u4EF6\u6E05\u5355\u4E0E\u65AD\u94FE\uFF0C\u4E0D\u5199\u76D8" }
        },
        required: ["ref", "newTitle"]
      },
      output,
      execute: (args, exec) => store.rename(String(args.ref ?? ""), String(args.newTitle ?? ""), {
        dryRun: args.dryRun === true,
        sessionCwd: sessionCwdOf(exec)
      })
    },
    {
      name: "study_progress",
      description: '\u8BFB\u5199\u5B66\u4E60\u8FDB\u5EA6\uFF08\u6301\u4E45\uFF0C\u8DE8\u4F1A\u8BDD\u6709\u6548\uFF09\uFF1A\u8D44\u6599/\u5C0F\u8282/\u672A\u7B54\u8FFD\u95EE/\u89E6\u53CA\u5361\u7247\u3002"\u63A5\u7740\u8BB2"\u524D get\uFF1B\u5C0F\u8282\u63A8\u8FDB set\uFF1B\u5F52\u6863\uFF08\u6574\u7406\u7B14\u8BB0\uFF09\u524D\u68C0\u67E5 pendingQuestions\u3002',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "get/set/clear" },
          material: { type: "string", description: "set\uFF1A\u8D44\u6599\u540D" },
          section: { type: "string", description: "set\uFF1A\u5C0F\u8282" },
          pendingQuestions: { type: "array", items: { type: "string" }, description: "set\uFF1A\u8FFD\u95EE\u961F\u5217\uFF08\u6574\u4F53\u66FF\u6362\uFF09" },
          touchedCardIds: { type: "array", items: { type: "string" }, description: "set\uFF1A\u89E6\u53CA\u5361\u7247 ID\uFF08\u6574\u4F53\u66FF\u6362\uFF09" }
        },
        required: ["action"]
      },
      output,
      execute: (args) => store.progress(String(args.action ?? "get"), {
        material: args.material ? String(args.material) : void 0,
        section: args.section ? String(args.section) : void 0,
        pendingQuestions: stringList(args.pendingQuestions),
        touchedCardIds: stringList(args.touchedCardIds)
      })
    },
    {
      name: "study_memory",
      description: '\u8BFB\u5199\u8DE8\u4F1A\u8BDD\u8BB0\u5FC6\uFF08vault .study/memory.json\uFF0C\u6301\u4E45\u6709\u6548\uFF0C\u91CD\u542F\u4E0D\u4E22\uFF09\uFF1A\u952E\u503C\u7B14\u8BB0\u3002\u65B0\u4F1A\u8BDD\u5F00\u573A\u5148 get\uFF08\u914D\u5408 study_progress(get) \u7ED9\u8854\u63A5\u63D0\u793A\uFF09\uFF1B\u7528\u6237\u504F\u597D/\u7EA6\u5B9A\u5B58 prefs \u952E\uFF1B\u544A\u4E00\u6BB5\u843D\u6216\u5F52\u6863\u65F6 set lastSummary=\u672C\u6B21\u5C0F\u7ED3\u3002\u6E05\u7A7A\u8FDB\u5EA6\uFF08study_progress clear\uFF09\u4E0D\u5F71\u54CD\u8BB0\u5FC6\u3002get \u5168\u91CF\u8F93\u51FA\u4F1A\u5BF9\u542B"\u73B0\u5B66/\u6B63\u5728\u5B66"\u7B49\u8FDB\u5EA6\u53E5\u7684\u952E\u7ED9\u51FA\u8FC7\u671F\u63D0\u793A\u2014\u2014\u8FDB\u5EA6\u4F4D\u7F6E\u4EE5 study_progress \u4E3A\u51C6\uFF08\u5355\u4E00\u6765\u6E90\uFF09\u3002\u4FDD\u7559\u63A7\u5236\u952E _autoPrefs\uFF08\u81EA\u8FED\u4EE3\u8BB0\u5FC6\u5F00\u5173\uFF0C\u503C on/off\uFF0C\u9ED8\u8BA4\u5173\u95ED\uFF09\uFF1Aset \u5207\u6362\u3001remove \u56DE\u9ED8\u8BA4\u3001\u4E0D\u652F\u6301 append\uFF1B\u5F00\u542F\u540E\u65E0\u9700\u7528\u6237"\u8BF7\u8BB0\u4F4F"\uFF0C\u6309 memory-auto \u6280\u80FD\u628A\u6301\u4E45\u504F\u597D/\u7EA6\u5B9A\u81EA\u52A8\u5199\u5165 prefs.* \u952E\uFF08\u6BCF\u7C7B\u7EA6\u5B9A\u4E00\u4E2A\u952E\u3001\u8986\u76D6\u66F4\u65B0\uFF09\u3002',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "get\uFF08key \u53EF\u9009\uFF0C\u9ED8\u8BA4\u5168\u91CF\uFF09/set/append/remove/clear" },
          key: { type: "string", description: "\u8BB0\u5FC6\u952E\u540D\uFF08\u226464 \u5B57\u7B26\uFF1BlastSummary=\u4E0A\u6B21\u5C0F\u7ED3\uFF0C\u7F6E\u9876\u663E\u793A\uFF1B_autoPrefs=\u81EA\u8FED\u4EE3\u5F00\u5173\uFF0C\u503C on/off\uFF09" },
          value: { type: "string", description: "set/append\uFF1A\u8BB0\u5FC6\u5185\u5BB9\uFF08\u22644000 \u5B57\u7B26\uFF09" }
        },
        required: ["action"]
      },
      output,
      execute: (args) => store.memory(String(args.action ?? "get"), {
        key: args.key !== void 0 && args.key !== null ? String(args.key) : void 0,
        value: args.value !== void 0 && args.value !== null ? String(args.value) : void 0
      })
    }
  ];
}

// src/index.ts
var name = "study-buddy";
var inject = ["tools"];
function normalizeConfig(config) {
  if (!config?.vaultRoot || !String(config.vaultRoot).trim()) {
    throw new Error("dsh-study-buddy \u9700\u8981 config.vaultRoot\uFF08Obsidian vault \u6839\u76EE\u5F55\uFF09");
  }
  const vaultRoot = resolve2(String(config.vaultRoot));
  if (vaultRoot === resolve2("/")) {
    throw new Error(`vaultRoot \u4E0D\u80FD\u662F\u6587\u4EF6\u7CFB\u7EDF\u6839\uFF1A${vaultRoot}`);
  }
  return {
    vaultRoot,
    stateDir: String(config.stateDir ?? ".study").trim() || ".study",
    fallbackDir: String(config.fallbackDir ?? "\u672A\u5206\u7C7B").trim() || "\u672A\u5206\u7C7B",
    mocDir: String(config.mocDir ?? "\u76EE\u5F55").trim() || "\u76EE\u5F55",
    domainFolders: config.domainFolders ?? {},
    skipDirs: Array.isArray(config.skipDirs) ? config.skipDirs.map(String) : [],
    searchRoots: Array.isArray(config.searchRoots) ? config.searchRoots.map(String) : [],
    includeSessionCwd: config.includeSessionCwd === true,
    linkIntoNotes: config.linkIntoNotes === true,
    lint: config.lint
  };
}
function byUniqueRef(index, ref) {
  const candidates = index.candidatesForRef(ref);
  if (candidates.length === 0) return void 0;
  if (candidates.length > 1) {
    throw new Error(`\u8DEF\u5F84\u6B67\u4E49\uFF1A"${ref}" \u547D\u4E2D\u591A\u7BC7\uFF08${candidates.map((c) => c.fullRel).join("\u3001")}\uFF09\uFF0C\u8BF7\u7528\u6839\u9650\u5B9A\u8DEF\u5F84\uFF08\u5982 "vault/xxx.md"\uFF09`);
  }
  return candidates[0];
}
function fmtHits(hits) {
  const lines = hits.map((h) => {
    const id = h.id ? ` [${h.id}]` : "";
    const meta = [
      h.domain ? `\u9886\u57DF: ${h.domain}` : `\u76EE\u5F55: ${h.inferredDomain}`,
      h.status ? `\u72B6\u6001: ${h.status}` : "",
      h.source ? `\u6765\u6E90: ${h.source}` : ""
    ].filter(Boolean).join("\uFF0C");
    const def = h.definition ? `- \u5B9A\u4E49\uFF1A${h.definition.length > 40 ? `${h.definition.slice(0, 40)}\u2026` : h.definition}` : "";
    return [
      `### ${h.title}${id}`,
      `- \u7C7B\u578B\uFF1A${h.kind === "card" ? "\u5361\u7247" : "\u65E7\u7B14\u8BB0"}`,
      `- \u8DEF\u5F84\uFF1A${h.fullRel}`,
      meta ? `- ${meta}` : "",
      def,
      `- \u7247\u6BB5\uFF1A${h.snippet}`
    ].filter(Boolean).join("\n");
  });
  return lines.join("\n\n");
}
var VaultStore = class {
  constructor(layout) {
    this.layout = layout;
    this.extraRoots = resolveSearchRoots(layout.vaultRoot, layout.searchRoots);
  }
  index = null;
  sig = null;
  extraRoots = [];
  stateFile() {
    const p = join2(this.layout.vaultRoot, this.layout.stateDir, "progress.json");
    if (!withinRoot(this.layout.vaultRoot, p)) throw new Error("\u8FDB\u5EA6\u6587\u4EF6\u8DEF\u5F84\u8D8A\u754C");
    return p;
  }
  memoryFile() {
    const p = join2(this.layout.vaultRoot, this.layout.stateDir, "memory.json");
    if (!withinRoot(this.layout.vaultRoot, p)) throw new Error("\u8BB0\u5FC6\u6587\u4EF6\u8DEF\u5F84\u8D8A\u754C");
    return p;
  }
  async assertVault() {
    try {
      const st = await fsp4.stat(this.layout.vaultRoot);
      if (!st.isDirectory()) throw new Error();
    } catch {
      throw new Error(`vault \u6839\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BFB\uFF1A${this.layout.vaultRoot}\uFF08\u68C0\u67E5 preset \u884C config.vaultRoot\uFF09`);
    }
  }
  /** 当前会话的检索根：vault 优先，随后配置的 searchRoots，最后（可选）会话工作目录 */
  rootsFor(sessionCwd) {
    const roots = [{ path: this.layout.vaultRoot, label: "vault" }, ...this.extraRoots];
    const cwd = sessionCwd && sessionCwd.trim() ? String(sessionCwd).trim() : void 0;
    if (this.layout.includeSessionCwd && cwd) {
      if (canonicalRootKey(cwd) !== canonicalRootKey(resolve2("/"))) {
        roots.push({ path: resolve2(cwd), label: "\u5DE5\u4F5C\u76EE\u5F55" });
      }
    }
    return dedupeRoots(roots);
  }
  /** 目录签名（含各根文件 mtime/ctime/size 与 cwd）变化才重建索引（Obsidian 外部编辑后仍能查到最新内容） */
  async refresh(sessionCwd) {
    await this.assertVault();
    const roots = this.rootsFor(sessionCwd);
    const walked = await walkRoots(roots, skipSetFor(this.layout.skipDirs));
    const files = dedupeFiles(walked);
    const sig = `${sessionCwd ?? ""}
` + files.map((f) => `${f.root}|${f.rel}|${f.mtimeMs}|${f.ctimeMs}|${f.size}`).join("\n");
    if (this.index && sig === this.sig) return this.index;
    const cards = [];
    for (const f of files) {
      try {
        const raw = await fsp4.readFile(f.path, "utf8");
        cards.push(indexNote(f, raw));
      } catch {
      }
    }
    this.index = new SearchIndex();
    this.index.rebuild(cards, roots.length > 1);
    this.sig = sig;
    return this.index;
  }
  async resolveCard(ref, sessionCwd) {
    const index = await this.refresh(sessionCwd);
    const card = index.byId(ref) ?? index.byTitle(ref) ?? byUniqueRef(index, ref);
    if (!card) {
      throw new Error(`\u627E\u4E0D\u5230\u5361\u7247 "${ref}"\uFF08\u53EF\u4F20 ID\u3001\u6807\u9898\u3001\u6839\u9650\u5B9A\u8DEF\u5F84 \u5982 "\u5DE5\u4F5C\u76EE\u5F55/\u5B50\u76EE\u5F55/\u7B14\u8BB0.md"\u3001\u76F8\u5BF9\u8DEF\u5F84\u6216\u6587\u4EF6\u540D\uFF09`);
    }
    const raw = await fsp4.readFile(card.path, "utf8");
    return { card, raw };
  }
  async search(query, opts = {}, call) {
    const index = await this.refresh(call?.sessionCwd);
    const hits = index.search(query, opts);
    if (hits.length === 0) {
      return `\u672A\u547D\u4E2D\uFF08\u5171\u68C0\u7D22 ${index.size} \u7BC7${this.indexScopes(index)}\uFF09\u3002\u53EF\u6362\u8BCD\u518D\u8BD5\uFF1B\u65B0\u6982\u5FF5\u76F4\u63A5\u8FDB\u5165\u8BB2\u89E3\uFF0C\u5F52\u6863\u65F6\u65B0\u5EFA\u5361\u7247\u3002`;
    }
    return `\u547D\u4E2D ${hits.length}\uFF08\u5171 ${index.size} \u7BC7${this.indexScopes(index)}\uFF09\uFF1A

${fmtHits(hits)}`;
  }
  indexScopes(index) {
    const roots = new Set(index.all().map((c) => c.root));
    return roots.size > 0 ? `\uFF0C\u6765\u6E90\uFF1A${[...roots].join(" / ")}` : "";
  }
  async get(ref, call) {
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd);
    return `\u8DEF\u5F84\uFF1A${card.fullRel}

${raw}`;
  }
  async create(input) {
    await this.assertVault();
    const mapped = this.layout.domainFolders?.[input.domain];
    const resolved = resolveTemplate(input, { mappedFolder: mapped });
    const card = { ...input, template: resolved.type };
    const result = validateCard(card, { mappedFolder: mapped });
    if (result.errors.length > 0) throw new Error(`\u5361\u7247\u6821\u9A8C\u5931\u8D25\uFF1A${result.errors.join("\uFF1B")}`);
    const warnings = [...result.warnings];
    const infoLines = [];
    const baseName = sanitizeFilename(input.title);
    if (baseName !== input.title.trim()) {
      warnings.push(`\u6807\u9898\u542B\u975E\u6CD5\u5B57\u7B26/\u5F15\u53F7\uFF0C\u5DF2\u6E05\u6D17\u4E3A\u6587\u4EF6\u540D\u300C${baseName}\u300D\uFF08\u5B9E\u9645\u6587\u4EF6\u540D\u4EE5"\u5DF2\u5199\u5165"\u4E3A\u51C6\uFF09`);
    }
    const id = generateId();
    const text = renderCard({ ...card, id });
    const dir = cardDirFor(this.layout, input.domain);
    const dirRel = dir.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, "/");
    const keys = Object.keys(this.layout.domainFolders ?? {});
    if (mapped) {
      infoLines.push(`\u9886\u57DF\u6620\u5C04\uFF1A${input.domain} \u2192 ${dirRel}`);
      infoLines.push(`\u6A21\u677F\uFF1A${resolved.type}${input.template ? "\uFF08\u663E\u5F0F\uFF09" : "\uFF08\u6309\u9886\u57DF/\u6807\u9898\u63A8\u65AD\uFF0C\u53EF\u7528 template \u8986\u76D6\uFF09"}`);
    } else if (keys.length > 0) {
      const similar = findSimilarDomainKeys(input.domain, keys);
      const simText = similar.length > 0 ? `\u3002\u8FD1\u4F3C\u952E\u5EFA\u8BAE\uFF1A${similar.map((k) => `${k} \u2192 ${this.layout.domainFolders?.[k]}`).join("\uFF1B")}\uFF08\u8981\u7528\u8BE5\u952E\u8BF7\u7528\u5176\u7CBE\u786E\u5199\u6CD5\uFF0C\u6216\u628A\u8BE5\u952E\u52A0\u5165 domainFolders\uFF09` : "";
      warnings.push(
        `\u9886\u57DF\u952E "${input.domain}" \u672A\u5728 domainFolders \u6620\u5C04\u8868\u4E2D\uFF0C\u5DF2\u843D fallbackDir\uFF1A${this.layout.fallbackDir}/${input.domain}\u3002\u53EF\u7528\u952E\uFF08\u524D 12 \u4E2A\uFF0C\u5171 ${keys.length} \u4E2A\uFF09\uFF1A${keys.slice(0, 12).join("\u3001")}${keys.length > 12 ? "\u2026" : ""}${simText}\u3002\u5B8C\u6574\u952E\u540D\u8868\u89C1 card-format \u6280\u80FD\uFF1B\u82E5\u521A\u6539\u8FC7 preset \u914D\u7F6E\uFF0C\u9700\u91CD\u542F DSH \u540E\u751F\u6548`
      );
    } else {
      warnings.push(`\u9886\u57DF\u952E "${input.domain}" \u672A\u914D\u7F6E\u6620\u5C04\uFF08domainFolders \u4E3A\u7A7A\uFF09\uFF0C\u5DF2\u843D fallbackDir\uFF1A${this.layout.fallbackDir}/${input.domain}`);
      infoLines.push(`\u6A21\u677F\uFF1A${resolved.type}\uFF08\u6309\u6807\u9898\u63A8\u65AD\uFF09`);
    }
    const file = await uniqueCardPath(dir, input.title, id);
    await atomicWrite(file, text);
    this.sig = null;
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, "/");
    const info = infoLines.length > 0 ? `
${infoLines.join("\n")}` : "";
    const warn = warnings.length > 0 ? `
\u63D0\u793A\uFF1A${warnings.join("\uFF1B")}` : "";
    return { text: `\u5DF2\u5199\u5165\uFF1A${rel}
ID\uFF1A${id}${info}${warn}

${text}`, rel };
  }
  async update(id, payload) {
    const { card, raw } = await this.resolveCard(id);
    const mappedFolder = payload.card?.domain ? this.layout.domainFolders?.[payload.card.domain] : void 0;
    const result = applyUpdate(raw, card.id ?? id, { ...payload, mappedFolder });
    await atomicWrite(card.path, result.text);
    this.sig = null;
    const rel = card.rel.replace(/\\/g, "/");
    const warn = result.warnings.length > 0 ? `
\u63D0\u793A\uFF1A${result.warnings.join("\uFF1B")}` : "";
    return `\u5DF2\u66F4\u65B0\uFF1A${rel}
ID\uFF1A${card.id ?? id}${warn}

${result.text}`;
  }
  async link(fromId, toId, kind, call) {
    const from = await this.resolveCard(fromId, call?.sessionCwd);
    const to = await this.resolveCard(toId, call?.sessionCwd);
    const labelOf = (c) => c.card.id ? `${c.card.title}\uFF08${c.card.id}\uFF09` : `${c.card.title}\uFF08${c.card.fullRel}\uFF09`;
    const allowNoteWrite = this.layout.linkIntoNotes === true;
    const reverseKind = kind === "prev" ? "next" : kind === "next" ? "prev" : "conflict";
    const noteSkipped = [];
    const written = [];
    const applySide = async (side, sideKind, targetLabel, targetId) => {
      if (side.card.id === null && !allowNoteWrite) {
        noteSkipped.push(labelOf(side));
        return;
      }
      const next = addLink(side.raw, sideKind, targetLabel, targetId ?? void 0);
      if (next !== side.raw) {
        await atomicWrite(side.card.path, next);
        written.push(labelOf(side));
      }
    };
    if (from.card.id === null && to.card.id === null && !allowNoteWrite) {
      throw new Error(
        "\u4E24\u4FA7\u90FD\u662F\u65E7\u7B14\u8BB0\uFF08\u65E0 ID\uFF09\uFF1A\u9ED8\u8BA4\u4E0D\u5199\u5165\u65E7\u7B14\u8BB0\u3002\u8BF7\u5F00\u542F config.linkIntoNotes \u7531\u63D2\u4EF6\u53CC\u5411\u5199\u5165\uFF0C\u6216\u5728 Obsidian \u4E2D\u7528 [[ ]] \u5185\u94FE\u624B\u52A8\u8FDE\u63A5\u3002"
      );
    }
    await applySide(from, kind, labelOf(to), to.card.id);
    await applySide(to, reverseKind, labelOf(from), from.card.id);
    this.sig = null;
    const map = { prev: "\u524D\u7F6E\u77E5\u8BC6", next: "\u540E\u7EED\u5EF6\u4F38", conflict: "\u51B2\u7A81/\u6613\u6DF7\u6DC6" };
    const basis = `\u5DF2\u5EFA\u7ACB\u5173\u8054\uFF1A${labelOf(from)} \u2190${map[kind]}\u2192 ${labelOf(to)}`;
    if (noteSkipped.length > 0) {
      return `${basis}\uFF08\u5355\u4FA7\u5199\u5165\uFF1B\u672A\u4FEE\u6539\u65E7\u7B14\u8BB0\uFF1A${noteSkipped.join("\u3001")}\u3002\u5F00\u542F config.linkIntoNotes \u53EF\u53CC\u5411\u5199\u5165\uFF0C\u6216\u7528 Obsidian \u5185\u94FE\uFF09`;
    }
    return written.length > 0 ? `${basis}\uFF08\u5DF2\u5199\u5165 ${written.length} \u4FA7\uFF09` : `${basis}\uFF08\u5173\u8054\u5DF2\u5B58\u5728\uFF0C\u65E0\u6539\u52A8\uFF09`;
  }
  async moc(opts, call) {
    const index = await this.refresh(call?.sessionCwd);
    const entries = [];
    const missing = [];
    const skippedNotes = [];
    for (const ref of opts.cardIds) {
      const card = index.byId(ref) ?? index.byTitle(ref) ?? byUniqueRef(index, ref);
      if (!card) {
        missing.push(ref);
        continue;
      }
      if (card.id === null) {
        skippedNotes.push(card.fullRel);
        continue;
      }
      const domain = card.domain ?? card.inferredDomain;
      if (opts.domain && domain !== opts.domain) continue;
      entries.push({ id: card.id, title: card.title, domain, fileName: card.fileName });
    }
    if (entries.length === 0) {
      throw new Error(`MOC \u6CA1\u6709\u53EF\u6536\u5F55\u7684\u5361\u7247\uFF08\u672A\u89E3\u6790\u5230\u4EFB\u4F55\u76EE\u6807\u5361\u7247${missing.length ? `\uFF0C\u7F3A\u5931\uFF1A${missing.join("\u3001")}` : ""}${skippedNotes.length ? `\uFF1B\u8DF3\u8FC7\u7684\u65E7\u7B14\u8BB0\uFF1A${skippedNotes.join("\u3001")}` : ""}\uFF09`);
    }
    const date = todayLocal();
    const title = stripMocDatePrefix(opts.title ?? "") || "\u77E5\u8BC6\u76EE\u5F55";
    const text = renderMoc(title, date, entries);
    const file = mocPathFor(this.layout, title, date);
    await atomicWrite(file, text);
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, "/");
    return `MOC \u5DF2\u5199\u5165\uFF1A${rel}\uFF08\u6807\u9898\uFF1A${title}\uFF0C\u65E5\u671F\uFF1A${date}\uFF09${skippedNotes.length ? `
\uFF08\u65E7\u7B14\u8BB0\u4E0D\u6536\u5F55\uFF1A${skippedNotes.join("\u3001")}\uFF09` : ""}

${text}`;
  }
  /** 单卡/批量质量体检（card_lint）+ 跨卡一致性 / 质量趋势 / 可执行性评级（P2） */
  async lint(opts, call) {
    const index = await this.refresh(call?.sessionCwd);
    const ctx = {
      knownDomains: Object.keys(this.layout.domainFolders ?? {}),
      residueLevel: this.layout.lint?.residueLevel,
      rulesOff: this.layout.lint?.rulesOff
    };
    const reportOf = (raw, card) => {
      const parsed = parseFrontmatter(raw);
      return lintCard({
        title: parsed.meta?.title ?? card.title,
        definition: card.definition ?? "",
        body: parsed.body,
        template: parsed.meta?.template,
        tags: card.tags
      }, ctx);
    };
    if (opts.ref) {
      const { card, raw } = await this.resolveCard(opts.ref, call?.sessionCwd);
      const report = reportOf(raw, card);
      if (opts.rule) {
        const hits = report.findings.filter((f) => f.rule === opts.rule);
        const passed = report.passed[opts.rule];
        return `\u5361\u7247\uFF1A${report.title}  \u89C4\u5219\uFF1A${opts.rule}  ${passed ? "\u2713 \u901A\u8FC7" : "\u2717/\u26A0 \u672A\u901A\u8FC7"}
` + (hits.length > 0 ? hits.map((f) => `  ${f.message}${f.suggestion ? `
    \u5EFA\u8BAE\uFF1A${f.suggestion}` : ""}`).join("\n") : "  \uFF08\u8BE5\u89C4\u5219\u65E0\u53D1\u73B0\uFF09");
      }
      const body = parseFrontmatter(raw).body;
      const rating = opts.rating === false ? "" : `
  \u53EF\u6267\u884C\u6027\uFF1A${executabilityOf(body)}`;
      return `${formatReport(report)}${rating}`;
    }
    const cards = index.all().filter((c) => opts.scope === "all" ? true : c.id !== null);
    if (cards.length === 0) return "\u672A\u627E\u5230\u53EF\u4F53\u68C0\u7684\u5361\u7247\u3002";
    const reports = [];
    const titles = [];
    const bodies = [];
    const ids = [];
    for (const card of cards) {
      let raw = "";
      try {
        raw = await fsp4.readFile(card.path, "utf8");
      } catch {
        continue;
      }
      const report = reportOf(raw, card);
      reports.push(report);
      titles.push(card.fullRel);
      bodies.push(parseFrontmatter(raw).body);
      ids.push(card.id);
    }
    if (opts.rule) {
      const hit = reports.filter((r) => r.findings.some((f) => f.rule === opts.rule));
      const lines = [`\u89C4\u5219 ${opts.rule}\uFF08${ruleTitle(opts.rule)}\uFF09\uFF1A${hit.length}/${reports.length} \u5F20\u5361\u547D\u4E2D`];
      for (const r of hit.slice(0, opts.limit ?? 20)) {
        for (const f of r.findings.filter((x) => x.rule === opts.rule)) lines.push(`  - ${r.title}\uFF1A${f.message}`);
      }
      return lines.join("\n");
    }
    if (opts.cross) {
      const groups = crossCardConflicts(bodies.map((body, i) => ({ label: titles[i], body })));
      return formatConflicts(groups, opts.limit ?? 20);
    }
    if (opts.trend) {
      return formatTrend(qualityTrend(reports.map((report, i) => ({ id: ids[i], report }))));
    }
    const parts = [formatBatch(summarizeLint(reports, titles), opts.limit ?? 20)];
    if (opts.rating) {
      const summary = executabilitySummary(bodies.map((body) => ({ body })));
      parts.push(`\u53EF\u6267\u884C\u6027\u5206\u5E03\uFF1A${summary.map((s) => `${s.rating} ${s.count} \u5F20`).join("\uFF0C")}`);
    }
    return parts.join("\n");
  }
  /** 版本更新 / 勘误 / 历史折叠块管理（card_history） */
  async history(ref, action, opts = {}, call) {
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd);
    const parsed = parseFrontmatter(raw);
    const blocks = extractHistory(parsed.body);
    if (action === "list") {
      return `\u5361\u7247\uFF1A${card.title}\uFF08${card.id ?? "\u65E7\u7B14\u8BB0"}\uFF09\u5386\u53F2\u5757 ${blocks.length} \u4E2A
${formatHistory(blocks)}`;
    }
    if (action !== "strip") throw new Error(`card_history \u672A\u77E5 action "${action}"\uFF08\u53EF\u7528 list/strip\uFF09`);
    const result = stripHistory(parsed.body, { kinds: opts.kinds });
    if (opts.dryRun) {
      return `[dryRun] \u5361\u7247\uFF1A${card.title}\uFF0C\u5C06\u5220\u9664 ${result.removed.length} \u4E2A\u5386\u53F2\u5757\uFF1A
${formatHistory(result.removed)}${result.warnings.length ? `
\u63D0\u793A\uFF1A${result.warnings.join("\uFF1B")}` : ""}`;
    }
    if (result.removed.length === 0) {
      return `\u5361\u7247\uFF1A${card.title} \u65E0\u5386\u53F2\u5757\u53EF\u6E05\u9664\u3002${result.warnings.length ? `
\u63D0\u793A\uFF1A${result.warnings.join("\uFF1B")}` : ""}`;
    }
    const head = raw.slice(0, raw.length - parsed.body.length);
    await atomicWrite(card.path, `${head}${result.text}
`);
    this.sig = null;
    const warn = result.warnings.length > 0 ? `
\u63D0\u793A\uFF1A${result.warnings.join("\uFF1B")}` : "";
    return `\u5DF2\u6E05\u9664\uFF1A${card.rel.replace(/\\/g, "/")}\uFF08\u5220\u9664 ${result.removed.length} \u4E2A\u5386\u53F2\u5757\uFF09
${formatHistory(result.removed)}${warn}`;
  }
  /** 改标题并同步文件名 / 全库入链 / 断链检测（card_rename） */
  async rename(ref, newTitle, opts = {}) {
    const { card, raw } = await this.resolveCard(ref, opts.sessionCwd);
    if (card.id === null) {
      throw new Error(`"${card.title}" \u662F\u65E7\u7B14\u8BB0\uFF08\u65E0 ID\uFF09\uFF0C\u4E0D\u652F\u6301\u6539\u540D\uFF1B\u8BF7\u7528 Obsidian \u91CD\u547D\u540D\uFF0C\u6216\u7528 card_update(replace) \u539F\u5730\u5347\u7EA7\u4E3A\u5361\u7247`);
    }
    const title = String(newTitle ?? "").trim();
    if (!title) throw new Error("newTitle \u4E0D\u80FD\u4E3A\u7A7A");
    const oldTitle = cardTitleOf(raw) || card.title;
    if (title === oldTitle) return `\u65B0\u6807\u9898\u4E0E\u65E7\u6807\u9898\u76F8\u540C\uFF08${title}\uFF09\uFF0C\u65E0\u6539\u52A8\u3002`;
    const index = await this.refresh(opts.sessionCwd);
    const clash = index.byTitle(title);
    if (clash && clash.id !== card.id) throw new Error(`\u5DF2\u5B58\u5728\u540C\u540D\u5361\u7247 "${title}"\uFF08${clash.fullRel}\uFF09\uFF0C\u8BF7\u6362\u6807\u9898`);
    const plan = planRename({ fileName: card.fileName, oldTitle, newTitle: title });
    const rewritten = replaceCardTitle(raw, title);
    const selfRewrite = rewriteCardLinks(parseFrontmatter(rewritten).body, { oldTitle, newTitle: title, targetId: card.id ?? void 0 });
    const selfText = `${rewritten.slice(0, rewritten.length - parseFrontmatter(rewritten).body.length)}${selfRewrite.text}`;
    const changed = [
      { rel: card.fullRel, kind: "\u672C\u5361\u6807\u9898", changed: 1, samples: [`${oldTitle} \u2192 ${title}`] }
    ];
    if (selfRewrite.changed > 0) changed.push({ rel: card.fullRel, kind: "\u672C\u5361\u5173\u8054\u5361\u7247", changed: selfRewrite.changed, samples: selfRewrite.samples });
    const roots = this.rootsFor(opts.sessionCwd);
    const files = dedupeFiles(await walkRoots(roots, skipSetFor(this.layout.skipDirs)));
    const writes = [];
    const broken = [];
    for (const file of files) {
      if (canonicalRootKey(file.path) === canonicalRootKey(card.path)) continue;
      let content = "";
      try {
        content = await fsp4.readFile(file.path, "utf8");
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(content);
      const isCard = Boolean(parsed.meta?.id);
      const linkRewrite = rewriteCardLinks(parsed.body, { oldTitle, newTitle: title, targetId: card.id ?? void 0 });
      let nextBody = linkRewrite.text;
      let changedCount = linkRewrite.changed;
      const samples = [...linkRewrite.samples];
      if (isCard) {
        const wiki = rewriteWikilinks(nextBody, plan.oldBase, plan.newBase);
        nextBody = wiki.text;
        changedCount += wiki.changed;
        samples.push(...wiki.samples);
      }
      if (changedCount === 0) continue;
      const head = content.slice(0, content.length - parsed.body.length);
      const target = `${head}${nextBody}`;
      if (file.root !== "vault") {
        changed.push({ rel: file.rel, kind: `\u53EA\u8BFB\u6839(${file.root}) \u672A\u5199\u5165`, changed: changedCount, samples });
        continue;
      }
      if (opts.dryRun) {
        changed.push({ rel: file.rel.replace(/\\/g, "/"), kind: isCard ? "\u5361\u7247\u5165\u94FE" : "\u6587\u6863\u5165\u94FE", changed: changedCount, samples });
        continue;
      }
      writes.push({ path: file.path, text: target });
      changed.push({ rel: file.rel.replace(/\\/g, "/"), kind: isCard ? "\u5361\u7247\u5165\u94FE" : "\u6587\u6863\u5165\u94FE", changed: changedCount, samples });
      broken.push(...detectBrokenLinks(nextBody, { oldTitle, oldId: card.id ?? void 0, newTitle: title }));
    }
    if (opts.dryRun) {
      return formatRenameReport({ id: card.id, oldTitle, newTitle: title, plan, filesChanged: changed, broken, dryRun: true });
    }
    await atomicWrite(card.path, `${selfText}
`);
    for (const write of writes) await atomicWrite(write.path, write.text);
    let finalRel = card.rel.replace(/\\/g, "/");
    if (plan.renameFile) {
      const targetPath = join2(card.path.slice(0, card.path.length - card.fileName.length), `${plan.newBase}.md`);
      if (canonicalRootKey(targetPath) !== canonicalRootKey(card.path)) {
        if (await this.fileExists(targetPath)) throw new Error(`\u76EE\u6807\u6587\u4EF6\u540D\u5DF2\u5B58\u5728\uFF1A${plan.newBase}.md\uFF08\u8BF7\u5148\u5904\u7406\u540C\u540D\u6587\u4EF6\uFF09`);
        await atomicWrite(targetPath, `${selfText}
`);
        await fsp4.rm(card.path, { force: true });
        finalRel = targetPath.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, "/");
      }
    }
    this.sig = null;
    return `${formatRenameReport({ id: card.id, oldTitle, newTitle: title, plan, filesChanged: changed, broken, dryRun: false })}
\u5DF2\u5199\u5165\uFF1A${finalRel}`;
  }
  async fileExists(path) {
    try {
      await fsp4.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async progress(action, fields) {
    const file = this.stateFile();
    if (action === "clear") {
      await writeProgress(file, {});
      return "\u5B66\u4E60\u8FDB\u5EA6\u5DF2\u6E05\u7A7A\u3002";
    }
    const current = await readProgress(file);
    if (action === "get") return fmtProgress(current);
    if (action !== "set") throw new Error(`study_progress \u672A\u77E5 action "${action}"\uFF08\u53EF\u7528 get/set/clear\uFF09`);
    const next = { ...current };
    if (fields.material !== void 0) next.currentMaterial = String(fields.material).trim();
    if (fields.section !== void 0) next.currentSection = String(fields.section).trim();
    if (fields.pendingQuestions !== void 0) next.pendingQuestions = fields.pendingQuestions;
    if (fields.touchedCardIds !== void 0) next.touchedCardIds = fields.touchedCardIds;
    if (fields.material === void 0 && fields.section === void 0 && fields.pendingQuestions === void 0 && fields.touchedCardIds === void 0) {
      return fmtProgress(current);
    }
    await writeProgress(file, next);
    return fmtProgress(next);
  }
  async memory(action, fields) {
    const file = this.memoryFile();
    if (action === "clear") {
      await writeMemory(file, { notes: {} });
      return "\u8BB0\u5FC6\u5DF2\u6E05\u7A7A\u3002";
    }
    const current = await readMemory(file);
    if (action === "get") {
      if (fields.key !== void 0) {
        const key2 = String(fields.key).trim();
        if (key2 === AUTO_PREFS_KEY) return formatAutoPrefs(current.notes[AUTO_PREFS_KEY]);
        const normalized = normalizeMemoryKey(key2);
        const value2 = current.notes[normalized];
        return value2 !== void 0 ? `${normalized}\uFF1A${value2}` : `\uFF08\u65E0\u6B64\u952E\uFF1A${normalized}\uFF09`;
      }
      const text = formatMemory(current);
      const stale = findProgressSentences(current.notes);
      if (stale.length === 0) return text;
      const lines = stale.map((h) => `- ${h.key}\uFF1A\u300C${h.snippet}\u2026\u300D`);
      return `${text}

\u26A0 \u63D0\u793A\uFF1A\u4E0A\u8FF0\u8BB0\u5FC6\u952E\u542B\u8FDB\u5EA6\u53E5\uFF0C\u53EF\u80FD\u4E0E study_progress \u4E0D\u4E00\u81F4\u2014\u2014\u8FDB\u5EA6\u4F4D\u7F6E\u4EE5 study_progress \u4E3A\u51C6\u3002\u5EFA\u8BAE\u628A\u8FDB\u5EA6\u53E5\u8FC1\u79FB\u6216\u6807\u6CE8\u4E3A\u300C\u5386\u53F2\u5FEB\u7167\u300D\uFF0C\u504F\u597D\u952E\u53EA\u5B58\u504F\u597D/\u60EF\u4F8B\uFF1A
${lines.join("\n")}`;
    }
    if (action !== "set" && action !== "append" && action !== "remove") {
      throw new Error(`study_memory \u672A\u77E5 action "${action}"\uFF08\u53EF\u7528 get/set/append/remove/clear\uFF09`);
    }
    if (String(fields.key ?? "").trim() === AUTO_PREFS_KEY) {
      if (action === "append") throw new Error("\u81EA\u8FED\u4EE3\u5F00\u5173\u4E0D\u652F\u6301 append\uFF1B\u7528 set \u5207\u6362 on/off\uFF0C\u6216\u7528 remove \u5220\u9664\uFF08\u56DE\u5230\u9ED8\u8BA4\u5173\u95ED\uFF09");
      if (action === "remove") {
        if (!Object.prototype.hasOwnProperty.call(current.notes, AUTO_PREFS_KEY)) {
          return "\uFF08\u65E0\u6B64\u952E\uFF1A_autoPrefs\uFF0C\u65E0\u9700\u5220\u9664\uFF1B\u5F53\u524D\u4E3A\u9ED8\u8BA4\u5173\u95ED\uFF09";
        }
        const next3 = { notes: { ...current.notes } };
        delete next3.notes[AUTO_PREFS_KEY];
        await writeMemory(file, next3);
        return "\u5DF2\u5173\u95ED\u81EA\u8FED\u4EE3\u8BB0\u5FC6\uFF08\u5F00\u5173\u952E\u5DF2\u5220\u9664\uFF0C\u56DE\u5230\u9ED8\u8BA4\u5173\u95ED\uFF09\u3002";
      }
      const value2 = normalizeAutoPrefsValue(fields.value ?? "");
      const next2 = { notes: { ...current.notes, [AUTO_PREFS_KEY]: value2 } };
      await writeMemory(file, next2);
      return value2 === "on" ? '\u5DF2\u5F00\u542F\u81EA\u8FED\u4EE3\u8BB0\u5FC6\uFF1A\u65E0\u9700\u518D\u8BF4"\u8BF7\u8BB0\u4F4F"\uFF0C\u504F\u597D/\u7EA6\u5B9A\u4F1A\u81EA\u52A8\u5199\u5165 prefs.* \u952E\uFF08\u6BCF\u6B21\u5199\u5165\u4F1A\u5728\u56DE\u590D\u4E2D\u6807\u6CE8\uFF09\u3002' : '\u5DF2\u5173\u95ED\u81EA\u8FED\u4EE3\u8BB0\u5FC6\uFF1A\u56DE\u5230"\u8BB0\u4F4F\u2026"\u624B\u52A8\u6A21\u5F0F\u3002';
    }
    const key = normalizeMemoryKey(fields.key ?? "");
    const next = { notes: { ...current.notes } };
    if (action === "remove") {
      if (!Object.prototype.hasOwnProperty.call(next.notes, key)) {
        return `\uFF08\u65E0\u6B64\u952E\uFF1A${key}\uFF0C\u65E0\u9700\u5220\u9664\uFF09`;
      }
      delete next.notes[key];
      await writeMemory(file, next);
      return `\u5DF2\u5220\u9664\u8BB0\u5FC6\uFF1A${key}`;
    }
    const value = checkMemoryValue(fields.value ?? "");
    if (action === "append" && next.notes[key] !== void 0) {
      next.notes[key] = checkMemoryValue(`${next.notes[key]}
${value}`);
    } else {
      next.notes[key] = value;
    }
    await writeMemory(file, next);
    return `\u5DF2\u8BB0\u5FC6 ${key}\uFF1A${next.notes[key]}

${formatMemory(next)}`;
  }
};
function fmtProgress(state) {
  const pos = [state.currentMaterial || "\uFF08\u672A\u5F00\u59CB\uFF09", state.currentSection || ""].filter(Boolean).join(" / ");
  const q = state.pendingQuestions?.length ? state.pendingQuestions.join("\uFF1B") : "\u65E0";
  const c = state.touchedCardIds?.length ? state.touchedCardIds.join("\u3001") : "\u65E0";
  return `\u4F4D\u7F6E\uFF1A${pos}
\u8FFD\u95EE\uFF1A${q}
\u5361\u7247\uFF1A${c}`;
}
function apply(ctx, config) {
  let store;
  try {
    store = new VaultStore(normalizeConfig(config));
  } catch (error) {
    console.error(`[dsh-study-buddy] ${error.message}`);
    throw error;
  }
  const tools = ctx?.tools;
  if (typeof tools?.register !== "function") {
    console.error("[dsh-study-buddy] tools \u6CE8\u518C\u8868\u4E0D\u53EF\u7528\uFF0C\u63D2\u4EF6\u672A\u6302\u8F7D\u5DE5\u5177");
    throw new Error("dsh-study-buddy: ctx.tools.register \u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u6CE8\u518C\u5361\u7247\u5DE5\u5177");
  }
  const disposers = [];
  try {
    for (const def of buildToolDefs(store)) {
      disposers.push(tools.register(def));
    }
  } catch (error) {
    for (const dispose of disposers) dispose();
    console.error(`[dsh-study-buddy] \u5DE5\u5177\u6CE8\u518C\u5931\u8D25\uFF1A${error.message}`);
    throw error;
  }
  const systemPrompt = typeof ctx?.get === "function" ? ctx.get?.("systemPrompt") : void 0;
  if (typeof systemPrompt?.section === "function") {
    const disposeSection = systemPrompt.section({
      name: OPENER_SECTION_NAME,
      order: OPENER_SECTION_ORDER,
      text: MANDATE
    });
    if (typeof disposeSection === "function") disposers.push(disposeSection);
  }
  const on = ctx?.on;
  if (typeof on === "function") {
    const disposeListener = on(
      "agent/pre-step",
      async (payload, next) => {
        const downstream = await next();
        const p = payload;
        const turn = Number(p?.turn);
        const step = Number(p?.step);
        if (!shouldInjectOpener(turn, step, hasPriorUserMessage(p))) return downstream;
        const decision = downstream;
        if (decision?.kind !== "enter" || !Array.isArray(decision.messages)) return downstream;
        return applyOpenerDecision(decision, buildOpenerReminder());
      }
    );
    disposers.push(disposeListener);
  }
  ctx?.effect?.(() => () => {
    for (const dispose of disposers) dispose();
  }, "dsh-study-buddy tools");
}
export {
  VaultStore,
  apply,
  buildToolDefs,
  inject,
  name
};
//# sourceMappingURL=index.js.map
