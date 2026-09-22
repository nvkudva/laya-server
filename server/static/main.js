const $ = (s, r = document) => r.querySelector(s);
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---- markup --------------------------------------------------------------
// Components are functions from state to an HTML string. `html` returns a `Raw`, so a component
// can be interpolated into another without being escaped twice; everything else is escaped, which
// is what keeps user text — the state, instructions, question names — from becoming markup.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
class Raw { constructor(s) { this.s = s; } }

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

function slot(v) {
  if (v == null || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(slot).join("");
  return esc(v);
}

const html = (strings, ...values) =>
  new Raw(strings.reduce((out, s, i) => out + s + (i < values.length ? slot(values[i]) : ""), ""));

/** Markup → one detached element, for the places that append rather than replace. */
function node(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.s;
  return t.content.firstElementChild;
}

/** Replace a container's markup, then put the caret back where it was. Adding or removing a row
    rebuilds the list, and without this the field being edited loses focus and selection. */
function mount(host, markup) {
  const a = document.activeElement;
  const key = a?.dataset?.key;
  const caret = a?.selectionStart ?? null;
  host.innerHTML = markup.s;
  if (!key) return;
  const next = host.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus();
  if (caret != null && next.setSelectionRange) next.setSelectionRange(caret, caret);
}

// ---- theme ---------------------------------------------------------------

let theme = store.get("laya.theme", "system");
function applyTheme() {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("#theme").textContent = theme;
}
$("#theme").onclick = () => {
  theme = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  store.set("laya.theme", theme);
  applyTheme();
};
applyTheme();

// ---- question set editor -------------------------------------------------

const DEFAULT_SET = [
  { name: "intent", type: "choice", instructions: "What does the customer want?",
    criteria: [["refund", "money returned or a duplicate charge reversed"],
               ["technical_help", "a bug, outage or integration problem"],
               ["other", "none of the other options fits"]] },
  { name: "urgency", type: "score", instructions: "How urgent is this message?",
    criteria: ["Can wait", "Needs attention this week", "Needs attention today"] },
  { name: "is_frustrated", type: "noul", instructions: "Does the customer sound frustrated?", criteria: [] },
];

let questions = store.get("laya.questions", DEFAULT_SET);
const save = () => store.set("laya.questions", questions);

const MODEL = "laya";
const stateBox = $("#state");
stateBox.value = store.get("laya.state", "");

const qJsonHost = $("#q-json");
const requestError = $("#request-error");

/** The wire request the sidebar holds, in the order the server documents it. */
function requestBody({ strict = true } = {}) {
  return { state: stateBox.value, model: MODEL, questions: buildQuestions({ strict }) };
}

function failRequest(message) {
  requestError.textContent = message;
  requestError.hidden = false;
  return false;
}

/* CodeMirror mounts into qJsonHost from the module at the foot of this file. Until it has
   loaded — or if the CDN is unreachable — `text` is the pane's only store. */
const jsonPane = {
  editor: null,
  text: "",
  read() { return this.editor ? this.editor.state.doc.toString() : this.text; },
  write(text) {
    this.text = text;
    if (!this.editor) return;
    const current = this.editor.state.doc.toString();
    if (current !== text) this.editor.dispatch({ changes: { from: 0, to: current.length, insert: text } });
    this.editor.requestMeasure();
  },
  clearError() { requestError.hidden = true; },
  fail(error) { failRequest(`JSON editor unavailable: ${error.message}`); },
};

function blankFor(type) {
  return {
    name: "", type, instructions: "",
    criteria: type === "choice" ? [["", ""]] : type === "score" ? ["", "", ""] : [],
  };
}

/** One question card. Every input carries a `data-field` path into `questions`, which is how the
    delegated handler below writes back without a closure per node. */
function questionMarkup(q, i) {
  // Raw: these are attributes spliced mid-tag, so they must not be escaped as text.
  const field = (path) => html`data-field="${i}.${path}" data-key="${i}.${path}"`;
  const remove = (act, j) => html`
    <button class="ghost x" type="button" data-act="${act}" data-i="${i}" data-j="${j}"
            data-key="${act}-${i}-${j}">✕</button>`;

  const parts = [html`
    <div class="row">
      <input name="name" placeholder="question_name" value="${q.name}" ${field("name")}>
      <span class="meta">${q.type}</span>
      ${remove("del-question", 0)}
    </div>
    <textarea placeholder="instructions" ${field("instructions")}>${q.instructions}</textarea>`];

  if (q.type === "choice") {
    parts.push(html`<label>criteria — label : description</label>`);
    q.criteria.forEach((pair, j) => parts.push(html`
      <div class="crit">
        <input class="label" placeholder="label" value="${pair[0]}" ${field(`criteria.${j}.0`)}>
        <input placeholder="description (optional)" value="${pair[1] ?? ""}" ${field(`criteria.${j}.1`)}>
        ${remove("del-option", j)}
      </div>`));
    parts.push(html`<button class="ghost" type="button" data-act="add-option" data-i="${i}" data-key="add-option-${i}">+ option</button>`);
  } else if (q.type === "score") {
    parts.push(html`<label>criteria — lowest rung first</label>`);
    q.criteria.forEach((rung, j) => parts.push(html`
      <div class="crit">
        <input placeholder="rung ${j}" value="${rung}" ${field(`criteria.${j}`)}>
        ${remove("del-rung", j)}
      </div>`));
    parts.push(html`<button class="ghost" type="button" data-act="add-rung" data-i="${i}" data-key="add-rung-${i}">+ rung</button>`);
  } else {
    parts.push(html`<label>criteria (optional)</label>`);
    ["true", "false"].forEach((label, j) => parts.push(html`
      <div class="crit">
        <input class="label" value="${label}" disabled>
        <input placeholder="what makes it ${label}" value="${q.criteria[j] ?? ""}" ${field(`criteria.${j}`)}>
      </div>`));
  }

  return html`<div class="q">${parts}</div>`;
}

/** Editor rows → the Jev `questions` object. Throws on user error; with `strict: false` it
 *  emits whatever is on screen, so the JSON view can always render the current rows. */
function buildQuestions({ strict = true } = {}) {
  const out = {};
  for (const [i, q] of questions.entries()) {
    const name = q.name.trim();
    const touched = q.instructions.trim() || q.criteria.flat().some((c) => (c ?? "").trim());
    if (!name && !touched) continue;
    if (!name && strict) throw new Error(`Question ${i + 1} (${q.type}) needs a name.`);
    if (name in out) {
      if (strict) throw new Error(`Duplicate question name '${name}'.`);
      continue;
    }
    const body = { type: q.type };
    if (q.instructions.trim()) body.instructions = q.instructions.trim();
    if (q.type === "choice") {
      const criteria = {};
      for (const [label, desc] of q.criteria) {
        const l = label.trim();
        if (!l) continue;
        criteria[l] = desc.trim() || null;
      }
      if (Object.keys(criteria).length < 2 && strict) throw new Error(`'${name}' needs at least two labelled options.`);
      body.criteria = criteria;
    } else if (q.type === "score") {
      const rungs = q.criteria.map((r) => r.trim()).filter(Boolean);
      if (!rungs.length && strict) throw new Error(`'${name}' needs at least one rung.`);
      body.criteria = rungs;
    } else {
      const [t, f] = q.criteria.map((c) => (c ?? "").trim());
      if (t || f) body.criteria = { true: t || null, false: f || null };
    }
    out[name] = body;
  }
  if (!Object.keys(out).length && strict) throw new Error("Add at least one question.");
  return out;
}

/** Answer to a `data-field` path — "0.criteria.1.0" — written back into `questions`. */
function setField(path, value) {
  const parts = path.split(".");
  const leaf = parts.pop();
  let at = questions;
  for (const p of parts) at = at[p];
  at[leaf] = value;
  save();
}

/** Load a named example: its sample state into the textarea, its questions into the editor. */
function adoptExample(example) {
  stateBox.value = example.state;
  store.set("laya.state", example.state);
  syncSend();
  // adoptPreset re-renders, which refreshes the JSON pane from the new state when it is showing.
  adoptPreset(example.questions);
}

/** Server preset (already Jev-shaped) → editor rows. */
function adoptPreset(set) {
  questions = Object.entries(set).map(([name, q]) => ({
    name, type: q.type, instructions: q.instructions ?? "",
    criteria: q.type === "choice" ? Object.entries(q.criteria).map(([l, d]) => [l, d ?? ""])
      : q.type === "score" ? q.criteria.slice()
      : [q.criteria?.true ?? "", q.criteria?.false ?? ""],
  }));
  store.set("laya.questions", questions);
  paintEditor();
}

let qView = store.get("laya.qview", "ui");

/** JSON view text → the sidebar's fields. Shows the error and returns false when it isn't a request. */
function applyJsonView() {
  try {
    const body = JSON.parse(jsonPane.read());
    if (typeof body.state !== "string") {
      throw new Error("state must be a string to edit in UI mode — switch back to JSON to use an object or array.");
    }
    if (!body.questions || typeof body.questions !== "object") {
      throw new Error("the request needs a `questions` object.");
    }
    stateBox.value = body.state;
    store.set("laya.state", body.state);
    syncSend();
    adoptPreset(body.questions);
    return true;
  } catch (e) {
    requestError.textContent = `Not a valid request: ${e.message}`;
    requestError.hidden = false;
    return false;
  }
}

/** Send what the sidebar holds — the JSON pane first, if that is what is on screen. */
function sendRequest() {
  if (qView === "json" && !applyJsonView()) return;
  let request;
  try {
    request = requestBody();
  } catch (e) {
    return failRequest(e.message);
  }
  if (!request.state.trim()) return failRequest("The request needs a state to judge.");
  requestError.hidden = true;
  ask(request);
}

/** The state is the one thing a request cannot go without, so Send stands down while it is blank. */
function syncSend() {
  $("#send").disabled = !stateBox.value.trim();
}

function setView(mode) {
  if (mode === qView) return;
  if (qView === "json" && !applyJsonView()) return;
  requestError.hidden = true;
  qView = mode;
  store.set("laya.qview", qView);
  paintEditor();
}

function paintEditor() {
  mount($("#questions"), html`${questions.map(questionMarkup)}`);
  $("#q-count").textContent = `${questions.length} question${questions.length === 1 ? "" : "s"}`;

  const asJson = qView === "json";
  $("#request-ui").hidden = asJson;
  qJsonHost.hidden = !asJson;
  if (asJson) jsonPane.write(JSON.stringify(requestBody({ strict: false }), null, 2));
  for (const b of document.querySelectorAll("#q-view button")) {
    b.classList.toggle("is-on", b.dataset.view === qView);
  }
}

for (const b of document.querySelectorAll("#q-view button")) b.onclick = () => setView(b.dataset.view);

// ---- rendering answers ---------------------------------------------------
// One question's answer is one distribution: a single fill on a neutral track,
// no legend, rank carried by ink weight. Same readout for all three types.

const pct = (p) => (p * 100 >= 9.95 ? (p * 100).toFixed(0) : (p * 100).toFixed(1));

function rowsFor(a) {
  if (a.type === "noul") {
    const p = a.noul ?? 0;
    return [{ label: "false", p: 1 - p }, { label: "true", p }];
  }
  const probs = Object.entries(a.probabilities ?? {});
  if (a.type === "score") {
    const legend = a.legend ?? {};
    return probs.map(([k, p]) => ({ label: `${k} ${legend[k] ?? ""}`.trim(), p }));
  }
  return probs.map(([label, p]) => ({ label, p }));
}

function summaryFor(a) {
  if (a.type === "noul") return (a.noul ?? 0) >= 0.5 ? "true" : "false";
  if (a.type === "score") return (a.score ?? 0).toFixed(2);
  return a.choice ?? "";
}

function answerMarkup(name, q, a) {
  const data = rowsFor(a);
  const winner = data.reduce((best, r, i) => (r.p > data[best].p ? i : best), 0);
  const act = a.action?.act_probability ?? a.rl_agent?.act_probability;
  const foot = a.type === "score" ? `expectation, ${data.length} levels`
    : a.type === "noul" ? "p(true)" : `${data.length} options`;

  return html`
    <section class="dist">
      <div class="dist-q">
        <span class="dist-instr">${q?.instructions || name}</span>
        <span class="dist-answer">${summaryFor(a)}</span>
      </div>
      <header class="dist-head">
        <h3>${name}</h3>
        <span class="dist-type">${a.type}</span>
      </header>
      <ol class="bars">
        ${data.map((r, i) => html`
        <li class="${i === winner ? "bar-row is-top" : "bar-row"}" title="${r.label} — ${r.p.toFixed(4)}">
          <span class="bar-label">${r.label}</span>
          <span class="bar-track">
            <span class="bar-fill" style="width: max(2px, ${(Number(r.p) * 100).toFixed(4)}%)"></span>
          </span>
          <span class="bar-value">${pct(r.p)}<span class="pct">%</span></span>
        </li>`)}
      </ol>
      <footer class="dist-foot">
        <span>${foot}</span>
        <span class="dist-meta">
          ${a.confidence != null ? html`<span>confidence ${a.confidence.toFixed(3)}</span>` : ""}
          ${act != null ? html`<span>act ${act.toFixed(3)}</span>` : ""}
        </span>
      </footer>
    </section>`;
}

function answersMarkup(sent, data) {
  return html`
    <div class="answers">
      ${Object.entries(data.answers ?? {}).map(([name, a]) => answerMarkup(name, sent[name], a))}
    </div>`;
}

function errorMarkup(detail) {
  const list = Array.isArray(detail) ? detail : [{ loc: [], msg: String(detail) }];
  return html`
    <div class="answers">
      <div class="notice">
        <h3>Request rejected</h3>
        ${list.map((d) => html`<div><code>${(d.loc ?? []).join(".")}</code> ${d.msg}</div>`)}
      </div>
    </div>`;
}

// ---- conversation --------------------------------------------------------

const log = $("#log");
/* Turns saved before the sidebar became a whole request carry `state`/`sent` instead of
   `request`; re-key them so an existing log still renders. */
let history = store.get("laya.history", []).map((turn) => turn.request ? turn : {
  request: { state: turn.state ?? "", model: MODEL, questions: turn.sent ?? {} },
  data: turn.data,
  error: turn.error,
});

/* Index of the one expanded turn, 0-based over `history`. -1 means all of them are minimized. */
let openIndex = -1;

/* Collapse and the UI/JSON switch stay imperative: they only add or lift classes and the `hidden`
   property, so they never rebuild a turn — and never disturb a selection in the log. */
function syncOpen() {
  document.querySelectorAll("#log .turn").forEach((el, i) => {
    const open = i === openIndex;
    el.classList.toggle("is-open", open);
    const caret = el.querySelector(".turn-caret");
    if (caret) caret.textContent = open ? "▾" : "▸";
  });
}

/* JSON is the wire pair — the request as sent and the reply as received — so the answers block,
   which is only a rendering of `response.answers`, stands down while it is up. */
function applyView(turnEl, view) {
  const json = view === "json";
  turnEl.querySelector(".state-text").hidden = json;
  for (const el of turnEl.querySelectorAll(".state-json, .state-sub, .state-resp")) el.hidden = !json;
  const answers = turnEl.querySelector(".answers");
  if (answers) answers.hidden = json;
  for (const b of turnEl.querySelectorAll(".turn-view button[data-view]")) {
    b.classList.toggle("is-on", b.dataset.view === view);
  }
}

function turnHeadMarkup(turn, index) {
  const tokens = turn.data?.usage?.input_tokens;
  const time = turn.at ? new Date(turn.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return html`
    <header class="turn-head" data-act="toggle-turn" data-i="${index}">
      <span class="turn-caret">▸</span>
      <span>Request #${index + 1}</span>
      ${time ? html`<span>· ${time}</span>` : ""}
      <span class="turn-meta">
        ${tokens >= 450 ? html`<span class="turn-warn" title="Content past the 512-token context limit is silently truncated">⚠ near 512-tok limit</span>` : ""}
        <span>${turn.data ? `${tokens} tok` : turn.pending ? "sending…" : "error"}</span>
        <div class="seg turn-view">
          <button type="button" class="ghost" data-act="turn-view" data-i="${index}" data-view="ui">UI</button>
          <button type="button" class="ghost" data-act="turn-view" data-i="${index}" data-view="json">JSON</button>
        </div>
      </span>
    </header>`;
}

/* Both views are in the markup and swapped with `hidden`, so flipping the toggle never rebuilds. */
function stateRowMarkup(turn) {
  const replied = turn.data !== undefined || turn.error !== undefined;
  return html`
    <div class="state">
      <div class="state-text">${turn.request.state}</div>
      <pre class="state-json">${JSON.stringify(turn.request, null, 2)}</pre>
      ${replied ? html`<div class="state-label state-sub">Response</div>
      <pre class="state-resp">${JSON.stringify(turn.data ?? { error: turn.error }, null, 2)}</pre>` : ""}
    </div>`;
}

function turnMarkup(turn, index) {
  const body = turn.error ? errorMarkup(turn.error)
    : turn.data ? answersMarkup(turn.request.questions, turn.data)
    : html`<div class="turn-pending">thinking…</div>`;
  return html`<div class="turn">${turnHeadMarkup(turn, index)}${stateRowMarkup(turn)}${body}</div>`;
}

function showReadout(turn) {
  if (!turn.data) return;
  $("#r-model").textContent = turn.data.model;
  $("#r-tokens").textContent = `${turn.data.usage?.input_tokens} tok`;
}

const scrollLog = () => { log.parentElement.scrollTop = log.parentElement.scrollHeight; };

function renderLog() {
  if (!history.length) {
    log.innerHTML = html`
      <div class="empty">Build a request on the left and press Send. Laya answers every question in
      one pass — each turn is independent, it has no memory.</div>`.s;
    return;
  }
  openIndex = history.length - 1;
  log.innerHTML = html`${history.map(turnMarkup)}`.s;
  syncOpen();
}

async function ask(request) {
  log.querySelector(".empty")?.remove();
  const at = Date.now();
  const pending = node(turnMarkup({ request, at, pending: true }, history.length));
  log.append(pending);
  applyView(pending, "ui");
  scrollLog();
  /* The new turn opens; every turn before it minimizes. */
  openIndex = history.length;
  syncOpen();

  let turn;
  try {
    const res = await fetch("/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await res.json();
    turn = res.ok ? { request, data: body, at } : { request, error: body.detail, at };
  } catch (e) {
    turn = { request, error: String(e), at };
  }
  pending.remove();
  history.push(turn);
  store.set("laya.history", history.slice(-30));
  openIndex = history.length - 1;
  log.append(node(turnMarkup(turn, openIndex)));
  syncOpen();
  showReadout(turn);
}

// ---- actions -------------------------------------------------------------
// One listener for generated markup. A node says what it is with `data-act`; the handler reads
// its `data-i` / `data-j` / `data-view` rather than closing over a position in the array.

const ACTIONS = {
  "toggle-turn": (el) => { openIndex = openIndex === Number(el.dataset.i) ? -1 : Number(el.dataset.i); syncOpen(); },
  "turn-view": (el) => {
    const turn = history[Number(el.dataset.i)];
    turn.view = el.dataset.view;
    applyView(el.closest(".turn"), turn.view);
  },
  "del-question": (el) => { questions.splice(Number(el.dataset.i), 1); save(); paintEditor(); },
  "add-option": (el) => { questions[Number(el.dataset.i)].criteria.push(["", ""]); save(); paintEditor(); },
  "del-option": (el) => { questions[Number(el.dataset.i)].criteria.splice(Number(el.dataset.j), 1); save(); paintEditor(); },
  "add-rung": (el) => { questions[Number(el.dataset.i)].criteria.push(""); save(); paintEditor(); },
  "del-rung": (el) => { questions[Number(el.dataset.i)].criteria.splice(Number(el.dataset.j), 1); save(); paintEditor(); },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el) ACTIONS[el.dataset.act]?.(el);
});

document.addEventListener("input", (e) => {
  const el = e.target.closest("[data-field]");
  if (el) setField(el.dataset.field, el.value);
});

// ---- wiring --------------------------------------------------------------

const addQuestion = (type) => {
  if (qView === "json" && !applyJsonView()) return;
  questions.push(blankFor(type));
  paintEditor();
  $(`#questions [data-key="${questions.length - 1}.name"]`)?.focus();
};
$("#add-noul").onclick = () => addQuestion("noul");
$("#add-choice").onclick = () => addQuestion("choice");
$("#add-score").onclick = () => addQuestion("score");
$("#clear-log").onclick = () => { history = []; store.set("laya.history", history); renderLog(); };

$("#send").onclick = sendRequest;
stateBox.addEventListener("input", () => { store.set("laya.state", stateBox.value); syncSend(); });
stateBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendRequest();
});

paintEditor();
renderLog();
syncSend();

fetch("/ui/presets").then((r) => r.json()).then((presets) => {
  const sel = $("#preset");
  for (const name of Object.keys(presets)) sel.append(node(html`<option value="${name}">${name}</option>`));
  sel.onchange = () => { if (sel.value) adoptExample(presets[sel.value]); sel.value = ""; };
}).catch(() => {});

/* ------------------------------------------------------------------------------
   The JSON pane's CodeMirror instance.

   The same component laya-web uses (see its src/JsonCode.tsx), loaded from esm.sh with every
   package pinned to the concrete versions esm.sh resolves its own transitive imports to, so there
   is exactly one copy of @codemirror/state in the graph and the extensions compose.
   ------------------------------------------------------------------------------ */

try {
  const [{ EditorView }, { HighlightStyle, syntaxHighlighting }, { tags: t }, { json }, { basicSetup }] =
    await Promise.all([
      import("https://esm.sh/@codemirror/view@6.43.12"),
      import("https://esm.sh/@codemirror/language@6.12.4"),
      import("https://esm.sh/@lezer/highlight@1.2.3"),
      import("https://esm.sh/@codemirror/lang-json@6.0.2"),
      import("https://esm.sh/codemirror@6.0.2"),
    ]);

  // Colours reference the page's own custom properties, so light and dark follow the theme
  // with no second palette to keep in sync.
  const highlight = HighlightStyle.define([
    { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--t-key)", fontWeight: "500" },
    { tag: [t.string, t.special(t.string)], color: "var(--t-str)" },
    { tag: t.number, color: "var(--t-num)" },
    { tag: [t.bool, t.null, t.atom, t.keyword], color: "var(--t-lit)" },
    { tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace], color: "var(--t-punct)" },
    { tag: t.invalid, color: "var(--warn)" },
  ]);

  const theme = EditorView.theme({
    "&": { color: "var(--t-punct)", backgroundColor: "transparent", height: "100%", fontSize: "12.5px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", padding: "10px 0 14px" },
    ".cm-content": { padding: "0 10px 0 4px", caretColor: "var(--ink)" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted)", opacity: "0.65", paddingRight: "2px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 10px", minWidth: "2.5em" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--signal) 7%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)", opacity: "1" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--signal) 26%, transparent)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)", borderLeftWidth: "1.5px" },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent", border: "1px solid var(--rule)",
      color: "var(--muted)", borderRadius: "2px", padding: "0 5px", margin: "0 2px",
    },
    ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--muted)" },
    ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--ink)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--signal) 20%, transparent)", outline: "none",
    },
    ".cm-nonmatchingBracket": { backgroundColor: "transparent", color: "var(--warn)" },
  });

  jsonPane.editor = new EditorView({
    parent: qJsonHost,
    doc: jsonPane.text,
    extensions: [
      basicSetup, json(), theme, syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => { if (update.docChanged) jsonPane.clearError(); }),
    ],
  });
  jsonPane.editor.requestMeasure();
} catch (error) {
  jsonPane.fail(error);
}
