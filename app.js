/* CloudFlow Console logic. Plain JS. The simulation engine is sim.js; all network access (Live mode) lives in live.js. */
(function () {
  "use strict";
  const SIM = window.CloudFlowSim;
  const LIVE = window.CloudFlowLive;
  const IMG = window.CloudFlowImaging;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };

  // ---- architecture diagram: every word comes from arch.js, drawn by archview.js -------------------
  const ARCH = window.CloudFlowArch;
  const AV = window.CloudFlowArchView;
  const EDGE = Object.fromEntries(ARCH.edges.map((e) => [e.id, e]));
  const figure = $("#arch-figure");
  const demoFlow = $("#demo-flow");
  const CUR = AV.CURRENT; // the one deployment the console draws
  const pl = { selected: null };
  // What the current run lights: the nodes of the step on screen (tone) and the trail of nodes and path edges visited so far.
  const lit = { on: false, trail: new Set(), edges: [], now: [], nowEdges: [], tone: "active" };
  const nodeName = (id) => ARCH.text(ARCH.node(id).name, CUR);
  const firstSentence = (t) => { const x = t.split(". ")[0]; return /[.!?]$/.test(x) ? x : x + "."; };
  const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  // arch.js names each path after the route it follows; find one by its last word (success, transient, poison, images).
  const pathFor = (name) => Object.keys(ARCH.paths).find((k) => k === name || k.endsWith("-" + name)); // the public build renames the keys

  function paintAll() {
    [figure, demoFlow].forEach((c) => {
      AV.clear(c);
      if (!lit.on) return;
      AV.highlight(c, { nodes: [...lit.trail], edges: lit.edges, tone: "trail" });
      if (lit.now.length) AV.highlight(c, { nodes: lit.now, edges: lit.nowEdges, tone: lit.tone });
    });
  }

  function showService(id) {
    const n = ARCH.node(id);
    pl.selected = id;
    const conn = ARCH.edgesFor(CUR).filter((e) => e.from === id || e.to === id);
    const connHtml = conn.length
      ? `<ul>${conn.map((e) => `<li><span class="etype ${e.type}">${e.type}</span><span class="dir">${esc(nodeName(e.from))} → ${esc(nodeName(e.to))}</span>: ${esc(ARCH.text(e.label, CUR))}</li>`).join("")}</ul>`
      : '<p class="small muted">No arrows: this is a control that governs the services above, not a data path.</p>';
    $("#arch-info").innerHTML = `<span class="svc">${esc(n.service)}</span><b>${esc(nodeName(id))}</b><span class="badge vchip real">Deployed on AWS</span>` +
      `<p>${esc(ARCH.text(n.role, CUR))}</p>` +
      `<div class="svcgrid"><div><h4>Configuration (from Terraform)</h4>${list(n.config[CUR])}</div><div><h4>Security controls</h4>${list(n.security[CUR])}</div><div><h4>Connections</h4>${connHtml}</div></div>` +
      `<div class="srcchips"><h4>Source</h4>${n.source.map((f) => `<code>${esc(f)}</code>`).join("")}</div>`;
  }

  function renderArchitecture() {
    AV.render(figure, { mode: "full", interactive: true, idPrefix: "a" });
    const ver = ARCH.versions[CUR];
    $("#pl-status").innerHTML = `<span class="badge real">Deployed on AWS</span><span>${esc(ver.status)}. ${esc(ver.note)}</span>`;
    if (pl.selected) { AV.select(figure, pl.selected); showService(pl.selected); }
    else $("#arch-info").innerHTML = '<p class="small muted hint">Select a service in the diagram for its role, Terraform configuration, security controls, source files and connections.</p>';
    paintAll();
  }
  figure.addEventListener("archselect", (e) => {
    showService(e.detail.id);
    $("#arch-info").scrollIntoView({ block: "nearest" });
  });
  $("#pl-zin").onclick = () => AV.zoom(figure, "in");
  $("#pl-zout").onclick = () => AV.zoom(figure, "out");
  $("#pl-zfit").onclick = () => AV.zoom(figure, "fit");

  // The aria-hidden, inert copies (run inspector, live inspector) are drawn in compact mode.
  AV.render(demoFlow, { mode: "compact", interactive: false, idPrefix: "d" });
  AV.render($("#live-flow"), { mode: "compact", interactive: false, idPrefix: "l" });
  [["#demo-flow", "#insp-svc"], ["#live-flow", "#lv-svc"]].forEach(([host, out]) => $(host).addEventListener("click", (e) => {
    const t = e.target.closest("[data-node]");
    if (!t) return;
    e.preventDefault();
    const c = $(host), n = ARCH.node(t.dataset.node);
    AV.select(c, n.id);
    $(out).textContent = `${nodeName(n.id)}: ${firstSentence(ARCH.text(n.role, CUR))}`;
  }));
  renderArchitecture();

  // Lighting a run: the step's nodes glow, the nodes and path edges visited before stay outlined and their edges animate.
  function resetLit() {
    lit.on = true; lit.trail = new Set(); lit.edges = []; lit.now = []; lit.nowEdges = []; lit.tone = "active";
    AV.render(demoFlow, { mode: "compact", interactive: false, idPrefix: "d" });
    paintAll();
  }
  function paintStep(r, s) {
    const nodes = s.lit ? ARCH.stageNodes[s.lit] : s.nodes || (s.node ? [s.node] : []);
    nodes.forEach((id) => lit.trail.add(id));
    lit.edges = ARCH.paths[r.pathName].edges.filter((id) => lit.trail.has(EDGE[id].from) && lit.trail.has(EDGE[id].to));
    lit.now = nodes;
    lit.nowEdges = lit.edges.filter((id) => nodes.includes(EDGE[id].from) && nodes.includes(EDGE[id].to));
    lit.tone = s.tone === "wait" ? "active" : s.tone || "active";
    paintAll();
  }

  // ---- router -------------------------------------------------------------
  const TITLES = { runs: "Runs", architecture: "Architecture", results: "Results" };
  const OLD_ROUTES = { pipeline: "architecture", verification: "results" }; // bookmarks and saved views from earlier builds
  const sidebar = $("#sidebar");
  let currentView = "runs";
  // The combined --case-study build puts the story (#story) above the console shell on one page. Without it everything below is unchanged.
  const story = document.getElementById("story");
  const shellEl = $(".shell");
  const scrollBehavior = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  const scrollToApp = () => window.scrollTo({ top: story ? Math.round(shellEl.getBoundingClientRect().top + window.scrollY) : 0 });
  const goto = (id) => { if (story && location.hash === "#" + id) route(); else location.hash = "#" + id; };
  function showView(id, scroll = true) {
    id = OLD_ROUTES[id] || id;
    if (!TITLES[id]) id = "runs";
    $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + id));
    $$("#nav button").forEach((b) => (b.dataset.view === id ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    $("#pagetitle").textContent = TITLES[id];
    document.title = TITLES[id] + " · CloudFlow";
    currentView = id;
    paintMode();
    sidebar.classList.remove("open");
    $("#menubtn").setAttribute("aria-expanded", "false");
    store.set("cloudflow-view", id);
    if (scroll) scrollToApp();
  }
  let routed = false;
  function route() {
    const h = location.hash.replace(/^#/, "");
    if (OLD_ROUTES[h]) { location.replace("#" + OLD_ROUTES[h]); return; }
    if (story && (!h || /^(story|stop-\d\d)$/.test(h))) { // the story's own places (journey.js handles #stop-NN): show Runs below it, never scroll
      if (!routed || (!h && currentView !== "runs")) showView("runs", false);
      routed = true;
      return;
    }
    if (story && h === "overview") { // the old Overview address: the top of the story (Runs below it stays the console view)
      if (!routed) showView("runs", false);
      routed = true;
      window.scrollTo({ top: 0, behavior: scrollBehavior() });
      return;
    }
    routed = true;
    showView(h || store.get("cloudflow-view") || "runs"); // an unknown name, "overview" included, falls back to Runs
  }
  $$("#nav button").forEach((b) => (b.onclick = () => goto(b.dataset.view)));
  window.addEventListener("hashchange", route);
  $("#menubtn").onclick = () => {
    const open = sidebar.classList.toggle("open");
    $("#menubtn").setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => $("#nav button").focus(), 50);
  };
  document.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (/^[1-3]$/.test(e.key)) goto(Object.keys(TITLES)[Number(e.key) - 1]);
    if (e.key === "Escape") sidebar.classList.remove("open");
  });

  // ---- plain-English transitions derived from engine events ----------------
  const SVC = { client: "Client", apigw: "API Gateway", sqs: "SQS queue", lambda: "Lambda worker", dynamodb: "DynamoDB", s3: "S3", dlq: "Dead-letter queue", alarm: "CloudWatch", sns: "SNS", clock: "Virtual clock" };
  // Image jobs follow the deployed route shape (sign-in, POST /uploads, POST /jobs, worker, GET /jobs/{id}).
  // Returns a step, null to hide an event, or undefined to fall back to the generic wording.
  function narrateImage(ev, ctx) {
    const k = ev.kind, a = ev.actor, t = ev.text;
    if (a === "client" && k === "request") {
      if (/sign-in/.test(t)) return { node: "client", lit: "signin", text: "Simulated: you sign in on the Cognito hosted page (authorization code with PKCE). It returns an ID token; its sub claim becomes the owner of the job." };
      if (/POST \/uploads/.test(t)) return { node: "client", lit: "uploads", text: "Simulated: POST /uploads with each file's name, type and size, authorised by the ID token." };
      if (/POST \/jobs/.test(t)) return { node: "client", lit: "submit", text: "Simulated: POST /jobs with the ID token, the input keys and the resize options." };
      return null;
    }
    if (a === "apigw" && k === "response" && /presigned POST/.test(t)) return { node: "apigw", lit: "uploads", tone: "good", text: "Simulated: the API returns one presigned POST per file. Nothing is uploaded; your files stay in your browser." };
    if (a === "dynamodb" && k === "put" && /status=queued/.test(t)) return { node: "dynamodb", lit: "submit", text: "Simulated: the API function registers the job in DynamoDB as queued, with its owner, input keys and options." };
    if (a === "apigw" && k === "response" && ev.status === 202) return { node: "apigw", lit: "submit", tone: "good", stage: "queued", status: "queued", http: "202", text: "Simulated: the request is validated, the message is sent to SQS, and 202 with a job id is returned." };
    if (a === "status" && k === "response" && ev.status === 200) {
      const st = (/status=(\w+)/.exec(t) || [])[1];
      if (st === "queued") return { node: "client", lit: "status", stage: "queued", status: "queued", http: "200", text: "Simulated: GET /jobs/{jobId} answers 200 with status queued; no worker has claimed the job yet." };
      if (st === "completed") return { node: "client", lit: "status", tone: "good", stage: "completed", status: "completed", http: "200", text: "Simulated: GET /jobs/{jobId} answers 200 with the final record. The resized files are in your browser, not in S3." };
      return { node: "client", lit: "status", tone: "bad", stage: "failed", status: "failed", http: "200", text: "Simulated: GET /jobs/{jobId} answers 200 with status failed and the error \"all files failed\"." };
    }
    if (a === "dynamodb" && k === "claim") return { node: "dynamodb", lit: "record", stage: "processing", status: "processing", text: "Simulated: the worker claims the job atomically (status processing, a lease owner and expiry, the attempt counted), so a duplicate delivery cannot work on it at the same time." };
    if (a === "processor" && k === "work") return { node: "lambda", lit: "worker", imaging: true, text: "Lambda worker (simulated): resizing happens in your browser. On AWS the Lambda worker runs Pillow here; in this demo your browser does the resizing." };
    if (a === "s3" && k === "put") { ctx.stored = true; return { node: "s3", lit: "worker", tone: "good", text: "S3 (simulated): the worker writes the job's manifest.json. The resized image bytes are not in S3; they stay in your browser." }; }
    if (a === "dynamodb" && k === "update") {
      if (/status=completed/.test(t)) return { node: "dynamodb", lit: "record", tone: "good", stage: "completed", status: "completed", text: "Simulated: the worker records status completed with each file's result, the completed and failed counts, and the manifest key. A file that failed is recorded and never retried." };
      return { node: "dynamodb", lit: "record", tone: "bad", stage: "failed", status: "failed", text: "Simulated: every file failed, so the worker records status failed with the error \"all files failed\". It does not retry." };
    }
    if (a === "sqs" && k === "delete") return ctx.stored ? undefined : null; // the delete that follows the browser work only
    return undefined;
  }
  const LEGACY_STATUS = ["client", "apigw", "status_lambda"]; // the legacy status route: client, API Gateway, status function
  function narrate(ev, ctx) {
    const k = ev.kind, a = ev.actor, t = ev.text;
    if (ctx.image) { const n = narrateImage(ev, ctx); if (n !== undefined) return n; }
    if (a === "client" && k === "request" && /POST/.test(t)) return { node: "client", text: "POST /submit with the task and payload, plus the API key." };
    if (a === "client" && k === "request" && /send-message/.test(t)) return { node: "sqs", tone: "bad", text: "A corrupt, non-JSON message is dropped straight onto the queue, bypassing the API." };
    if (a === "apigw" && k === "response" && ev.status === 202) return { node: "apigw", tone: "good", stage: "queued", status: "queued", http: "202", text: "Request validated against the schema; message written to SQS; 202 with a job id returned in milliseconds." };
    if (a === "apigw" && k === "response") return { node: "apigw", tone: "bad", http: `${ev.status}`, text: `Rejected before reaching the queue: ${t}` };
    if (a === "status" && ev.status === 202) return { node: "client", nodes: LEGACY_STATUS, stage: "pending", status: "pending", http: "202", text: "Status check answers pending: no worker has picked it up yet." };
    if (a === "status" && ev.status === 200 && /completed/.test(t)) return { node: "client", nodes: LEGACY_STATUS, tone: "good", stage: "completed", status: "completed", http: "200", text: "Status check answers completed and includes a five-minute signed download link." };
    if (a === "status" && ev.status === 200 && /failed/.test(t)) return { node: "client", nodes: LEGACY_STATUS, tone: "bad", stage: "failed", status: "failed", http: "200", text: "Status check answers failed, with the short error and the attempt count." };
    if (a === "sqs" && k === "receive") return { node: "lambda", nodes: ctx.image ? ["sqs", "lambda"] : undefined, stage: ctx.poison ? `attempt ${ctx.attempt}` : undefined, attempts: ctx.attempt, text: ctx.attempt > 1 ? `Visibility timeout over: the worker receives the message again (attempt ${ctx.attempt}).` : "The event source mapping delivers the message to the worker; it is hidden from other workers until the visibility timeout ends." };
    if (a === "dynamodb" && k === "put" && /status=processing/.test(t)) return { node: "dynamodb", stage: "processing", status: "processing", text: "Conditional PutItem creates the job record with status processing." };
    if (a === "dynamodb" && k === "put" && /ConditionalCheckFailed/.test(t)) return { node: "dynamodb", stage: "retry", status: "processing", text: "The record already exists from attempt 1, so the worker updates it instead of creating a duplicate." };
    if (a === "s3" && k === "put") return { node: "s3", tone: "good", text: "After one second of stand-in work the result JSON is written to S3." };
    if (a === "s3" && k === "error") return { node: "s3", tone: "bad", text: "The S3 write fails with a temporary error (injected for this scenario)." };
    if (a === "processor" && k === "transient") return { node: "lambda", tone: "bad", stage: "failed", status: "failed", text: "The worker records status failed with a short error and lists the message in batchItemFailures so SQS retries it." };
    if (a === "sqs" && k === "retain") return { node: "sqs", text: "Only the failed message stays on the queue, hidden until the visibility timeout ends." };
    if (a === "clock" && k === "wait") return { node: null, tone: "wait", text: `${Math.round(ev.waitSeconds)} seconds pass on the virtual clock.` };
    if (a === "dynamodb" && k === "update" && /status=completed/.test(t)) return { node: "dynamodb", tone: "good", stage: "completed", status: "completed", text: ctx.attempt > 1 ? "Status set to completed with the result key; the earlier error is removed from the record." : "Status set to completed with the result key." };
    if (a === "processor" && k === "poison") return { node: "lambda", tone: "bad", status: "no record", text: `The body is not JSON, so there is no job id to record. The worker writes nothing and reports the message for retry (attempt ${ctx.attempt} of 3).` };
    if (a === "sqs" && k === "dlq") return { node: "dlq", tone: "bad", stage: "dead-letter", status: "dead-lettered", text: "Receive count exceeded 3: SQS moves the message to the dead-letter queue and keeps it for 14 days." };
    if (a === "cloudwatch" && k === "alarm") return { node: "alarm", tone: "bad", text: "Dead-letter queue depth ≥ 1 for one period: the alarm goes to ALARM." };
    if (a === "sns" && k === "notify") return { node: "sns", tone: "bad", text: "The alarm action publishes to the SNS alert topic." };
    if (a === "sqs" && k === "delete") return { node: "sqs", tone: "good", text: "The worker reported no failure for this message, so the mapping deletes it from the queue." };
    if (a === "s3" && k === "get") return { node: "s3", tone: "good", text: "Fetching the signed link returns the stored file (no credentials, no bucket access needed)." };
    return null;
  }
  const STAGES = {
    success: ["queued", "pending", "processing", "completed"],
    transient: ["queued", "processing", "failed", "retry", "completed"],
    poison: ["queued", "attempt 1", "attempt 2", "attempt 3", "dead-letter"],
    images: ["queued", "processing", "completed"],
    imagesFailed: ["queued", "processing", "failed"],
  };
  const stageList = (r) => (r.kind === "images" ? (r.images.summary && r.images.summary.completed === 0 ? STAGES.imagesFailed : STAGES.images) : STAGES[r.scenario]);
  const SCENARIO_NAME = { success: "Successful job", transient: "Temporary failure", poison: "Corrupt message" };

  // ---- runs workspace -------------------------------------------------------
  // Two kinds of run share one engine-driven playback: "images" (real browser resize inside a simulated
  // pipeline) and "scenario" (the three reliability demos on the Architecture page).
  const runs = [];
  const ui = { timer: null, pos: 0, current: null, busy: false, finishP: null, running: false };
  const el = {
    run: $("#run"), skip: $("#skip"), plSkip: $("#pl-skip"), stages: $("#stages"), narration: $("#narration"),
    statusJson: $("#status-json"), resultJson: $("#result-json"), log: $("#log"), stateSub: $("#state-sub"), outputSub: $("#output-sub"),
    jcId: $("#jc-id"), jcShort: $("#jc-shortid"), jcStatus: $("#jc-status"), jcAttempts: $("#jc-attempts"), jcHttp: $("#jc-http"), jcCreated: $("#jc-created"),
    inspector: $("#inspector"), inspTitle: $("#insp-title"), inspSvc: $("#insp-svc"), tbody: $("#runs-table tbody"), count: $("#runs-count"),
  };
  const layout = $(".runs-layout");
  // No Progress, Result or History panels until the current mode has a job (or is loading its history); then the two-column workspace.
  function paintLayout() {
    const has = liveMode() ? !!liveSession() && (lv.rows.length > 0 || lv.loading || !!lv.up || lv.upFailed !== null) : runs.length > 0;
    layout.classList.toggle("has-runs", has);
  }
  const API_HEADERS = { "x-api-key": "sim-api-key", "content-type": "application/json" };
  const DEMO_BODY = JSON.stringify({ task: "echo", payload: { hello: "world", n: 3 } });
  const inProgress = () => !!(ui.timer || ui.finishP);
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
  const FORMAT_LABEL = { jpeg: "JPEG", png: "PNG", webp: "WebP" };
  const picked = []; // chosen files: { file, url, error }
  const pad2 = (n) => String(n).padStart(2, "0");
  const absTime = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`; };
  const relTime = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 10 ? "just now" : s < 60 ? s + "s ago" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : Math.floor(s / 86400) + " d ago";
  };
  // A "Submitted" cell: relative text, absolute time in the title; the span is refreshed by the one-second tick.
  const timeCell = (ms) => (Number.isFinite(ms) ? `<td class="c-time" data-label="Submitted" title="${esc(absTime(ms))}"><span data-ts="${ms}">${esc(relTime(ms))}</span></td>` : '<td class="c-time" data-label="Submitted">—</td>');
  const statusPill = (status, cls) => `<span class="pill ${esc(cls || String(status).replace(/\s.*/, ""))}">${esc(status)}</span>`;
  const shortId = (id) => (id ? String(id).slice(0, 8) : "—");
  const jobLabel = (id) => (/^[0-9a-f]{8}-/.test(id) ? id.slice(0, 8) : "no job id");

  // ---- history toolbar state, shared by the demo table and the Live table ----
  const hist = { q: "", status: "all", sort: "new" };
  const bucketOf = (s) => (s === "completed" ? "completed" : /^(failed|dead-lettered|rejected|no record)$/.test(s) ? "failed" : "active");
  // items: { id, status, ts }; returns the filtered, sorted copy.
  function histItems(items) {
    const q = hist.q.trim().toLowerCase();
    const out = items.filter((x) => (hist.status === "all" || bucketOf(x.status) === hist.status) && (!q || String(x.id || "").toLowerCase().includes(q)));
    return out.sort((a, b) => (hist.sort === "new" ? b.ts - a.ts : a.ts - b.ts));
  }
  let emptyAct = null;
  // One block under the toolbar: the table when there are rows, else a loading skeleton or an empty state that says what to do next.
  function paintHist(o) { // o: { total, shown, loading, title, text, cta, act }
    $("#hist-toolbar").hidden = !(o.total > 0);
    $("#hist-skel").hidden = !o.loading;
    $("#hist-empty").hidden = !!o.loading || o.shown > 0 || !o.title;
    $("#hist-empty-title").textContent = o.title || "";
    $("#hist-empty-text").textContent = o.text || "";
    const cta = $("#hist-cta");
    cta.hidden = !o.cta;
    cta.textContent = o.cta || "";
    emptyAct = o.act || null;
  }
  const clearFilters = () => {
    hist.q = ""; hist.status = "all"; hist.sort = "new";
    $("#hist-search").value = ""; $("#hist-status").value = "all"; $("#hist-sort").value = "new";
  };
  const noMatch = () => ({ title: "No runs match", text: "Nothing matches this search and status. Clear the filters to see every run.", cta: "Clear filters", act: () => { clearFilters(); renderHist(); } });
  const renderHist = () => (liveMode() ? renderLiveTable() : renderTable());
  $("#hist-search").oninput = (e) => { hist.q = e.target.value; renderHist(); };
  $("#hist-status").onchange = (e) => { hist.status = e.target.value; renderHist(); };
  $("#hist-sort").onchange = (e) => { hist.sort = e.target.value; renderHist(); };
  $("#hist-cta").onclick = () => { if (emptyAct) emptyAct(); };

  // ---- job execution stepper: Upload > Queued > Processing > Completed (Failed / Dead-lettered replace the last) ----
  const stepperEl = $("#stepper");
  const IDLE = { phase: -1, text: "No job yet. Add images and start one to watch it move through the pipeline." };
  let execDemo = IDLE;
  // cfg: { phase 0..3 or -1, final: completed|failed|dead-lettered, failAt, skipUpload, subs: {step: text}, text }
  function paintStepper(cfg) {
    const li = $$("li", stepperEl);
    li.forEach((node, i) => {
      let st = "todo";
      if (cfg.phase >= 0) {
        if (i < cfg.phase) st = i === 0 && cfg.skipUpload ? "skip" : "done";
        else if (i === cfg.phase) st = cfg.failAt ? "bad" : cfg.phase === 3 ? (cfg.final === "completed" ? "ok" : "bad") : "now";
      }
      node.dataset.state = st;
      if (st === "now") node.setAttribute("aria-current", "step"); else node.removeAttribute("aria-current");
      $(".ssub", node).textContent = (cfg.subs && cfg.subs[i]) || (st === "skip" ? "not used" : "");
    });
    $(".slabel", li[3]).textContent = cfg.final === "failed" ? "Failed" : cfg.final === "dead-lettered" ? "Dead-lettered" : "Completed";
    const status = $("#exec-status");
    if (status.textContent !== cfg.text) status.textContent = cfg.text;
  }
  const STEP_NAMES = ["Uploading", "Queued", "Processing", "Finished"];
  // The simulated run's stage name (from the engine events) mapped onto the four steps.
  function stepperFor(r, stage) {
    const scen = r.kind !== "images", im = r.images;
    const mk = (phase, final, extra) => Object.assign({ phase, final, skipUpload: scen, text: "Simulated run. " + (final ? (final === "completed" ? "Completed." : final === "failed" ? "Failed." : "Dead-lettered.") : STEP_NAMES[phase] + ".") }, extra);
    const files = im && im.summary ? { 3: `${im.summary.completed} of ${im.summary.total} files` } : null;
    if (stage === "upload") return mk(0, null);
    const s = String(stage);
    if (stage == null || s === "failed") return mk(3, "failed", { subs: files });
    if (/^(queued|pending)$/.test(s)) return mk(1, null);
    if (s === "processing" || s === "retry" || /^attempt/.test(s)) return mk(2, null);
    if (s === "completed") return mk(3, "completed", { subs: files });
    return mk(3, "dead-lettered");
  }
  const setExec = (cfg) => { execDemo = cfg; if (!liveMode()) paintStepper(cfg); };

  function buildRun(sc) {
    const world = new SIM.World({ seed: 20261104 + runs.length });
    const out = { scenario: sc, world, jobId: null, response: null, status: null, result: null };
    if (sc === "poison") {
      SIM.sendRaw(world, "this is not valid json");
      SIM.runUntilIdle(world);
      return out;
    }
    out.response = SIM.submit(world, { headers: API_HEADERS, rawBody: DEMO_BODY });
    if (out.response.status !== 202) return out;
    out.jobId = out.response.body.jobId;
    if (sc === "transient") world.faults.set(out.jobId, { s3Failures: 1 });
    SIM.status(world, out.jobId);
    if (sc === "transient") { SIM.step(world); SIM.status(world, out.jobId); }
    SIM.runUntilIdle(world);
    out.status = SIM.status(world, out.jobId);
    if (out.status.body.resultUrl) out.result = SIM.fetchResult(world, out.status.body.resultUrl);
    return out;
  }
  // First half of an image job: sign in, get upload slots, create the job, let the worker claim it.
  // The files never enter the engine. The second half (completeImageJob) runs after the browser has resized them.
  function buildImageRun(files, options) {
    const world = new SIM.World({ seed: 20261104 + runs.length });
    const owner = SIM.signIn(world);
    const up = SIM.createUploads(world, { owner, files: files.map((f) => ({ name: f.name, contentType: f.type, size: f.size })) });
    const out = { scenario: "images", world, owner, jobId: null, response: up, status: null, result: null };
    if (up.status !== 200) return out;
    out.response = SIM.createJob(world, { owner, inputs: up.body.uploads.map((u) => u.key), options });
    if (out.response.status !== 202) return out;
    out.jobId = out.response.body.jobId;
    SIM.getJob(world, out.jobId, owner);
    SIM.runUntilIdle(world);
    return out;
  }
  function imageSummaryText(r) {
    const s = r.images.summary;
    return s ? `${s.completed} of ${s.total} file${s.total === 1 ? "" : "s"} resized${s.failed ? `, ${s.failed} failed (a failed file is reported, never retried)` : ""}. Nothing was uploaded.` : "resizing is still running.";
  }
  // Steps for the engine events from index `from` on; the narration context persists across both halves.
  function toSteps(run, image, from) {
    const steps = [];
    const ctx = run.ctx || (run.ctx = { attempt: 0, poison: run.scenario === "poison", image: !!image, stored: false });
    const events = run.world.events;
    for (let i = from || 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.actor === "sqs" && ev.kind === "receive") ctx.attempt += 1;
      const n = narrate(ev, ctx);
      if (!n) continue;
      if (steps.length && steps[steps.length - 1].text === n.text) continue;
      steps.push(Object.assign({ clock: ev.clock, svc: SVC[n.node || "clock"] }, n));
    }
    return steps;
  }
  // Second half: hand the browser's per-file outcomes to the engine (the worker's final writes), then queue the narration.
  function completeImageJob(r) {
    const im = r.images, w = r.run.world, before = w.events.length;
    SIM.completeResize(w, r.run.jobId, im.files.map((f, i) => {
      const x = im.results[i];
      return x && x.status === "completed" ? { status: "completed", width: x.width, height: x.height, bytes: x.bytes } : { status: "failed", error: (x && x.error) || "unsupported or corrupt image" };
    }));
    SIM.getJob(w, r.run.jobId, r.run.owner);
    r.steps.push({ clock: w.events[before].clock, svc: "Browser", node: "lambda", text: (rr) => `Real, in your browser: ${imageSummaryText(rr)}` });
    r.steps.push(...toSteps(r.run, true, before));
    const item = w.table.get(r.run.jobId);
    r.facts = { id: r.run.jobId, status: item.status, attempts: String(item.attempts), http: "200" };
  }
  function finalFacts(r) {
    const w = r.world;
    if (r.scenario === "poison") { const m = w.dlq[0]; return { status: "dead-lettered", attempts: m ? `${m.receiveCount - 1} of 3` : "—", http: "direct send", id: "none (unreadable message)" }; }
    if (r.response.status !== 202) return { status: "rejected", attempts: "0", http: String(r.response.status), id: "none (rejected)" };
    return { status: r.status.body.status, attempts: String(r.status.body.attempts), http: "200", id: r.jobId };
  }
  const typeText = (r) => (r.kind === "images" ? "Images" : "Scenario · " + SCENARIO_NAME[r.scenario]);
  const filesText = (r) => {
    if (r.kind !== "images") return "—";
    const im = r.images, ok = im.partial.filter((x) => x.status === "completed").length, bad = im.partial.length - ok;
    return `${ok}/${im.files.length}` + (bad ? ` · ${bad} failed` : "");
  };
  const runPill = (r) => (r.live ? statusPill(r.live.status, "running") : statusPill(r.facts.status));
  const idNote = (r) => (r.run.jobId ? r.run.jobId : "No job id: the message was unreadable, so nothing was recorded");

  function renderTable() {
    paintLayout();
    el.count.textContent = String(runs.length);
    const items = histItems(runs.map((r) => ({ r, id: r.run.jobId || "", status: (r.live || r.facts).status, ts: r.n })));
    el.tbody.innerHTML = items.map(({ r }) => {
      const l = r.live || r.facts;
      return `<tr data-run="${r.n}" aria-selected="${!!ui.current && ui.current.n === r.n}" tabindex="0"><td class="c-status" data-label="Status">${runPill(r)}</td><td class="c-id" data-label="Job" title="${esc(idNote(r))}">${esc(shortId(r.run.jobId))}</td><td class="c-type" data-label="Type">${esc(typeText(r))}</td><td class="c-files" data-label="Files">${esc(filesText(r))}</td><td class="c-attempts num" data-label="Attempts">${esc(l.attempts)}</td>${timeCell(r.createdAt)}</tr>`;
    }).join("");
    $$("tr[data-run]", el.tbody).forEach((tr) => {
      const open = () => selectRun(Number(tr.dataset.run));
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
    if (liveMode()) return;
    $("#sim-runs").hidden = !items.length;
    paintHist(Object.assign({ total: runs.length, shown: items.length }, runs.length ? noMatch() : {}));
  }
  // In-place update of one row while its run is playing (no re-render, so a focused row stays focused).
  function updateRunRow(r) {
    const row = $(`tr[data-run="${r.n}"]`, el.tbody);
    if (!row) return;
    const l = r.live || r.facts;
    $(".c-status", row).innerHTML = runPill(r);
    $(".c-attempts", row).textContent = l.attempts;
    $(".c-files", row).textContent = filesText(r);
  }

  function renderStages(r, current) {
    const list = stageList(r);
    const idx = list.indexOf(current);
    r.stageNow = current;
    el.stages.innerHTML = list.map((s, i) => {
      const cls = i < idx ? "done" : i === idx ? "now " + (s === "completed" ? "good" : /failed|dead/.test(s) ? "bad" : "") : "";
      return `<li class="${cls}">${esc(s)}</li>`;
    }).join("");
    if (ui.current === r) setExec(stepperFor(r, current));
  }
  function setJcId(id) { el.jcId.textContent = id; el.jcShort.textContent = jobLabel(id); }
  function setStatusPill(text) {
    const cls = /dead/.test(text) ? "dead" : /no record/.test(text) ? "failed" : text;
    el.jcStatus.innerHTML = `<span class="pill ${esc(cls)}">${esc(text)}</span>`;
  }
  function resetInspector(r) {
    const img = r.kind === "images";
    el.inspector.hidden = false;
    el.inspTitle.textContent = `run #${r.n} · ${img ? "Images" : SCENARIO_NAME[r.scenario]}`;
    el.jcCreated.textContent = `${absTime(r.createdAt)} (${relTime(r.createdAt)})`;
    $("#insp-fail").hidden = true;
    $("#hood").open = !img; // engineer runs have nothing else to show; image runs lead with results
    $("#img-progwrap").hidden = !img;
    $("#insp-reqact").innerHTML = "";
    $("#img-section").hidden = !img;
    el.inspSvc.textContent = "";
    el.narration.innerHTML = "";
    el.statusJson.textContent = "…"; el.resultJson.textContent = "…";
    el.statusJson.classList.add("idle"); el.resultJson.classList.add("idle");
    setJcId(r.facts.id);
    setStatusPill(r.scenario === "poison" || r.run.response.status === 202 ? "queued" : "rejected");
    el.jcAttempts.textContent = "0";
    el.jcHttp.textContent = r.run.response ? String(r.run.response.status) : "direct send";
    renderStages(r, r.scenario === "poison" || r.run.response.status === 202 ? "queued" : null);
    if (img) setExec(stepperFor(r, "upload")); // the browser-side images begin at the upload step
    resetLit();
    renderImages(r);
  }
  function showStep(r, i) {
    const s = r.steps[i];
    const text = typeof s.text === "function" ? s.text(r) : s.text;
    const li = document.createElement("li");
    li.className = s.tone || "";
    li.innerHTML = `<span class="svc">${esc(s.svc)}</span><span>${esc(text)}</span><span class="t">${esc(s.clock)}</span>`;
    el.narration.appendChild(li);
    $("#pl-caption").textContent = `${s.svc}: ${text}`;
    paintStep(r, s);
    if (s.imaging) startImaging(r);
    if (s.stage) renderStages(r, s.stage);
    if (s.status) { setStatusPill(s.status); r.live = Object.assign({}, r.live, { status: s.status }); }
    if (s.attempts) { el.jcAttempts.textContent = String(s.attempts); r.live = Object.assign({}, r.live, { attempts: String(s.attempts) }); }
    if (s.http) { el.jcHttp.textContent = s.http; r.live = Object.assign({}, r.live, { http: s.http }); }
    if (r.live) updateRunRow(r);
  }
  // The simulated job record for an image job: the DynamoDB item exactly as the simulated API and worker wrote it.
  function imageRecord(r) {
    return JSON.parse(JSON.stringify(r.run.world.table.get(r.run.jobId)));
  }
  function showFinal(r) {
    const run = r.run, w = run.world;
    if (r.kind === "images") {
      el.stateSub.textContent = "simulated DynamoDB item";
      el.statusJson.textContent = JSON.stringify(imageRecord(r), null, 2);
      el.outputSub.textContent = "the resized files";
      el.resultJson.textContent = "The resized bytes live only in this browser (object URLs). Nothing was written to S3 for the images; the outputKey names above are the keys the real worker would use. Only the manifest exists, inside the simulation.";
    } else if (r.scenario === "poison") {
      const m = w.dlq[0];
      el.stateSub.textContent = "no job record exists";
      el.statusJson.textContent = `No DynamoDB record: the message had no readable job id, so nothing was written.\n\nMain queue:   0 messages\nDead-letter:  ${w.dlq.length} message, received ${m ? m.receiveCount : 0} times\nAlarm:        ${w.alarms.dlqMessages}`;
      el.outputSub.textContent = "the parked message";
      el.resultJson.textContent = JSON.stringify({ body: m ? m.body : null, receiveCount: m ? m.receiveCount : 0 }, null, 2);
    } else if (run.response.status !== 202) {
      el.stateSub.textContent = "request rejected";
      el.statusJson.textContent = JSON.stringify({ http: run.response.status, body: run.response.body }, null, 2);
      el.outputSub.textContent = "nothing stored";
      el.resultJson.textContent = "—";
    } else {
      el.stateSub.textContent = "GET /status/{jobId}";
      el.statusJson.textContent = JSON.stringify(run.status.body, null, 2);
      el.outputSub.textContent = `results/${run.jobId}.json`;
      el.resultJson.textContent = run.result ? JSON.stringify(run.result.body, null, 2) : "—";
    }
    setJcId(r.facts.id); setStatusPill(r.facts.status); el.jcAttempts.textContent = r.facts.attempts; el.jcHttp.textContent = r.facts.http;
    renderStages(r, r.facts.status === "completed" ? "completed" : r.facts.status === "dead-lettered" ? "dead-letter" : r.facts.status === "failed" ? "failed" : null);
    el.statusJson.classList.remove("idle"); el.resultJson.classList.remove("idle");
    el.log.textContent = w.events.map((e) => `${e.clock}  ${e.actor.padEnd(10)} ${e.text}`).join("\n");
    const why = failReason(r);
    $("#insp-fail").hidden = !why;
    $("#insp-fail").textContent = why;
  }
  function failReason(r) {
    if (r.kind === "images") return r.facts.status === "failed" ? "Failed: every file failed, so the worker recorded status failed with the error \"all files failed\". A failed file is reported and never retried." : "";
    if (r.scenario === "poison") return "Dead-lettered: the message had no readable job id, so no record was written. After three failed receives SQS moved it to the dead-letter queue.";
    return "";
  }

  // ---- real image processing (imaging.js), started at the simulated worker step ----
  function startImaging(r) {
    const im = r.images;
    if (im.started) return;
    im.started = true; ui.busy = true;
    renderImages(r);
    im.promise = (async () => {
      try {
        const out = await IMG.processFiles(im.blobs, im.options, (done, total, res) => { im.partial.push(res); renderImages(r); updateRunRow(r); });
        im.results = out.results; im.summary = out.summary;
      } catch (e) {
        im.results = im.partial.slice(); im.summary = IMG.summarize(im.results);
      }
      try {
        completeImageJob(r); // the post-worker steps come from the real outcome
      } finally {
        ui.busy = false;
      }
      renderImages(r); renderTable();
    })();
  }
  // Requested settings beside what actually came out. files: [{status, width, height, bytes}]; every number is a measured one.
  function reqActHtml(o, files, total) {
    if (!o) return "";
    const ok = files.filter((f) => f && f.status === "completed");
    const sizes = [...new Set(ok.map((f) => `${f.width} × ${f.height}`))];
    const shown = sizes.slice(0, 3).join(", ") + (sizes.length > 3 ? ` +${sizes.length - 3} more` : "");
    const kv = (k, v, mono) => `<div><dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ""}>${esc(v)}</dd></div>`;
    return `<div class="ra-col" data-col="requested"><h4>Requested</h4><dl class="kv">${kv("Size", `${o.width} × ${o.height} px`, true)}${kv("Fit", o.fit)}${kv("Format", FORMAT_LABEL[o.format] || o.format)}${kv("Enlarge", o.upscale ? "allowed" : "off")}</dl></div>` +
      `<div class="ra-col" data-col="actual"><h4>Actual</h4><dl class="kv">${kv("Completed", `${ok.length} of ${total}`)}${kv("Output sizes", ok.length ? shown : "—", true)}${kv("Total size", ok.length ? fmtBytes(ok.reduce((a, f) => a + (f.bytes || 0), 0)) : "—")}</dl></div>`;
  }
  // Before/after comparison: an SVG with both pictures in the same 4:3 box; the clip rect over the original is moved with setAttribute
  // (no inline styles), driven by a native range input (arrow keys, labelled) or by dragging on the picture.
  let cmpN = 0;
  const viewToggle = () => '<div class="cmptoggle" role="group" aria-label="Comparison view"><button type="button" data-cmpview="slider" aria-pressed="true">Slider</button><button type="button" data-cmpview="side" aria-pressed="false">Side by side</button></div>';
  function compareHtml(name, origUrl, outUrl) {
    const id = "cmp" + ++cmpN, img = (u) => `<image href="${esc(u)}" x="0" y="0" width="400" height="300" preserveAspectRatio="xMidYMid meet"/>`;
    return `<div class="cmp"><svg class="cmpsvg" viewBox="0 0 400 300" role="img" aria-label="${esc(name)}: original on the left, output on the right"><defs><clipPath id="${id}"><rect class="cmpclip" x="0" y="0" width="200" height="300"/></clipPath></defs><rect class="cmpbg" width="400" height="300"/>${img(outUrl)}<g clip-path="url(#${id})">${img(origUrl)}</g><line class="cmpline" x1="200" y1="0" x2="200" y2="300"/></svg><div class="cmplab"><span>Original</span><span>Output</span></div><input type="range" class="cmprange" min="0" max="100" value="50" aria-label="Comparison position for ${esc(name)}" aria-valuetext="50% original, 50% output"></div>`;
  }
  const changePct = (a, b) => { const d = Math.round(((b - a) / a) * 100); return (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d) + "%"; };
  const metaHtml = (rows) => `<dl class="cmeta kv">${rows.map(([k, v, attr]) => `<div><dt>${esc(k)}</dt><dd${attr || ""}>${v}</dd></div>`).join("")}</dl>`;
  const requestedLine = (o) => (o ? esc(`${o.width} × ${o.height} px · ${o.fit} · ${FORMAT_LABEL[o.format] || o.format}${o.upscale ? " · enlarging allowed" : ""}`) : "");
  function moveSplit(box, pct) {
    const x = Math.max(0, Math.min(100, pct)) * 4, r = $(".cmprange", box);
    $(".cmpclip", box).setAttribute("width", String(x));
    $(".cmpline", box).setAttribute("x1", String(x)); $(".cmpline", box).setAttribute("x2", String(x));
    r.setAttribute("aria-valuetext", `${Math.round(x / 4)}% original, ${100 - Math.round(x / 4)}% output`);
  }
  document.addEventListener("input", (e) => { const r = e.target.closest && e.target.closest(".cmprange"); if (r) moveSplit(r.closest(".cmp"), Number(r.value)); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-cmpview]");
    if (!b) return;
    const fig = b.closest(".fcard");
    fig.dataset.view = b.dataset.cmpview;
    $$("[data-cmpview]", fig).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  });
  let dragBox = null;
  const dragTo = (e) => { const svg = $(".cmpsvg", dragBox), rc = svg.getBoundingClientRect(), r = $(".cmprange", dragBox); r.value = String(Math.round(((e.clientX - rc.left) / rc.width) * 100)); moveSplit(dragBox, Number(r.value)); };
  document.addEventListener("pointerdown", (e) => { const svg = e.target.closest && e.target.closest(".cmpsvg"); if (svg) { dragBox = svg.closest(".cmp"); dragTo(e); } });
  document.addEventListener("pointermove", (e) => { if (dragBox) dragTo(e); });
  ["pointerup", "pointercancel"].forEach((t) => document.addEventListener(t, () => { dragBox = null; }));
  // "Before 427 × 640 px · 86.0 KB": the label on its own line, each fact kept whole when the line wraps.
  const caption = (label, ...facts) => `<span class="lab">${label}</span> ${facts.map((x) => `<span class="nw">${x}</span>`).join(" · ")}`;
  function imgCard(r, f, i) {
    const im = r.images, res = im.partial[i];
    if (!res) return `<figure class="fcard" data-status="waiting"><figcaption><b>${esc(f.name)}</b><span>${im.started ? "resizing in your browser…" : "waiting for the simulated worker"}</span></figcaption></figure>`;
    if (res.status !== "completed") return `<figure class="fcard" data-status="failed"><figcaption><b>${esc(f.name)}</b><span class="ferr">Failed: ${esc(res.error || "unknown error")}. This file is reported and not retried.</span></figcaption></figure>`;
    const pic = (url, alt, label) => `<div class="shot"><div class="frame"><img src="${esc(url)}" alt="${esc(alt)}"></div><small>${label}</small></div>`;
    const rows = [["Original", esc(`${res.inputWidth} × ${res.inputHeight} px · ${fmtBytes(f.size)}`)], ["Output", esc(`${res.width} × ${res.height} px · ${FORMAT_LABEL[im.options.format]} · ${fmtBytes(res.bytes)}`)], ["Size change", esc(`${fmtBytes(f.size)} → ${fmtBytes(res.bytes)}, ${changePct(f.size, res.bytes)}`)], ["Requested", requestedLine(im.options)]];
    return `<figure class="fcard" data-status="completed" data-view="slider">${viewToggle()}${compareHtml(f.name, res.inputUrl, res.url)}<div class="imgs">${pic(res.inputUrl, "Before: " + f.name, caption("Before", `${res.inputWidth} × ${res.inputHeight} px`, esc(fmtBytes(f.size))))}${pic(res.url, "After: " + res.name, caption("After", `${res.width} × ${res.height} px`, FORMAT_LABEL[im.options.format], esc(fmtBytes(res.bytes))))}</div>${metaHtml(rows)}<figcaption><b>${esc(res.name)}</b><a class="dl" href="${esc(res.url)}" download="${esc(res.name)}">Download</a></figcaption></figure>`;
  }
  function renderImages(r) {
    if (r.kind !== "images" || ui.current !== r) return;
    const im = r.images, total = im.files.length, done = im.partial.length;
    $("#img-filesub").textContent = `${total} file${total === 1 ? "" : "s"}`;
    const prog = $("#img-progress");
    prog.max = total; prog.value = done; prog.hidden = !im.started || !!im.summary || im.cleared;
    $("#insp-reqact").innerHTML = reqActHtml(im.options, im.partial, total);
    $("#img-progtext").textContent = im.cleared ? "Cleared: the images were released from this browser. The job record is kept."
      : im.summary ? `Done in your browser: ${im.summary.completed} completed, ${im.summary.failed} failed.`
      : im.started ? `Resizing in your browser: ${done} of ${total} done…` : "Waiting for the simulated worker step…";
    $("#img-grid").innerHTML = im.cleared ? "" : im.files.map((f, i) => imgCard(r, f, i)).join("");
    $("#img-dlall").disabled = !(im.summary && !im.cleared && im.summary.completed > 0);
    $("#img-clear").disabled = !(im.summary && !im.cleared);
  }
  function releaseImages(r) {
    IMG.release(r.images.results.length ? r.images.results : r.images.partial);
  }
  // One anchor click per file, 300 ms apart, so the browser does not collapse them into a single download.
  async function downloadMany(items) {
    for (const x of items) {
      const a = document.createElement("a");
      a.href = x.url; a.download = x.name;
      document.body.appendChild(a); a.click(); a.remove();
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
  $("#img-dlall").onclick = () => { if (ui.current && ui.current.images) downloadMany(ui.current.images.results.filter((x) => x.url).map((x) => ({ url: x.url, name: x.name }))); };
  $("#img-clear").onclick = () => { const r = ui.current; if (r && r.images) { releaseImages(r); r.images.cleared = true; renderImages(r); } };
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return; // going into the back/forward cache: the page may come back and still needs its URLs
    runs.forEach((r) => { if (r.images) releaseImages(r); });
    picked.forEach((p) => URL.revokeObjectURL(p.url));
  });

  // ---- playback ----------------------------------------------------------------
  function stop() { if (ui.timer) clearInterval(ui.timer); ui.timer = null; }
  function setRunning(on) {
    ui.running = on;
    el.run.classList.toggle("loading", on);
    el.run.textContent = on ? "Processing…" : "Process images";
    el.skip.disabled = !on; el.plSkip.disabled = !on;
    $$("[data-scenario]").forEach((b) => (b.disabled = on));
    updateRunButton();
  }
  // Shows every remaining step. A step that starts image processing is not passed until the browser work is done.
  function finish() {
    if (ui.finishP) return ui.finishP;
    ui.finishP = (async () => {
      stop();
      const r = ui.current;
      if (!r) return;
      for (;;) {
        if (r.images && r.images.promise) await r.images.promise; // browser work (and the second half of the engine run) first
        if (ui.pos >= r.steps.length) break;
        showStep(r, ui.pos++);
      }
      r.live = null;
      showFinal(r);
      renderImages(r);
      renderTable();
      setRunning(false);
    })().finally(() => { ui.finishP = null; });
    return ui.finishP;
  }
  function play() {
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ui.timer = setInterval(() => {
      const r = ui.current;
      if (ui.busy) return;
      if (ui.pos >= r.steps.length) { finish(); return; }
      showStep(r, ui.pos++);
    }, reduced ? 150 : 750);
  }
  function begin(r) {
    r.steps = toSteps(r.run, r.kind === "images", 0);
    r.facts = r.kind === "images" ? { id: r.run.jobId, status: "queued", attempts: "0", http: "202" } : finalFacts(r.run);
    r.live = { id: r.facts.id, status: "queued", attempts: "0", http: r.run.response ? String(r.run.response.status) : "direct send" };
    r.pathName = pathFor(r.kind === "images" ? "images" : r.scenario);
    $("#pl-simbadge").hidden = false;
    r.createdAt = Date.now();
    runs.push(r);
    ui.current = r; ui.pos = 0;
    $("#pl-caption").textContent = "";
    renderTable();
    resetInspector(r);
    setRunning(true);
    play();
    $("#exec").scrollIntoView({ block: "nearest" });
  }
  function startScenario(sc) {
    if (inProgress()) return;
    begin({ n: runs.length + 1, kind: "scenario", scenario: sc, run: buildRun(sc), steps: null, facts: null, live: null });
  }
  async function selectRun(n) {
    const r = runs.find((x) => x.n === n);
    if (!r) return;
    if (ui.current === r && inProgress()) return;
    if (inProgress()) await finish();
    ui.current = r; ui.pos = r.steps.length;
    resetInspector(r);
    for (let i = 0; i < r.steps.length; i++) showStep(r, i);
    r.live = null;
    showFinal(r);
    renderImages(r);
    renderTable();
    el.inspector.scrollIntoView({ block: "nearest" });
  }
  el.skip.onclick = finish;
  el.plSkip.onclick = finish;
  $$("[data-scenario]").forEach((b) => (b.onclick = () => startScenario(b.dataset.scenario)));

  // ---- choosing files and options (Runs, left panel) -----------------------------
  const imgIn = $("#img-files");
  const showMsg = (t) => { $("#img-msg").textContent = t || ""; };
  function updateRunButton() {
    const bad = picked.some((p) => p.error);
    el.run.disabled = ui.running || !picked.length || bad;
    $("#run-hint").textContent = ui.running ? "A run is in progress." : !picked.length ? "Add at least one image to start." : bad ? "Remove the files marked with an error to continue." : `Ready: ${picked.length} image${picked.length === 1 ? "" : "s"} to process.`;
  }
  // One thumbnail card per file (shared by the demo form and the Live form): picture, name, size, remove, and its own error.
  function thumbHtml(f, url, error, i, withProgress) {
    return `<li class="thumbcard${error ? " bad" : ""}"><div class="tframe"><img class="thumb" src="${esc(url)}" alt=""><button type="button" class="rm" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></div><span class="fname" title="${esc(f.name)}">${esc(f.name)}</span><span class="fsize">${esc(fmtBytes(f.size))}</span>${error ? `<span class="ferr">${esc(error)}</span>` : ""}${withProgress ? `<progress id="lv-p${i}" value="0" max="1" aria-label="Upload progress for ${esc(f.name)}" hidden></progress>` : ""}</li>`;
  }
  const dropFallback = (list) => $$("img.thumb", list).forEach((im) => im.addEventListener("error", () => { im.hidden = true; im.closest(".tframe").classList.add("noimg"); }));
  const sizeSummary = (files, bad) => (files.length ? `${files.length} image${files.length === 1 ? "" : "s"} · ${fmtBytes(files.reduce((a, f) => a + f.size, 0))}${bad ? ` · ${bad} need${bad === 1 ? "s" : ""} attention` : ""}` : "");
  function renderPicked() {
    $("#img-list").innerHTML = picked.map((p, i) => thumbHtml(p.file, p.url, p.error, i, false)).join("");
    dropFallback($("#img-list"));
    $("#img-summary").textContent = sizeSummary(picked.map((p) => p.file), picked.filter((p) => p.error).length);
    $$("#img-list [data-rm]").forEach((b) => (b.onclick = () => {
      const p = picked[Number(b.dataset.rm)];
      if (!p) return;
      picked.splice(picked.indexOf(p), 1);
      URL.revokeObjectURL(p.url);
      showMsg(""); renderPicked();
    }));
    updateRunButton();
  }
  function addFiles(files) {
    if (!files.length) return;
    if (picked.length + files.length > IMG.LIMITS.maxFiles) {
      showMsg(`You can process up to ${IMG.LIMITS.maxFiles} images at a time. You chose ${picked.length + files.length}, so none of the new files were added.`);
      return;
    }
    showMsg("");
    files.forEach((file) => {
      const problem = IMG.validateFiles([file])[0];
      picked.push({ file, url: URL.createObjectURL(file), error: problem ? problem.error.charAt(0).toUpperCase() + problem.error.slice(1) + "." : "" });
    });
    renderPicked();
  }
  function clearPicked() {
    picked.splice(0).forEach((p) => URL.revokeObjectURL(p.url));
    renderPicked();
  }
  // Both drop zones: Enter or Space opens the picker, a drag highlights, and a stray drop outside a zone never navigates away from the page.
  function wireDropzone(zone, input, onFiles) {
    zone.onclick = () => input.click();
    zone.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, () => zone.classList.remove("over")));
    zone.addEventListener("drop", (e) => { e.preventDefault(); onFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || [])); });
  }
  const dz = $("#dropzone");
  wireDropzone(dz, imgIn, addFiles);
  ["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault(); }));
  imgIn.onchange = () => { const files = Array.from(imgIn.files || []); imgIn.value = ""; addFiles(files); };
  $("#img-preset").onchange = () => { $("#img-custom").hidden = $("#img-preset").value !== "custom"; };
  IMG.supports().then((s) => {
    if (s.webpEncode) return;
    $("#img-webp").disabled = true;
    $("#img-webpnote").hidden = false;
  });
  function readImgOptions() {
    const preset = $("#img-preset").value;
    const [w, h] = preset === "custom" ? [Number($("#img-w").value), Number($("#img-h").value)] : preset.split("x").map(Number);
    const ok = (v) => Number.isInteger(v) && v >= IMG.LIMITS.minDim && v <= IMG.LIMITS.maxDim;
    if (!ok(w) || !ok(h)) { showMsg(`Width and height must be whole numbers from ${IMG.LIMITS.minDim} to ${IMG.LIMITS.maxDim}.`); return null; }
    return { width: w, height: h, format: $("#img-format").value, fit: $("#img-fit").value, upscale: $("#img-upscale").checked };
  }
  function startImageJob() {
    if (inProgress() || !picked.length || picked.some((p) => p.error)) return;
    const options = readImgOptions();
    if (!options) return;
    const blobs = picked.map((p) => p.file);
    const run = buildImageRun(blobs, options);
    if (run.response.status !== 202) { showMsg(`The simulated API refused this job (${run.response.body.message}), so nothing was processed.`); return; }
    showMsg("");
    const images = { files: blobs.map((f) => ({ name: f.name, size: f.size })), blobs, options, partial: [], results: [], summary: null, started: false, cleared: false, promise: null };
    clearPicked();
    begin({ n: runs.length + 1, kind: "images", scenario: "images", run, steps: null, facts: null, live: null, images });
  }
  el.run.onclick = startImageJob;
  // Leaving transition to the case study: fade the page out for 280 ms, then follow the link. Skipped under reduced motion;
  // a modified click (new tab) and any failure of this script leave the plain link working.
  const caseLink = $("#nav-casestudy");
  if (caseLink && !story) {
    caseLink.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      e.preventDefault();
      document.documentElement.classList.add("leaving");
      setTimeout(() => { location.href = caseLink.href; }, 280);
    });
    window.addEventListener("pageshow", () => document.documentElement.classList.remove("leaving")); // back button: the page may come from the cache
  }

  // ---- results: first-deployment timeline and findings (every value from evidence/*.md) --
  const EV = "evidence.html#";
  const TIMELINE = [
    { tm: "before 18:42", tt: "Deploy", tx: "terraform apply: 51 resources added.", f: "01-terraform-apply.md" },
    { tm: "18:42", tt: "Live pass 1", tx: "403 / 400 / 415 edge controls correct; every submit 500.", f: "02-live-pass-1.md", tone: "bad" },
    { tm: "18:43", tt: "DLQ drill starts", tx: "Corrupt message sent to the queue.", f: "05-dlq-and-alarm.md" },
    { tm: "by 19:02", tt: "Bug 1 fixed", tx: "Trust-policy condition removed; redeployed (1 added, 2 changed, 1 destroyed).", f: "03-submit-500-diagnosis.md", tone: "good" },
    { tm: "19:02", tt: "Live pass 2", tx: "Submit → pending → completed; download link 403.", f: "04-live-pass-2.md", tone: "bad" },
    { tm: "19:04", tt: "Alarm", tx: "Message dead-lettered on receive 4; alarm ALARM 19:04:10.", f: "05-dlq-and-alarm.md" },
    { tm: "19:14", tt: "Pass 3 and teardown", tx: "Bug 2 fixed, download 200; 51 destroyed by 19:25, 0 leftovers.", f: "09-teardown.md", tone: "good" },
  ];
  $("#timeline").innerHTML = TIMELINE.map((t) => `<li class="${t.tone || ""}"><span class="tm">${esc(t.tm)}</span><span class="tt">${esc(t.tt)}</span>${esc(t.tx)} <a href="${EV}${esc(t.f.replace(/\.md$/, ""))}">${esc(t.f.slice(0, 2))} →</a></li>`).join("");
  const FINDINGS = [
    ["202", "on a valid submit, job id returned; 403 without the key, 400 on a schema violation, 415 on the wrong content type"],
    ["≈21 s", "from submit to completed, polling every 3 s (queue batching window, cold start, 1 s of work)"],
    ["59 jobs", "completed on AWS, all on the first attempt; 15 parallel submits all accepted"],
    ["3 → DLQ", "corrupt message received at 18:44, 18:50, 18:56 (360 s apart), dead-lettered on the fourth receive"],
    ["19:04:10", "dlq-messages alarm in ALARM, about two minutes after the message was dead-lettered; the worker-error alarm stayed OK because failures are reported, not thrown"],
    ["sha256 =", "download through the signed link identical to the S3 object; a tampered signature refused with 403"],
    ["0 left", "twelve independent read-only checks after destroy found nothing; credit balance 120.00 before and after"],
  ];
  $("#findings tbody").innerHTML = FINDINGS.map(([n, t]) => `<tr><td>${esc(n)}</td><td>${esc(t)}</td></tr>`).join("");

  // ---- Live mode: Cognito sign-in, uploads, jobs from the real API (the client is live.js) ----
  const lv = { cfg: null, mode: "sim", rows: [], local: [], selected: null, sig: "", timer: null, retry: null, busy: false, msg: "", up: null, upFailed: null, loaded: false, loading: false, refreshing: false, updatedAt: 0 };
  const liveMode = () => lv.mode === "live";
  const liveSession = () => (lv.cfg ? LIVE.getSession() : null);

  function paintMode() {
    const session = liveSession(), live = liveMode();
    $("#signout").hidden = !(currentView === "runs" && live && session);
    // The sidebar follows the selected mode, so it never contradicts the mode bar on Runs (Live AWS is a mode choice that persists across views).
    $("#env-led").className = "led " + (live && session ? "real" : "sim");
    $("#env-title").textContent = live ? "Live AWS" : "Browser demo";
    $("#env-sub").textContent = live ? (session ? "Signed in · jobs run on AWS" : "Signed out · nothing sent to AWS") : "No AWS connection";
    // One caption line under the mode switch; signed out must not read as connected.
    $("#modestate-text").textContent = !live ? "Runs in your browser. No account, nothing uploaded." : session ? "Real processing on AWS. Signed in as " + (session.email || "your account") + "." : "Real processing on AWS. Sign in or create a 24-hour test account.";
  }

  function say(text, retry) {
    lv.msg = text || "";
    $("#live-msg").hidden = !text;
    $("#live-msg-text").textContent = text || "";
    lv.retry = retry || null;
    $("#live-retry").hidden = !retry;
  }
  // 401 after the one refresh attempt: the session is gone. Network failure: offer a manual retry.
  function fail(r, retry) {
    if (r.status === 401) { LIVE.clearSession(); render(); }
    say(LIVE.errorMessage(r), r.status === 0 ? retry : null);
  }

  function setMode(mode) {
    lv.mode = mode;
    $$("#modeswitch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    say("");
    render();
    if (liveMode() && liveSession()) refreshList(); else stopPolling();
  }
  function render() {
    const live = liveMode(), session = liveSession();
    $("#newjob").hidden = live;
    $("#sim-runs").hidden = live || !runs.length;
    $("#inspector").hidden = live || !ui.current;
    $("#live-signin").hidden = !(live && !session);
    $("#live-newjob").hidden = !(live && session);
    $("#live-runs").hidden = !live;
    $("#live-inspector").hidden = !(live && session && lv.selected);
    $("#skip").hidden = live;
    if (live) renderLiveTable(); else renderTable();
    if (live && !session) stopPolling();
    paintMode();
    paintLiveTools();
    paintExec();
  }

  function pill(row) {
    const stale = LIVE.isStale(row, Date.now());
    return `<span class="pill ${stale ? "stale" : esc(row.status)}"${stale ? ' title="Not picked up. The submit may have failed after registration."' : ""}>${stale ? "stale" : esc(row.status)}</span>`;
  }
  const liveFilesText = (r) => `${r.completedCount ?? 0}/${r.fileCount ?? "—"}` + (r.failedCount ? ` · ${r.failedCount} failed` : "");
  function renderLiveTable() {
    const rows = lv.rows, tb = $("#live-table tbody"), session = liveSession();
    paintLayout();
    el.count.textContent = session ? String(rows.length) : "0";
    const items = session ? histItems(rows.map((r) => ({ r, id: r.jobId, status: r.status, ts: Date.parse(r.createdAt) || 0 }))) : [];
    tb.innerHTML = items.map(({ r }) => `<tr data-job="${esc(r.jobId)}" aria-selected="${lv.selected === r.jobId}" tabindex="0"><td class="c-status" data-label="Status">${pill(r)}</td><td class="c-id" data-label="Job" title="${esc(r.jobId)}">${esc(shortId(r.jobId))}</td><td class="c-files" data-label="Files">${esc(liveFilesText(r))}</td><td class="c-attempts num" data-label="Attempts">${esc(r.attempts ?? 0)}</td>${timeCell(Date.parse(r.createdAt))}</tr>`).join("");
    $$("tr[data-job]", tb).forEach((tr) => {
      const open = () => selectJob(tr.dataset.job);
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
    if (!liveMode()) return;
    $("#live-runs").hidden = !items.length;
    const st = session && lv.loading && !rows.length ? { loading: true } : session && rows.length ? noMatch() : {};
    paintHist(Object.assign({ total: session ? rows.length : 0, shown: items.length }, st));
  }

  // The "Updated Ns ago" note and the Refresh button (Live, signed in).
  function paintUpdated() {
    const s = Math.max(0, Math.round((Date.now() - lv.updatedAt) / 1000));
    $("#live-updated").textContent = lv.refreshing && !lv.updatedAt ? "Loading…" : lv.updatedAt ? `Updated ${s < 60 ? s + "s" : relTime(lv.updatedAt).replace(" ago", "")} ago` + (lv.timer ? " · checking every 3 s" : "") : "";
  }
  function paintLiveTools() {
    $("#live-tools").hidden = !(liveMode() && liveSession());
    $("#live-refresh").setAttribute("aria-busy", String(lv.refreshing));
    paintUpdated();
  }

  // Polling: every 3 s while a row is queued or processing; a queued row older than 10 minutes is stale and stops it.
  function stopPolling() { if (lv.timer) clearTimeout(lv.timer); lv.timer = null; }
  function schedulePoll() {
    stopPolling();
    if (liveMode() && liveSession() && LIVE.needsPolling(lv.rows, Date.now())) lv.timer = setTimeout(refreshList, 3000);
  }
  async function refreshList() {
    stopPolling();
    lv.refreshing = true;
    if (!lv.loaded) { lv.loading = true; renderLiveTable(); }
    paintLiveTools();
    try { await fetchList(); } finally {
      lv.refreshing = false; lv.loading = false; lv.loaded = true;
      if (liveMode()) renderLiveTable();
      paintLiveTools();
    }
  }
  async function fetchList() {
    const r = await LIVE.listJobs(lv.cfg);
    if (!liveMode()) return;
    if (r.status !== 200) { fail(r, refreshList); return; }
    if (!liveSession()) return;
    lv.updatedAt = Date.now();
    say("");
    const listed = r.body.jobs || [];
    lv.rows = LIVE.mergeJobs(lv.local, listed);
    lv.local = lv.local.filter((x) => !listed.some((j) => j.jobId === x.jobId)); // the list has caught up with these
    renderLiveTable();
    const sel = lv.rows.find((x) => x.jobId === lv.selected);
    if (sel && (!LIVE.isTerminal(sel.status) || !lv.sig.startsWith(sel.status + "|"))) await loadDetail(lv.selected);
    paintExec();
    schedulePoll();
  }

  // The execution stepper in Live mode: driven only by real upload progress and the job status the API returned.
  function liveExecCfg() {
    const base = {};
    if (lv.up) {
      const n = lv.up.total, fs = `file${n === 1 ? "" : "s"}`;
      return Object.assign(base, lv.up.uploaded
        ? { phase: 1, subs: { 0: `${n} of ${n} ${fs}` }, text: "Files uploaded. Creating the job…" }
        : { phase: 0, subs: { 0: `${lv.up.done} of ${n} ${fs} sent` }, text: `Uploading ${n} ${fs} straight to the private bucket…` });
    }
    if (lv.upFailed !== null) return Object.assign(base, { phase: lv.upFailed, failAt: true, text: (lv.upFailed === 0 ? "Upload failed. Nothing was queued. " : "The files were uploaded but the job was not created. ") + lv.msg });
    const row = lv.rows.find((x) => x.jobId === lv.selected);
    if (!row) return Object.assign(base, { phase: -1, text: liveSession() ? "No job selected. Start a new job, or pick one from the history." : "Signed out. Sign in to run images on AWS." });
    const counts = `${row.completedCount ?? 0} of ${row.fileCount ?? "?"} files`;
    const done = { 0: "uploaded" };
    if (row.status === "queued") return Object.assign(base, { phase: 1, subs: done, text: LIVE.isStale(row, Date.now()) ? "Queued, but no worker has picked this job up for over 10 minutes (stale)." : "Queued. The job is waiting for the worker." });
    if (row.status === "processing") return Object.assign(base, { phase: 2, subs: Object.assign({}, done, { 2: `attempt ${row.attempts ?? 1}` }), text: LIVE.isStale(row, Date.now()) ? "Processing, but there has been no update for a long time (stale)." : "Processing. The worker has the job." });
    if (row.status === "completed") return Object.assign(base, { phase: 3, final: "completed", subs: Object.assign({}, done, { 3: counts }), text: `Completed. ${counts} done.` });
    if (row.status === "failed") return Object.assign(base, { phase: 3, final: "failed", subs: Object.assign({}, done, { 3: counts }), text: `Failed. ${counts} completed.` });
    return Object.assign(base, { phase: -1, text: "Status: " + row.status });
  }
  function paintExec() { paintLayout(); paintStepper(liveMode() ? liveExecCfg() : execDemo); }

  // ---- inspector ----
  function paintLive(status) {
    $$("#live-flow [data-node]").forEach((n) => n.classList.remove("active", "good", "bad"));
    LIVE.pipelineFor(status).forEach((p) => $$(`#live-flow [data-node="${p.node}"]`).forEach((n) => n.classList.add(p.tone || "active")));
  }
  function selectJob(jobId) {
    lv.selected = jobId; lv.sig = ""; lv.upFailed = null;
    $("#live-inspector").hidden = false;
    $("#lv-grid").innerHTML = '<div class="fcard skelcard" aria-hidden="true"><span class="skel"></span><span class="skel"></span></div><div class="fcard skelcard" aria-hidden="true"><span class="skel"></span><span class="skel"></span></div>';
    $("#lv-reqact").innerHTML = "";
    $("#lv-fail").hidden = true;
    $("#lv-dlall").disabled = true;
    $("#lv-json").textContent = "…";
    renderLiveTable();
    paintExec();
    loadDetail(jobId, true);
  }
  const downloadable = (files) => (files || []).filter((f) => f.status === "completed" && LIVE.safeUrl(f.downloadUrl));
  async function loadDetail(jobId, scroll) {
    const r = await LIVE.getJob(lv.cfg, jobId);
    if (jobId !== lv.selected) return;
    $("#lv-http").textContent = String(r.status);
    if (r.status !== 200) { fail(r, () => loadDetail(jobId)); return; }
    const j = r.body;
    $("#lv-title").textContent = jobId.slice(0, 8) + "…";
    $("#lv-id").textContent = j.jobId;
    $("#lv-shortid").textContent = jobLabel(j.jobId);
    $("#lv-status").innerHTML = pill(j);
    $("#lv-attempts").textContent = String(j.attempts ?? 0);
    const made = Date.parse(j.createdAt);
    $("#lv-created").textContent = Number.isFinite(made) ? `${absTime(made)} (${relTime(made)})` : "—";
    paintLive(j.status);
    $("#lv-badge").textContent = LIVE.LABELS.badge;
    $("#lv-statement").textContent = LIVE.LABELS.statement;
    $("#lv-json").textContent = JSON.stringify(j, null, 2);
    $("#lv-json").classList.remove("idle");
    const manifest = LIVE.safeUrl(j.manifestUrl);
    $("#lv-manifest").innerHTML = manifest ? `<a href="${esc(manifest)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open manifest</a>` : "Not available yet.";
    if (j.status === "failed" && j.error) say("Job failed: " + j.error);
    $("#lv-fail").hidden = j.status !== "failed";
    $("#lv-fail").textContent = j.status === "failed" ? "Failed: " + (j.error || "the job did not complete.") : "";
    $("#lv-reqact").innerHTML = reqActHtml(j.options, j.files || [], (j.files || []).length);
    $("#lv-dlall").disabled = !downloadable(j.files).length;
    // Re-render the grid only when something visible changed: the signed image links differ on every call.
    const sig = j.status + "|" + (j.files || []).map((f) => f.status + f.outputKey).join(",");
    if (sig !== lv.sig) { lv.sig = sig; renderFiles(j); }
    const row = lv.rows.find((x) => x.jobId === jobId);
    if (row && row.status !== j.status) { row.status = j.status; row.attempts = j.attempts; row.updatedAt = j.updatedAt; renderLiveTable(); }
    paintExec();
    if (scroll) $("#live-inspector").scrollIntoView({ block: "nearest" });
  }
  function renderFiles(j) {
    const files = j.files || [];
    $("#lv-filesub").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
    $("#lv-grid").innerHTML = files.map((f) => {
      const pre = LIVE.safeUrl(f.previewUrl), out = LIVE.safeUrl(f.downloadUrl);
      const shot = (url, alt, label) => `<div class="shot"><div class="frame">${url ? `<img src="${esc(url)}" alt="${esc(alt)}"${alt.startsWith("Original") ? " data-orig" : ""} referrerpolicy="no-referrer">` : '<span class="nopic">No preview</span>'}</div><small>${label}</small></div>`;
      const done = f.status === "completed";
      const after = done ? shot(out, "Output: " + f.name, caption("Output", `${esc(f.width)} × ${esc(f.height)} px`, esc(fmtBytes(f.bytes))))
        : f.status === "failed" ? `<div class="shot"><div class="frame"><span class="nopic ferr">${esc(f.error || "failed")}</span></div><small><span class="lab">No output</span></small></div>`
        : '<div class="shot"><div class="frame"><span class="nopic">Waiting for the worker</span></div><small><span class="lab">Output</span></small></div>';
      const cmp = done && pre && out ? viewToggle() + compareHtml(f.name, pre, out) : "";
      const rows = done ? [["Original", pre ? "loading…" : "not available", " data-origdims"], ["Output", esc(`${f.width} × ${f.height} px · ${fmtBytes(f.bytes)}`)], ["Requested", requestedLine(j.options)]] : [];
      return `<figure class="fcard" data-status="${esc(f.status)}"${cmp ? ' data-view="slider"' : ""}>${cmp}<div class="imgs">${shot(pre, "Original: " + f.name, '<span class="lab">Original</span>')}${after}</div>${rows.length ? metaHtml(rows) : ""}<figcaption><b>${esc(f.name)}</b>${done && out ? `<a class="dl" href="${esc(out)}" download="${esc(f.name)}" rel="noopener noreferrer" referrerpolicy="no-referrer">Download</a>` : ""}</figcaption></figure>`;
    }).join("");
  }
  // The original's pixel size is only known once its signed preview has loaded in the browser; the uploaded file size is not returned, so it is omitted.
  $("#lv-grid").addEventListener("load", (e) => {
    const im = e.target;
    if (!im.matches || !im.matches("img[data-orig]")) return;
    const cell = $("[data-origdims]", im.closest(".fcard"));
    if (cell) cell.textContent = `${im.naturalWidth} × ${im.naturalHeight} px`;
  }, true);
  $("#lv-dlall").onclick = async () => {
    // Fresh links first: the signed ones in the grid last only five minutes.
    const r = await LIVE.getJob(lv.cfg, lv.selected);
    if (r.status !== 200) { fail(r, null); return; }
    downloadMany(downloadable(r.body.files).map((f) => ({ url: LIVE.safeUrl(f.downloadUrl), name: f.name })));
  };

  // ---- new job: pick, check, upload, create ----
  const lvIn = $("#lv-files"), lvUrls = [];
  let lvKept = []; // the files the list currently shows
  const chosen = () => Array.from(lvIn.files || []);
  const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  const setLiveFiles = (list) => { const dt = new DataTransfer(); list.forEach((f) => dt.items.add(f)); lvIn.files = dt.files; };
  const ownProblem = (f) => { const m = LIVE.checkFiles([f])[0] || ""; return m ? m.slice(m.lastIndexOf(": ") + 2) : ""; };
  function updateLiveButton() {
    const files = chosen(), bad = !files.length || LIVE.checkFiles(files).length > 0;
    $("#lv-go").disabled = lv.busy || bad;
    $("#lv-go-hint").textContent = lv.busy ? "Uploading to a private bucket, then queuing the job." : !files.length ? "Add at least one image to start." : files.length > LIVE.MAX_FILES ? `Remove images until ${LIVE.MAX_FILES} or fewer are left.` : bad ? "Remove the files marked with an error to continue." : `Ready: ${files.length} image${files.length === 1 ? "" : "s"} to upload.`;
  }
  function showChosen() {
    lvUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const files = chosen(), problems = files.length ? LIVE.checkFiles(files) : [];
    const own = files.map(ownProblem);
    lvKept = files;
    $("#lv-filelist").innerHTML = files.map((f, i) => { const u = URL.createObjectURL(f); lvUrls.push(u); return thumbHtml(f, u, own[i], i, true); }).join("");
    dropFallback($("#lv-filelist"));
    $$("#lv-filelist [data-rm]").forEach((b) => (b.onclick = () => { setLiveFiles(chosen().filter((_, k) => k !== Number(b.dataset.rm))); showChosen(); }));
    $("#lv-summary").textContent = sizeSummary(files, own.filter(Boolean).length);
    $("#lv-filemsg").textContent = files.length > LIVE.MAX_FILES ? problems.join(" ") : "";
    updateLiveButton();
  }
  function readOptions() {
    const preset = $("#lv-preset").value;
    const [w, h] = preset === "custom" ? [Number($("#lv-w").value), Number($("#lv-h").value)] : preset.split("x").map(Number);
    if (!LIVE.dimensionOk(w) || !LIVE.dimensionOk(h)) return null;
    return { width: w, height: h, format: $("#lv-format").value, fit: $("#lv-fit").value, upscale: $("#lv-upscale").checked };
  }
  async function uploadAndProcess() {
    if (lv.busy) return;
    const files = chosen(), problems = LIVE.checkFiles(files), options = readOptions();
    if (problems.length) { $("#lv-filemsg").textContent = problems.join(" "); return; }
    if (!options) { $("#lv-filemsg").textContent = "Width and height must be whole numbers from 16 to 4096."; return; }
    $("#lv-filemsg").textContent = "";
    say("");
    const go = $("#lv-go"), sent = new Set();
    lv.busy = true; lv.upFailed = null; lv.up = { total: files.length, done: 0, uploaded: false };
    go.disabled = true; go.classList.add("loading"); go.textContent = "Uploading…";
    $$("#lv-filelist progress").forEach((p) => { p.hidden = false; p.value = 0; });
    $$("#lv-filelist [data-rm]").forEach((b) => (b.disabled = true));
    updateLiveButton(); paintExec();
    try {
      const keys = await LIVE.uploadFiles(lv.cfg, files, (i, loaded, total) => {
        const p = $("#lv-p" + i);
        if (p && total) p.value = loaded / total;
        if (total && loaded >= total && !sent.has(i)) { sent.add(i); lv.up.done = sent.size; paintExec(); }
      });
      lv.up.uploaded = true; go.textContent = "Creating job…"; paintExec();
      const r = await LIVE.createJob(lv.cfg, keys, options);
      if (r.status !== 202) { lv.upFailed = 1; fail(r, uploadAndProcess); return; }
      const now = new Date().toISOString();
      const row = { jobId: r.body.jobId, status: r.body.status || "queued", task: "resize", createdAt: now, updatedAt: now, attempts: 0, fileCount: files.length, completedCount: 0, failedCount: 0 };
      lv.local.push(row);
      lv.rows = LIVE.mergeJobs(lv.local, lv.rows);
      lvIn.value = ""; showChosen();
      lv.up = null;
      selectJob(row.jobId);
      schedulePoll();
    } catch (e) {
      lv.upFailed = lv.up && lv.up.uploaded ? 1 : 0;
      fail({ status: e.status || 0, body: e.body || null }, uploadAndProcess);
    } finally {
      lv.busy = false; lv.up = null;
      go.classList.remove("loading"); go.textContent = "Upload and process";
      updateLiveButton(); paintExec();
    }
  }

  // Picker and drop both end here: add to what is already chosen (no duplicates), write the list back to the file input, redraw.
  lvIn.onchange = () => {
    if (lv.busy) { setLiveFiles(lvKept); return; }
    const seen = new Set(lvKept.map(fileKey));
    setLiveFiles(lvKept.concat(chosen().filter((f) => !seen.has(fileKey(f)))));
    showChosen();
  };
  wireDropzone($("#lv-dropzone"), lvIn, (files) => {
    if (lv.busy || !files.length) return;
    setLiveFiles(files); // a drop feeds the real file input, then takes the same path as the picker
    lvIn.dispatchEvent(new Event("change", { bubbles: true }));
  });
  $("#lv-preset").onchange = () => { $("#lv-custom").hidden = $("#lv-preset").value !== "custom"; };
  $("#lv-go").onclick = uploadAndProcess;
  $("#live-retry").onclick = () => { const f = lv.retry; say(""); if (f) f(); };
  $("#live-refresh").onclick = () => { if (!lv.refreshing) refreshList(); };
  $("#lv-signin").onclick = () => LIVE.beginSignIn(lv.cfg);
  $("#lv-signup").onclick = () => LIVE.beginSignUp(lv.cfg);
  $("#signout").onclick = () => LIVE.signOut(lv.cfg);
  $$("#modeswitch button").forEach((b) => (b.onclick = () => { if (!b.disabled) setMode(b.dataset.mode); }));
  // One-second tick: relative times in the history ("2 min ago") and the "Updated Ns ago" note stay current.
  setInterval(() => {
    $$("[data-ts]").forEach((n) => { n.textContent = relTime(Number(n.dataset.ts)); });
    if (liveMode()) paintUpdated();
  }, 1000);

  // Live is available only when config.json loads (never under file://); otherwise the page stays browser-demo-only.
  (async function initLive() {
    lv.cfg = await LIVE.loadConfig();
    if (!lv.cfg) return;
    LIVE.applyCsp(lv.cfg);
    $("#mode-live").disabled = false;
    $("#mode-live").removeAttribute("title");
    render();
    const cb = await LIVE.handleCallback(lv.cfg, location);
    if (cb.handled) {
      goto("runs");
      setMode("live");
      if (!cb.ok) say(cb.error);
    } else if (LIVE.getSession() && (location.hash === "#runs" || (story && currentView === "runs"))) setMode("live");
  })();

  renderTable();
  route();

  if (story) {
    // Links into and out of the story: "Try the Application" (and the skip link) go to the console, every a[href="#story"] goes back up.
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a");
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.getAttribute("href") === "#story") {
        e.preventDefault();
        sidebar.classList.remove("open");
        $("#menubtn").setAttribute("aria-expanded", "false");
        if (location.hash !== "#story") history.pushState(null, "", "#story");
        window.scrollTo({ top: 0, behavior: scrollBehavior() });
      } else if (a.id === "story-try" || a.classList.contains("skip")) {
        e.preventDefault();
        goto("runs");
      }
    });
    // A hash that names a console view lands on the console. The story above it grows a little when fonts and the road settle,
    // so land once more after load unless the visitor has already started scrolling.
    if (!/^(#(story|overview|stop-\d\d))?$/.test(location.hash)) {
      let touched = false;
      ["wheel", "touchstart", "keydown", "pointerdown"].forEach((t) => window.addEventListener(t, () => { touched = true; }, { once: true, passive: true }));
      const again = () => { if (!touched) scrollToApp(); };
      window.addEventListener("load", again);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(again);
    }
  }
})();
