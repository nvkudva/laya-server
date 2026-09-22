const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
};
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

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

function renderEditor() {
  const host = $("#questions");
  host.replaceChildren(...questions.map((q, i) => {
    const save = () => store.set("laya.questions", questions);
    const head = el("div", { class: "row" },
      el("input", { name: "name", placeholder: "question_name", value: q.name,
        oninput: (e) => { q.name = e.target.value; save(); } }),
      el("span", { class: "meta" }, q.type),
      el("button", { class: "ghost x", type: "button",
        onclick: () => { questions.splice(i, 1); save(); renderEditor(); } }, "✕"));

    const instr = el("textarea", { placeholder: "instructions" });
    instr.value = q.instructions;
    instr.addEventListener("input", (e) => { q.instructions = e.target.value; save(); });

    const parts = [head, instr];

    if (q.type === "choice") {
      parts.push(el("label", {}, "criteria — label : description"));
      q.criteria.forEach((pair, j) => {
        parts.push(el("div", { class: "crit" },
          el("input", { class: "label", placeholder: "label", value: pair[0],
            oninput: (e) => { pair[0] = e.target.value; save(); } }),
          el("input", { placeholder: "description (optional)", value: pair[1] ?? "",
            oninput: (e) => { pair[1] = e.target.value; save(); } }),
          el("button", { class: "ghost x", type: "button",
            onclick: () => { q.criteria.splice(j, 1); save(); renderEditor(); } }, "✕")));
      });
      parts.push(el("button", { class: "ghost", type: "button",
        onclick: () => { q.criteria.push(["", ""]); save(); renderEditor(); } }, "+ option"));
    } else if (q.type === "score") {
      parts.push(el("label", {}, "criteria — lowest rung first"));
      q.criteria.forEach((rung, j) => {
        parts.push(el("div", { class: "crit" },
          el("input", { placeholder: `rung ${j}`, value: rung,
            oninput: (e) => { q.criteria[j] = e.target.value; save(); } }),
          el("button", { class: "ghost x", type: "button",
            onclick: () => { q.criteria.splice(j, 1); save(); renderEditor(); } }, "✕")));
      });
      parts.push(el("button", { class: "ghost", type: "button",
        onclick: () => { q.criteria.push(""); save(); renderEditor(); } }, "+ rung"));
    } else {
      parts.push(el("label", {}, "criteria (optional)"));
      const [t, f] = [q.criteria[0] ?? "", q.criteria[1] ?? ""];
      parts.push(el("div", { class: "crit" },
        el("input", { class: "label", value: "true", disabled: "" }),
        el("input", { placeholder: "what makes it true", value: t,
          oninput: (e) => { q.criteria[0] = e.target.value; save(); } })));
      parts.push(el("div", { class: "crit" },
        el("input", { class: "label", value: "false", disabled: "" }),
        el("input", { placeholder: "what makes it false", value: f,
          oninput: (e) => { q.criteria[1] = e.target.value; save(); } })));
    }
    return el("div", { class: "q" }, parts);
  }));
  $("#q-count").textContent = `${questions.length} question${questions.length === 1 ? "" : "s"}`;

  const asJson = qView === "json";
  $("#request-ui").hidden = asJson;
  qJsonHost.hidden = !asJson;
  if (asJson) jsonPane.write(JSON.stringify(requestBody({ strict: false }), null, 2));
  for (const b of document.querySelectorAll("#q-view button")) {
    b.classList.toggle("is-on", b.dataset.view === qView);
  }
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
  renderEditor();
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
  renderEditor();
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

function renderAnswer(name, q, a) {
  const data = rowsFor(a);
  const winner = data.reduce((best, r, i) => (r.p > data[best].p ? i : best), 0);
  const act = a.action?.act_probability ?? a.rl_agent?.act_probability;
  return el("section", { class: "dist" },
    el("div", { class: "dist-q" },
      el("span", { class: "dist-instr" }, q?.instructions || name),
      el("span", { class: "dist-answer" }, summaryFor(a))),
    el("header", { class: "dist-head" },
      el("h3", {}, name),
      el("span", { class: "dist-type" }, a.type)),
    el("ol", { class: "bars" }, data.map((r, i) =>
      el("li", { class: i === winner ? "bar-row is-top" : "bar-row", title: `${r.label} — ${r.p.toFixed(4)}` },
        el("span", { class: "bar-label" }, r.label),
        el("span", { class: "bar-track" },
          el("span", { class: "bar-fill", style: `width: max(2px, ${r.p * 100}%)` })),
        el("span", { class: "bar-value" }, pct(r.p), el("span", { class: "pct" }, "%"))))),
    el("footer", { class: "dist-foot" },
      el("span", {}, a.type === "score" ? `expectation, ${data.length} levels`
        : a.type === "noul" ? "p(true)" : `${data.length} options`),
      el("span", { class: "dist-meta" },
        a.confidence != null ? el("span", {}, `confidence ${a.confidence.toFixed(3)}`) : null,
        act != null ? el("span", {}, `act ${act.toFixed(3)}`) : null)));
}

function renderAnswers(sent, data) {
  const wrap = el("div", { class: "answers" });
  for (const [name, a] of Object.entries(data.answers ?? {})) wrap.append(renderAnswer(name, sent[name], a));
  return wrap;
}

function renderError(detail) {
  return el("div", { class: "answers" },
    el("div", { class: "notice" },
      el("h3", {}, "Request rejected"),
      (Array.isArray(detail) ? detail : [{ loc: [], msg: String(detail) }]).map((d) =>
        el("div", {}, el("code", {}, (d.loc ?? []).join(".")), ` ${d.msg}`))));
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

function syncOpen() {
  document.querySelectorAll("#log .turn").forEach((node, i) => {
    const open = i === openIndex;
    node.classList.toggle("is-open", open);
    const caret = node.querySelector(".turn-caret");
    if (caret) caret.textContent = open ? "▾" : "▸";
  });
}

function turnHead(turn, index) {
  const tokens = turn.data?.usage?.input_tokens;
  const time = turn.at ? new Date(turn.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return el("header", { class: "turn-head" },
    el("span", { class: "turn-caret" }, "▸"),
    el("span", {}, `Request #${index + 1}`),
    time ? el("span", {}, `· ${time}`) : null,
    el("span", { class: "turn-meta" },
      tokens >= 450 ? el("span", { class: "turn-warn", title: "Content past the 512-token context limit is silently truncated" }, "⚠ near 512-tok limit") : null,
      el("span", {}, turn.data ? `${tokens} tok` : turn.pending ? "sending…" : "error"),
      el("div", { class: "seg turn-view" },
        el("button", { type: "button", class: "ghost", "data-view": "ui" }, "UI"),
        el("button", { type: "button", class: "ghost", "data-view": "json" }, "JSON"))));
}

/* JSON is the wire pair — the request as sent and the reply as received — so the answers block,
   which is only a rendering of `response.answers`, stands down while it is up. */
function applyView(node, view) {
  const json = view === "json";
  node.querySelector(".state-text").hidden = json;
  for (const e of node.querySelectorAll(".state-json, .state-sub, .state-resp")) e.hidden = !json;
  const answers = node.querySelector(".answers");
  if (answers) answers.hidden = json;
  for (const b of node.querySelectorAll(".turn-view button[data-view]")) b.classList.toggle("is-on", b.dataset.view === view);
}

/* Both views are built up front and swapped with `hidden`, so flipping the toggle never rebuilds. */
function stateRow(turn) {
  const replied = turn.data !== undefined || turn.error !== undefined;
  return el("div", { class: "state" },
    el("div", { class: "state-text" }, turn.request.state),
    el("pre", { class: "state-json" }, JSON.stringify(turn.request, null, 2)),
    replied ? el("div", { class: "state-label state-sub" }, "Response") : null,
    replied ? el("pre", { class: "state-resp" }, JSON.stringify(turn.data ?? { error: turn.error }, null, 2)) : null);
}

function renderTurn(turn, index) {
  const tokens = turn.data?.usage?.input_tokens;
  const node = el("div", { class: "turn" },
    turnHead(turn, index),
    stateRow(turn),
    turn.error ? renderError(turn.error) : renderAnswers(turn.request.questions, turn.data));
  applyView(node, turn.view ?? "ui");

  node.querySelector(".turn-head").addEventListener("click", (e) => {
    if (e.target.closest(".turn-view")) return; // the view buttons live in the header, not on it
    openIndex = openIndex === index ? -1 : index;
    syncOpen();
  });
  node.querySelector(".turn-view").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    turn.view = btn.dataset.view;
    applyView(node, turn.view);
  });

  log.append(node);
  log.parentElement.scrollTop = log.parentElement.scrollHeight;
  if (turn.data) {
    $("#r-model").textContent = turn.data.model;
    $("#r-tokens").textContent = `${tokens} tok`;
  }
}

function renderLog() {
  log.replaceChildren();
  if (!history.length) {
    log.append(el("div", { class: "empty" },
      "Build a request on the left and press Send. " +
      "Laya answers every question in one pass — each turn is independent, it has no memory."));
    return;
  }
  openIndex = history.length - 1;
  history.forEach(renderTurn);
  syncOpen();
}

async function ask(request) {
  log.querySelector(".empty")?.remove();
  const at = Date.now();
  const pendingNode = el("div", { class: "turn" },
    turnHead({ request, at, pending: true }, history.length),
    stateRow({ request }),
    el("div", { class: "turn-pending" }, "thinking…"));
  applyView(pendingNode, "ui");
  log.append(pendingNode);
  log.parentElement.scrollTop = log.parentElement.scrollHeight;
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
  pendingNode.remove();
  history.push(turn);
  store.set("laya.history", history.slice(-30));
  openIndex = history.length - 1;
  renderTurn(turn, openIndex);
  syncOpen();
}

// ---- wiring --------------------------------------------------------------

const addQuestion = (type) => {
  if (qView === "json" && !applyJsonView()) return;
  questions.push(blankFor(type));
  renderEditor();
  [...document.querySelectorAll('#questions input[name="name"]')].pop()?.focus();
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

renderEditor();
renderLog();
syncSend();

fetch("/ui/presets").then((r) => r.json()).then((presets) => {
  const sel = $("#preset");
  for (const name of Object.keys(presets)) sel.append(el("option", { value: name }, name));
  sel.onchange = () => { if (sel.value) adoptExample(presets[sel.value]); sel.value = ""; };
}).catch(() => {});

/* ------------------------------------------------------------------------------
   The JSON pane's CodeMirror instance. A module, because it uses top-level await
   to import from esm.sh; this file is loaded as one.
   ------------------------------------------------------------------------------ */

/* The JSON pane's CodeMirror instance — the same component laya-web uses (see its
 * src/JsonCode.tsx), loaded from esm.sh with every package pinned to the concrete versions
 * esm.sh resolves its own transitive imports to, so there is exactly one copy of
 * @codemirror/state in the graph and the extensions compose. */
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
