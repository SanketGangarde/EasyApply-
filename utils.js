/* Pure helper functions (no DOM, no chrome APIs). Loaded before sidepanel.js. */

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* ---------- LaTeX edit parsing and applying ---------- */
function trimNl(s) {
  return s.replace(/^\s*```[a-z]*\s*$/gm, "").replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "");
}

// Model output uses a plain-text format (not JSON) because LaTeX is full of backslashes.
function parseEdits(text) {
  const out = [];
  const chunks = String(text || "").split("===EDIT===").slice(1);
  for (const ch of chunks) {
    const end = ch.indexOf("===END===");
    const body = end >= 0 ? ch.slice(0, end) : ch;
    const fi = body.indexOf("---FIND---");
    const ri = body.indexOf("---REPLACE---");
    if (fi < 0 || ri < 0 || ri < fi) continue;
    const head = body.slice(0, fi);
    const section = (/SECTION:\s*(.*)/.exec(head) || [])[1] || "Resume";
    const reason = (/REASON:\s*(.*)/.exec(head) || [])[1] || "";
    const find = trimNl(body.slice(fi + 10, ri));
    const replace = trimNl(body.slice(ri + 13));
    if (!find.trim()) continue;
    out.push({ section: section.trim(), reason: reason.trim(), find, replace });
  }
  return out.slice(0, 12);
}

// Finds where an edit's FIND text sits in the original LaTeX. Must match exactly once.
function locate(latex, e) {
  const idxs = [];
  let from = 0;
  while (true) {
    const i = latex.indexOf(e.find, from);
    if (i < 0) break;
    idxs.push(i);
    from = i + Math.max(1, e.find.length);
  }
  if (idxs.length === 1) { e.start = idxs[0]; e.end = idxs[0] + e.find.length; e.status = "ok"; return e; }
  if (idxs.length > 1) { e.status = "ambiguous"; return e; }
  const pat = e.find.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  const ms = [...latex.matchAll(new RegExp(pat, "g"))];
  if (ms.length === 1) { e.start = ms[0].index; e.end = e.start + ms[0][0].length; e.status = "ok"; }
  else e.status = ms.length ? "ambiguous" : "notfound";
  return e;
}

// If the model adds an unescaped & % # _ that the original text did not have, escape it.
function fixEscapes(find, replace) {
  let out = replace;
  for (const ch of ["&", "%", "#", "_"]) {
    const un = new RegExp("(?<!\\\\)" + ch);
    if (!un.test(find) && un.test(out)) out = out.replace(new RegExp("(?<!\\\\)" + ch, "g"), (m) => "\\" + m);
  }
  return out;
}

function applyEdits(latex, chosen) {
  const sorted = chosen.filter((e) => e.status === "ok").sort((a, b) => a.start - b.start);
  let res = "", pos = 0, applied = 0, skipped = 0;
  for (const e of sorted) {
    if (e.start < pos) { skipped++; continue; }
    res += latex.slice(pos, e.start) + fixEscapes(e.find, e.replace);
    pos = e.end;
    applied++;
  }
  res += latex.slice(pos);
  return { text: res, applied, skipped };
}

function latexStats(s) {
  const t = s.split("\n").map((l) => l.replace(/(?<!\\)%.*$/, "")).join("\n");
  const c = (re) => (t.match(re) || []).length;
  return { bal: c(/(?<!\\)\{/g) - c(/(?<!\\)\}/g), env: c(/\\begin\{/g) - c(/\\end\{/g) };
}
function checkLatex(original, result) {
  const a = latexStats(original), b = latexStats(result), w = [];
  if (a.bal !== b.bal) w.push("Curly brackets { } are no longer balanced. Check the edited lines before compiling.");
  if (a.env !== b.env) w.push("\\begin and \\end no longer match. Check the edited lines before compiling.");
  return w;
}

function prepLatexBody(latex, maxChars) {
  let s = latex;
  const a = s.indexOf("\\begin{document}");
  if (a >= 0) s = s.slice(a);
  s = s.split("\n").filter((l) => !/^\s*%/.test(l) && l.trim() !== "").join("\n");
  let truncated = false;
  if (s.length > maxChars) { s = s.slice(0, maxChars); truncated = true; }
  return { text: s, truncated };
}

// Rough plain-text version of a LaTeX resume, used only when no plain resume was saved.
function latexToText(latex) {
  let s = latex;
  const a = s.indexOf("\\begin{document}");
  if (a >= 0) s = s.slice(a + 16);
  s = s.split("\n").map((l) => l.replace(/(?<!\\)%.*$/, "")).join("\n");
  return s
    .replace(/\\(?:begin|end)\{[^}]*\}(\[[^\]]*\])?/g, " ")
    .replace(/\\href\{[^}]*\}/g, "")
    .replace(/\\\\/g, "\n")
    .replace(/\\item\b/g, "\n- ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\\([&%$#_])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/* ---------- company risk helpers ---------- */
const FLAG_RULES = [
  { weight: 2, label: "Asks for money (fee or deposit)",
    re: /(registration|training|security|processing|joining|application|refundable|kit|laptop)\s+(fee|fees|deposit|charges?|amount)|(pay|deposit|transfer)\s+(a\s+|an\s+)?(small\s+)?(fee|deposit|amount)|deposit\s+(of\s+)?(rs\.?|₹|inr|\$)/i },
  { weight: 1, label: "Contact through WhatsApp or Telegram",
    re: /(contact|message|reach|apply|send|resume|cv|hr|call)[^.\n]{0,40}(whatsapp|telegram)|(whatsapp|telegram)[^.\n]{0,30}(only|number|no\.?|\+?\d{5,})/i },
  { weight: 1, label: "Recruiter uses a free email address",
    re: /[\w.+-]+@(gmail|yahoo|hotmail|outlook|rediffmail)\.com/i },
  { weight: 2, label: "Promises a job without a proper interview",
    re: /no\s+interview|without\s+(any\s+|an\s+)?interview|selection\s+without\s+interview/i },
  { weight: 2, label: "Unrealistic or guaranteed income",
    re: /(earn|income)\s+(up\s+to\s+)?(rs\.?|₹|inr|\$)?\s*[\d,]+\s*(\/|per\s+)(day|daily|week|hour)|guaranteed\s+(job|income|placement|salary)/i },
];
function localRedFlags(text) {
  const flags = [];
  let score = 0;
  for (const r of FLAG_RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const a = Math.max(0, m.index - 50), b = Math.min(text.length, m.index + m[0].length + 60);
    flags.push({ flag: r.label, evidence: text.slice(a, b).replace(/\s+/g, " ").trim() });
    score += r.weight;
  }
  return { flags, score };
}
const RISK_RANK = { unknown: 0, low: 1, medium: 2, high: 3 };
function finalRisk(modelLevel, localScore) {
  const lvl = RISK_RANK[modelLevel] !== undefined ? modelLevel : "unknown";
  const floor = localScore >= 4 ? "high" : localScore >= 2 ? "medium" : null;
  return floor && RISK_RANK[floor] > RISK_RANK[lvl] ? floor : lvl;
}
function normUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return null;
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return null; }
}

if (typeof module !== "undefined") {
  module.exports = { parseEdits, locate, fixEscapes, applyEdits, checkLatex, prepLatexBody,
    latexToText, localRedFlags, finalRisk, normUrl };
}
