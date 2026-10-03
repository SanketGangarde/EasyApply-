const $ = (id) => document.getElementById(id);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_RESUME_CHARS = 6000;   // keeps requests inside Groq free-tier token limits
const MAX_PAGE_CHARS = 10000;
const MAX_CHAT_JD_CHARS = 5000;

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";


const CHAT_SYSTEM = `You are a friendly career coach helping a candidate tailor their resume to one job posting. Use only the resume and job text given below.
FORMAT (very important): write plain text only. Do not use markdown: no asterisks, no # headings, no tables, no horizontal rules. Use short paragraphs. For lists, put each item on its own line starting with "- ". Put a short section name on its own line ending with a colon.
CONTENT RULES:
- When asked what to change, group the answer by resume section (Summary, Skills, Experience, Projects, Education). For each, say exactly what to change and why it matches the job.
- Only suggest changes based on what the resume already shows. If the job wants a skill that is not in the resume, say "Add this only if you really have it". Never invent tools, projects, metrics or experience.
- Do not make up score calculations or point tables.
- Keep answers under 250 words unless asked for more.`;

let chatHistory = [];
let chatContext = "";

/* ---------- small helpers ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function setStatus(msg, isError = false) {
  const s = $("status");
  s.textContent = msg;
  s.className = "status" + (isError ? " error" : "");
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));


/* ---------- clean text rendering (no raw markdown shown) ---------- */
function plain(t) {
  return String(t == null ? "" : t).replace(/\*\*/g, "").replace(/`/g, "").replace(/^#+\s*/, "");
}
function addInline(parent, text) {
  text.split(/(\*\*[^*]+\*\*)/g).forEach((p) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) parent.appendChild(el("strong", "", p.slice(2, -2)));
    else if (p) parent.appendChild(document.createTextNode(p.replace(/\*+/g, "").replace(/`/g, "")));
  });
}
function renderRich(container, raw) {
  container.replaceChildren();
  let list = null;
  raw.split("\n").forEach((line) => {
    let t = line.trim();
    if (!t || /^[-|:\s]+$/.test(t)) { list = null; return; }      // blanks, rules, table separators
    if (t.startsWith("|")) {                                          // table row -> one line
      t = t.split("|").map((c) => c.trim()).filter(Boolean).join(" - ");
    }
    const heading = /^#{1,6}\s+/.test(t);
    if (heading) t = t.replace(/^#{1,6}\s+/, "");
    const bullet = /^([-*\u2022]|\d+[.)])\s+/.test(t);
    if (bullet) {
      t = t.replace(/^([-*\u2022]|\d+[.)])\s+/, "");
      if (!list) { list = el("ul"); container.appendChild(list); }
      const li = el("li"); addInline(li, t); list.appendChild(li);
      return;
    }
    list = null;
    const p = el("p", heading || (t.endsWith(":") && t.length < 70) ? "sec" : "");
    addInline(p, t);
    container.appendChild(p);
  });
}

/* ---------- settings & resume ---------- */
async function loadState() {
  const { apiKey, model, resume, resumeName } = await chrome.storage.local.get(
    ["apiKey", "model", "resume", "resumeName"]
  );
  if (apiKey) $("apiKey").value = apiKey;
  if (model) $("model").value = model;
  if (!apiKey) $("settings").open = true;
  showResumeStatus(resume, resumeName);
}
function showResumeStatus(resume, name) {
  $("resumeStatus").textContent = resume
    ? `Saved: ${name || "resume"} (${resume.length} characters)`
    : "No resume saved yet.";
}
$("saveSettings").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || "openai/gpt-oss-120b",
  });
  $("settingsMsg").textContent = "Saved.";
  setTimeout(() => ($("settingsMsg").textContent = ""), 2000);
});

async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  return out;
}
$("resumeFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = file.name.toLowerCase().endsWith(".pdf")
      ? await extractPdfText(file)
      : await file.text();
    const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length < 50) throw new Error("Could not read text from this file. If it is a scanned PDF, paste the text instead.");
    await chrome.storage.local.set({ resume: clean, resumeName: file.name });
    showResumeStatus(clean, file.name);
  } catch (err) {
    $("resumeStatus").textContent = "Could not read file: " + err.message;
  }
});
$("saveResumeText").addEventListener("click", async () => {
  const t = $("resumeText").value.trim();
  if (t.length < 50) return;
  await chrome.storage.local.set({ resume: t, resumeName: "pasted text" });
  showResumeStatus(t, "pasted text");
});

/* ---------- read the current page ---------- */
async function readActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
    throw new Error("Open a normal job page in the active tab first.");
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const sel = String(window.getSelection() || "").trim();
      return {
        title: document.title,
        url: location.href,
        selection: sel,
        text: document.body ? document.body.innerText : "",
      };
    },
  });
  const r = res.result;
  const useSel = r.selection.length > 300;
  const text = (useSel ? r.selection : r.text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title: r.title, url: r.url, text: text.slice(0, MAX_PAGE_CHARS), usedSelection: useSel };
}

/* ---------- Groq ---------- */
async function callGroq(messages, { json = false } = {}) {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("Add your Groq API key in Settings first.");
  const m = model || "openai/gpt-oss-120b";
  const body = { model: m, messages, temperature: 0.3, max_tokens: 2000 };
  if (json) body.response_format = { type: "json_object" };
  if (m.includes("gpt-oss")) body.reasoning_effort = "low";

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error?.message || ""; } catch {}
    if (resp.status === 401) throw new Error("Invalid API key. Check it in Settings.");
    if (resp.status === 429) throw new Error("Groq rate limit reached. Wait a minute and try again. " + detail);
    throw new Error(`Groq error ${resp.status}. ${detail}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

const ANALYSIS_SYSTEM = `You are an expert recruiter and ATS reviewer. You compare a candidate's resume with the text of a web page that contains a job posting. The page text may include navigation or unrelated listings: find the main job description and ignore the rest.
Rules:
- Never invent facts. For company details, use only what the page says; otherwise write "Not mentioned".
- Do not predict the chance of being hired. Give a fit score based only on how well the resume matches the stated requirements.
- Resume edits must be specific, truthful and based on what the resume already contains. Never suggest adding skills or experience the candidate does not have; suggest rewording, reordering or emphasising instead.
Return ONLY valid JSON in exactly this shape:
{
 "job_title": string,
 "company": string,
 "fit_score": integer 0-100,
 "verdict": string (one or two sentences),
 "breakdown": {"skills": int, "experience": int, "education": int, "keywords": int},
 "matched_skills": [string],
 "missing_skills": [string],
 "resume_edits": [{"section": string, "issue": string, "suggestion": string}],
 "company_info": {"summary": string, "industry": string, "size_or_stage": string, "location": string},
 "red_flags": [string]
}
Give 3 to 6 resume_edits. Use empty arrays when there is nothing to list.`;

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("The model returned an unreadable answer. Try again.");
  }
}

/* ---------- render ---------- */
function section(title) {
  const box = el("div", "box");
  box.appendChild(el("h2", "", title));
  return box;
}
function chips(list, cls) {
  const wrap = el("div", "chips");
  (list || []).forEach((t) => wrap.appendChild(el("span", "chip " + cls, plain(t))));
  if (!list || !list.length) wrap.appendChild(el("span", "hint", "None"));
  return wrap;
}
function render(a) {
  const root = $("results");
  root.replaceChildren();

  const top = el("div", "box");
  const row = el("div", "score");
  const num = el("div", "score-num", String(clamp(a.fit_score)));
  num.appendChild(el("small", "", "/100"));
  const info = el("div");
  info.appendChild(el("div", "job-title", plain(`${a.job_title || "Job"} at ${a.company || "company"}`)));
  info.appendChild(el("p", "verdict", plain(a.verdict)));
  row.append(num, info);
  top.appendChild(row);
  const bd = a.breakdown || {};
  [["Skills", bd.skills], ["Experience", bd.experience], ["Education", bd.education], ["Keywords", bd.keywords]]
    .forEach(([label, v]) => {
      const r = el("div", "bar-row");
      const bar = el("div", "bar");
      const fill = el("span");
      fill.style.width = clamp(v) + "%";
      bar.appendChild(fill);
      r.append(el("span", "", label), bar, el("span", "", clamp(v) + "%"));
      top.appendChild(r);
    });
  top.appendChild(el("p", "note", "Fit score shows how closely your resume matches the posting. It is not a prediction of being hired."));
  root.appendChild(top);

  const skills = section("Skills");
  skills.appendChild(el("h3", "", "You have"));
  skills.appendChild(chips(a.matched_skills, "good"));
  skills.appendChild(el("h3", "", "Missing or not shown"));
  skills.appendChild(chips(a.missing_skills, "gap"));
  root.appendChild(skills);

  const edits = section("Suggested resume changes");
  (a.resume_edits || []).forEach((e) => {
    const d = el("div", "edit");
    d.appendChild(el("div", "where", plain(e.section) || "Resume"));
    if (e.issue) d.appendChild(el("div", "why", plain(e.issue)));
    d.appendChild(el("div", "", plain(e.suggestion)));
    edits.appendChild(d);
  });
  root.appendChild(edits);

  const c = a.company_info || {};
  const comp = section("Company");
  if (c.summary) comp.appendChild(el("p", "", plain(c.summary)));
  const ul = el("ul");
  [["Industry", c.industry], ["Size or stage", c.size_or_stage], ["Location", c.location]]
    .forEach(([k, v]) => ul.appendChild(el("li", "", `${k}: ${plain(v) || "Not mentioned"}`)));
  comp.appendChild(ul);
  root.appendChild(comp);

  if (a.red_flags && a.red_flags.length) {
    const rf = section("Things to check");
    const l = el("ul");
    a.red_flags.forEach((t) => l.appendChild(el("li", "", plain(t))));
    rf.appendChild(l);
    root.appendChild(rf);
  }
  root.hidden = false;
}

/* ---------- analyze ---------- */
$("analyze").addEventListener("click", async () => {
  const btn = $("analyze");
  btn.disabled = true;
  $("results").hidden = true;
  $("chatBox").hidden = true;
  try {
    const { resume } = await chrome.storage.local.get("resume");
    if (!resume) throw new Error("Upload or paste your resume first.");
    setStatus("Reading the page...");
    const page = await readActivePage();
    if (page.text.length < 200) throw new Error("This page has too little text. Open a job posting and try again.");

    setStatus("Analyzing with Groq...");
    const content = await callGroq([
      { role: "system", content: ANALYSIS_SYSTEM },
      { role: "user", content: `RESUME:\n${resume.slice(0, MAX_RESUME_CHARS)}\n\nPAGE URL: ${page.url}\nPAGE TITLE: ${page.title}\nPAGE TEXT:\n${page.text}` },
    ], { json: true });

    const analysis = parseJson(content);
    render(analysis);
    setStatus(page.usedSelection ? "Done. Used your selected text." : "Done.");

    chatContext = `RESUME:\n${resume.slice(0, MAX_RESUME_CHARS)}\n\nJOB PAGE TEXT:\n${page.text.slice(0, MAX_CHAT_JD_CHARS)}\n\nEARLIER ANALYSIS:\n${JSON.stringify(analysis).slice(0, 2500)}`;
    chatHistory = [];
    $("chatLog").replaceChildren();
    $("chatBox").hidden = false;
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- follow-up chat ---------- */
async function sendChat() {
  const input = $("chatInput");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  $("chatLog").appendChild(el("div", "msg user", q));
  const pending = el("div", "msg bot", "Thinking...");
  $("chatLog").appendChild(pending);
  $("chatSend").disabled = true;
  try {
    chatHistory.push({ role: "user", content: q });
    const answer = await callGroq([
      { role: "system", content: CHAT_SYSTEM + "\n\n" + chatContext },
      ...chatHistory.slice(-6),
    ]);
    chatHistory.push({ role: "assistant", content: answer });
    renderRich(pending, answer);
  } catch (err) {
    pending.textContent = err.message;
    chatHistory.pop();
  } finally {
    $("chatSend").disabled = false;
    pending.scrollIntoView({ block: "nearest" });
  }
}
$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

loadState();
