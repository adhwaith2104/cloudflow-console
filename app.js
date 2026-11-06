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

  // The aria-hidden, inert copies (run inspector, live inspector) and the Overview preview are drawn in compact mode.
  AV.render(demoFlow, { mode: "compact", interactive: false, idPrefix: "d" });
  AV.render($("#live-flow"), { mode: "compact", interactive: false, idPrefix: "l" });
  AV.render($("#ov-arch"), { mode: "compact", interactive: false, idPrefix: "o" });
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
  const TITLES = { overview: "Overview", runs: "Runs", architecture: "Architecture", results: "Results" };
  const OLD_ROUTES = { pipeline: "architecture", verification: "results" }; // bookmarks and saved views from earlier builds
  const sidebar = $("#sidebar");
  let currentView = "overview";
  function showView(id) {
    id = OLD_ROUTES[id] || id;
    if (!TITLES[id]) id = "overview";
    $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + id));
    $$("#nav button").forEach((b) => (b.dataset.view === id ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    $("#pagetitle").textContent = TITLES[id];
    document.title = TITLES[id] + " · CloudFlow";
    currentView = id;
    paintBadge();
    $("#top-newjob").hidden = id === "results";
    sidebar.classList.remove("open");
    $("#menubtn").setAttribute("aria-expanded", "false");
    store.set("cloudflow-view", id);
    window.scrollTo({ top: 0 });
  }
  function route() {
    const h = location.hash.replace(/^#/, "");
    if (OLD_ROUTES[h]) { location.replace("#" + OLD_ROUTES[h]); return; }
    showView(h || store.get("cloudflow-view") || "overview");
  }
  $$("#nav button").forEach((b) => (b.onclick = () => (location.hash = "#" + b.dataset.view)));
  window.addEventListener("hashchange", route);
  $("#menubtn").onclick = () => {
    const open = sidebar.classList.toggle("open");
    $("#menubtn").setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => $("#nav button").focus(), 50);
  };
  document.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (/^[1-4]$/.test(e.key)) location.hash = "#" + Object.keys(TITLES)[Number(e.key) - 1];
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
    jcId: $("#jc-id"), jcStatus: $("#jc-status"), jcAttempts: $("#jc-attempts"), jcHttp: $("#jc-http"),
    inspector: $("#inspector"), inspTitle: $("#insp-title"), inspSvc: $("#insp-svc"), tbody: $("#runs-table tbody"), count: $("#runs-count"),
  };
  const API_HEADERS = { "x-api-key": "sim-api-key", "content-type": "application/json" };
  const DEMO_BODY = JSON.stringify({ task: "echo", payload: { hello: "world", n: 3 } });
  const inProgress = () => !!(ui.timer || ui.finishP);
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
  const FORMAT_LABEL = { jpeg: "JPEG", png: "PNG", webp: "WebP" };
  const picked = []; // chosen files: { file, url, error }

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
  const typeName = (r) => (r.kind === "images" ? "Images" : "Scenario");
  const filesCell = (r) => {
    if (r.kind !== "images") return SCENARIO_NAME[r.scenario];
    const im = r.images, n = im.files.length, base = `${n} image${n === 1 ? "" : "s"}`;
    return im.summary ? `${base} · ${im.summary.completed} ok, ${im.summary.failed} failed` : base;
  };

  function renderTable() {
    el.count.textContent = String(runs.length);
    if (!runs.length) { el.tbody.innerHTML = '<tr class="empty"><td colspan="8">No runs yet. Choose images and press Process images.</td></tr>'; return; }
    el.tbody.innerHTML = runs.slice().reverse().map((r) => {
      const live = r.live || r.facts;
      const ev = r.run.world.events;
      return `<tr data-run="${r.n}" aria-selected="${!!ui.current && ui.current.n === r.n}" tabindex="0"><td class="num">${r.n}</td><td>${typeName(r)}</td><td>${esc(filesCell(r))}</td><td><span class="pill ${esc(live.status.replace(/\s.*/, ""))}">${esc(live.status)}</span></td><td class="num">${esc(live.attempts)}</td><td class="num">${esc(live.http)}</td><td class="num">${esc(ev[0].clock)}</td><td class="num">${r.live ? "…" : esc(ev[ev.length - 1].clock)}</td></tr>`;
    }).join("");
    $$("tr[data-run]", el.tbody).forEach((tr) => {
      const open = () => selectRun(Number(tr.dataset.run));
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
  }

  function renderStages(r, current) {
    const list = stageList(r);
    const idx = list.indexOf(current);
    el.stages.innerHTML = list.map((s, i) => {
      const cls = i < idx ? "done" : i === idx ? "now " + (s === "completed" ? "good" : /failed|dead/.test(s) ? "bad" : "") : "";
      return `<li class="${cls}">${esc(s)}</li>`;
    }).join("");
  }
  function setStatusPill(text) {
    const cls = /dead/.test(text) ? "dead" : /no record/.test(text) ? "failed" : text;
    el.jcStatus.innerHTML = `<span class="pill ${esc(cls)}">${esc(text)}</span>`;
  }
  function resetInspector(r) {
    const img = r.kind === "images";
    el.inspector.hidden = false;
    el.inspTitle.textContent = `run #${r.n} · ${img ? "Images" : SCENARIO_NAME[r.scenario]}`;
    $("#insp-badge").textContent = img ? "Simulated pipeline · real browser resize" : "Simulated";
    $("#img-section").hidden = !img;
    el.inspSvc.textContent = "";
    el.narration.innerHTML = "";
    el.statusJson.textContent = "…"; el.resultJson.textContent = "…";
    el.statusJson.classList.add("idle"); el.resultJson.classList.add("idle");
    el.jcId.textContent = r.facts.id;
    setStatusPill(r.scenario === "poison" || r.run.response.status === 202 ? "queued" : "rejected");
    el.jcAttempts.textContent = "0";
    el.jcHttp.textContent = r.run.response ? String(r.run.response.status) : "direct send";
    renderStages(r, r.scenario === "poison" || r.run.response.status === 202 ? "queued" : null);
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
    if (r.live) { const row = $(`tr[data-run="${r.n}"]`, el.tbody); if (row) { row.children[3].innerHTML = `<span class="pill running">${esc(r.live.status)}</span>`; row.children[4].textContent = r.live.attempts; row.children[5].textContent = r.live.http; } }
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
    el.jcId.textContent = r.facts.id; setStatusPill(r.facts.status); el.jcAttempts.textContent = r.facts.attempts; el.jcHttp.textContent = r.facts.http;
    renderStages(r, r.facts.status === "completed" ? "completed" : r.facts.status === "dead-lettered" ? "dead-letter" : r.facts.status === "failed" ? "failed" : null);
    el.statusJson.classList.remove("idle"); el.resultJson.classList.remove("idle");
    el.log.textContent = w.events.map((e) => `${e.clock}  ${e.actor.padEnd(10)} ${e.text}`).join("\n");
  }

  // ---- real image processing (imaging.js), started at the simulated worker step ----
  function startImaging(r) {
    const im = r.images;
    if (im.started) return;
    im.started = true; ui.busy = true;
    renderImages(r);
    im.promise = (async () => {
      try {
        const out = await IMG.processFiles(im.blobs, im.options, (done, total, res) => { im.partial.push(res); renderImages(r); });
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
  function imgCard(r, f, i) {
    const im = r.images, res = im.partial[i];
    if (!res) return `<figure class="fcard" data-status="waiting"><figcaption><b>${esc(f.name)}</b><span>${im.started ? "resizing in your browser…" : "waiting for the simulated worker"}</span></figcaption></figure>`;
    if (res.status !== "completed") return `<figure class="fcard" data-status="failed"><figcaption><b>${esc(f.name)}</b><span class="ferr">Failed: ${esc(res.error || "unknown error")}. This file is reported and not retried.</span></figcaption></figure>`;
    const pic = (url, alt, label) => `<div><img src="${esc(url)}" alt="${esc(alt)}"><small>${label}</small></div>`;
    return `<figure class="fcard" data-status="completed"><div class="imgs">${pic(res.inputUrl, "Before: " + f.name, `Before · ${res.inputWidth} × ${res.inputHeight} px · ${esc(fmtBytes(f.size))}`)}${pic(res.url, "After: " + res.name, `After · ${res.width} × ${res.height} px · ${FORMAT_LABEL[im.options.format]} · ${esc(fmtBytes(res.bytes))}`)}</div><figcaption><b>${esc(res.name)}</b><a class="dl" href="${esc(res.url)}" download="${esc(res.name)}">Download</a></figcaption></figure>`;
  }
  function renderImages(r) {
    if (r.kind !== "images" || ui.current !== r) return;
    const im = r.images, total = im.files.length, done = im.partial.length;
    $("#img-filesub").textContent = `${total} file${total === 1 ? "" : "s"}`;
    const prog = $("#img-progress");
    prog.max = total; prog.value = done; prog.hidden = !im.started || !!im.summary || im.cleared;
    $("#img-progtext").textContent = im.cleared ? "Cleared: the images were released from this browser. The job record below is kept."
      : im.summary ? `Done in your browser: ${im.summary.completed} completed, ${im.summary.failed} failed.`
      : im.started ? `Resizing in your browser: ${done} of ${total} done…` : "Waiting for the simulated worker step…";
    $("#img-grid").innerHTML = im.cleared ? "" : im.files.map((f, i) => imgCard(r, f, i)).join("");
    $("#img-dlall").disabled = !(im.summary && !im.cleared && im.summary.completed > 0);
    $("#img-clear").disabled = !(im.summary && !im.cleared);
  }
  function releaseImages(r) {
    IMG.release(r.images.results.length ? r.images.results : r.images.partial);
  }
  async function downloadAll(r) {
    for (const x of r.images.results) {
      if (!x.url) continue;
      const a = document.createElement("a");
      a.href = x.url; a.download = x.name;
      document.body.appendChild(a); a.click(); a.remove();
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
  $("#img-dlall").onclick = () => { if (ui.current && ui.current.images) downloadAll(ui.current); };
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
    runs.push(r);
    ui.current = r; ui.pos = 0;
    $("#pl-caption").textContent = "";
    renderTable();
    resetInspector(r);
    setRunning(true);
    play();
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
    el.run.disabled = ui.running || !picked.length || picked.some((p) => p.error);
  }
  function renderPicked() {
    $("#img-list").innerHTML = picked.map((p, i) => `<li><img class="thumb" src="${esc(p.url)}" alt=""><span class="fname">${esc(p.file.name)}</span><span>${esc(fmtBytes(p.file.size))}</span><button type="button" class="btn rm" data-rm="${i}" aria-label="Remove ${esc(p.file.name)}">Remove</button>${p.error ? `<span class="ferr">${esc(p.error)}</span>` : ""}</li>`).join("");
    $$("#img-list img.thumb").forEach((im) => im.addEventListener("error", () => { im.hidden = true; }));
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
  const dz = $("#dropzone");
  dz.onclick = () => imgIn.click();
  dz.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); imgIn.click(); } };
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, () => dz.classList.remove("over")));
  dz.addEventListener("drop", (e) => { e.preventDefault(); addFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || [])); });
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
  function goProcess() {
    location.hash = "#runs";
    setTimeout(() => {
      const panel = liveMode() ? $(liveSession() ? "#live-newjob" : "#live-signin") : $("#newjob");
      panel.scrollIntoView({ block: "start" });
      $(liveMode() ? (liveSession() ? "#lv-files" : "#lv-signin") : "#dropzone").focus();
    }, 60);
  }
  $("#top-newjob").onclick = goProcess;
  $("#ov-process").onclick = goProcess;
  $("#ov-openarch").onclick = () => { location.hash = "#architecture"; };
  $("#ov-arch").onclick = () => { location.hash = "#architecture"; };

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
  const lv = { cfg: null, mode: "sim", rows: [], local: [], selected: null, sig: "", timer: null, retry: null, busy: false };
  const liveMode = () => lv.mode === "live";
  const liveSession = () => (lv.cfg ? LIVE.getSession() : null);
  const shortTime = (iso) => (iso ? String(iso).replace("T", " ").replace(/\.\d+/, "").replace("Z", "") : "—");

  function paintBadge() {
    const badge = $("#topbadge"), session = liveSession();
    const live = currentView === "runs" && liveMode();
    badge.className = "badge " + (currentView === "results" || live ? "real" : "sim");
    badge.textContent = currentView === "results" ? "Verified on AWS" : live ? (session ? "Live · " + session.email : "Live · signed out") : "Browser demo";
    $("#signout").hidden = !(live && session);
    // The sidebar must not claim "No AWS connection" while the visitor is working against the real backend.
    const real = live && !!session;
    $("#env-led").className = "led " + (real ? "real" : "sim");
    $("#env-title").textContent = real ? "Live" : "Browser demo";
    $("#env-sub").textContent = real ? "Approved account, live backend on AWS" : "No AWS connection";
  }

  function say(text, retry) {
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
    $("#sim-runs").hidden = live;
    $("#inspector").hidden = live || !ui.current;
    $("#live-signin").hidden = !(live && !session);
    $("#live-newjob").hidden = !(live && session);
    $("#live-runs").hidden = !live;
    $("#live-cta").hidden = !(lv.cfg && !session && !live);
    $("#live-inspector").hidden = !(live && session && lv.selected);
    if (live) renderLiveTable(); else el.count.textContent = String(runs.length);
    if (live && !session) stopPolling();
    paintBadge();
  }

  function pill(row) {
    const stale = LIVE.isStale(row, Date.now());
    return `<span class="pill ${stale ? "stale" : esc(row.status)}"${stale ? ' title="Not picked up. The submit may have failed after registration."' : ""}>${stale ? "stale" : esc(row.status)}</span>`;
  }
  function renderLiveTable() {
    const rows = lv.rows, tb = $("#live-table tbody");
    el.count.textContent = liveSession() ? String(rows.length) : "0";
    if (!liveSession()) { tb.innerHTML = '<tr class="empty"><td colspan="6">Sign in to see your jobs.</td></tr>'; return; }
    if (!rows.length) { tb.innerHTML = '<tr class="empty"><td colspan="6">No jobs yet. Choose images and press Upload and process.</td></tr>'; return; }
    tb.innerHTML = rows.map((r) => `<tr data-job="${esc(r.jobId)}" aria-selected="${lv.selected === r.jobId}" tabindex="0"><td class="idcell">${esc(r.jobId.slice(0, 8))}…</td><td>${pill(r)}</td><td class="num">${esc(r.fileCount ?? "—")}</td><td class="num">${esc(r.attempts ?? 0)}</td><td class="num">${esc(shortTime(r.createdAt))}</td><td class="num">${esc(shortTime(r.updatedAt))}</td></tr>`).join("");
    $$("tr[data-job]", tb).forEach((tr) => {
      const open = () => selectJob(tr.dataset.job);
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
  }

  // Polling: every 3 s while a row is queued or processing; a queued row older than 10 minutes is stale and stops it.
  function stopPolling() { if (lv.timer) clearTimeout(lv.timer); lv.timer = null; }
  function schedulePoll() {
    stopPolling();
    if (liveMode() && liveSession() && LIVE.needsPolling(lv.rows, Date.now())) lv.timer = setTimeout(refreshList, 3000);
  }
  async function refreshList() {
    stopPolling();
    const r = await LIVE.listJobs(lv.cfg);
    if (!liveMode()) return;
    if (r.status !== 200) { fail(r, refreshList); return; }
    if (!liveSession()) return;
    say("");
    const listed = r.body.jobs || [];
    lv.rows = LIVE.mergeJobs(lv.local, listed);
    lv.local = lv.local.filter((x) => !listed.some((j) => j.jobId === x.jobId)); // the list has caught up with these
    renderLiveTable();
    const sel = lv.rows.find((x) => x.jobId === lv.selected);
    if (sel && (!LIVE.isTerminal(sel.status) || !lv.sig.startsWith(sel.status + "|"))) await loadDetail(lv.selected);
    schedulePoll();
  }

  // ---- inspector ----
  function paintLive(status) {
    $$("#live-flow [data-node]").forEach((n) => n.classList.remove("active", "good", "bad"));
    LIVE.pipelineFor(status).forEach((p) => $$(`#live-flow [data-node="${p.node}"]`).forEach((n) => n.classList.add(p.tone || "active")));
  }
  function selectJob(jobId) {
    lv.selected = jobId; lv.sig = "";
    $("#live-inspector").hidden = false;
    $("#lv-grid").innerHTML = "";
    $("#lv-json").textContent = "…";
    renderLiveTable();
    loadDetail(jobId, true);
  }
  async function loadDetail(jobId, scroll) {
    const r = await LIVE.getJob(lv.cfg, jobId);
    if (jobId !== lv.selected) return;
    $("#lv-http").textContent = String(r.status);
    if (r.status !== 200) { fail(r, () => loadDetail(jobId)); return; }
    const j = r.body;
    $("#lv-title").textContent = jobId.slice(0, 8) + "…";
    $("#lv-id").textContent = j.jobId;
    $("#lv-status").innerHTML = pill(j);
    $("#lv-attempts").textContent = String(j.attempts ?? 0);
    paintLive(j.status);
    $("#lv-badge").textContent = LIVE.LABELS.badge;
    $("#lv-statement").textContent = LIVE.LABELS.statement;
    $("#lv-json").textContent = JSON.stringify(j, null, 2);
    $("#lv-json").classList.remove("idle");
    const manifest = LIVE.safeUrl(j.manifestUrl);
    $("#lv-manifest").innerHTML = manifest ? `<a href="${esc(manifest)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open manifest</a>` : "Not available yet.";
    if (j.status === "failed" && j.error) say("Job failed: " + j.error);
    // Re-render the grid only when something visible changed: the signed image links differ on every call.
    const sig = j.status + "|" + (j.files || []).map((f) => f.status + f.outputKey).join(",");
    if (sig !== lv.sig) { lv.sig = sig; renderFiles(j); }
    const row = lv.rows.find((x) => x.jobId === jobId);
    if (row && row.status !== j.status) { row.status = j.status; row.attempts = j.attempts; row.updatedAt = j.updatedAt; renderLiveTable(); }
    if (scroll) $("#live-inspector").scrollIntoView({ block: "nearest" });
  }
  function renderFiles(j) {
    const files = j.files || [];
    $("#lv-filesub").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
    $("#lv-grid").innerHTML = files.map((f) => {
      const pre = LIVE.safeUrl(f.previewUrl), out = LIVE.safeUrl(f.downloadUrl);
      const img = (url, alt, label) => `<div>${url ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">` : '<img alt="" hidden>'}<small>${label}</small></div>`;
      const facts = f.status === "completed"
        ? `<span>${esc(f.width)} × ${esc(f.height)} px · ${esc(fmtBytes(f.bytes))}</span>` + (out ? `<a href="${esc(out)}" download="${esc(f.name)}" rel="noopener noreferrer" referrerpolicy="no-referrer">Download</a>` : "")
        : f.status === "failed" ? `<span class="ferr">${esc(f.error || "failed")}</span>` : "<span>waiting for the worker</span>";
      return `<figure class="fcard"><div class="imgs">${img(pre, "Original: " + f.name, "Original")}${f.status === "completed" ? img(out, "Output: " + f.name, "Output") : "<div></div>"}</div><figcaption><b>${esc(f.name)}</b>${facts}</figcaption></figure>`;
    }).join("");
  }

  // ---- new job: pick, check, upload, create ----
  const chosen = () => Array.from($("#lv-files").files || []);
  function showChosen() {
    const files = chosen(), problems = files.length ? LIVE.checkFiles(files) : [];
    $("#lv-filelist").innerHTML = files.map((f, i) => `<li><span>${esc(f.name)}</span><span>${esc(fmtBytes(f.size))}</span><progress id="lv-p${i}" value="0" max="1" aria-label="Upload progress for ${esc(f.name)}" hidden></progress></li>`).join("");
    $("#lv-filemsg").textContent = problems.join(" ");
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
    lv.busy = true; $("#lv-go").disabled = true; $("#lv-go").classList.add("loading");
    $$("#lv-filelist progress").forEach((p) => { p.hidden = false; p.value = 0; });
    try {
      const keys = await LIVE.uploadFiles(lv.cfg, files, (i, loaded, total) => { const p = $("#lv-p" + i); if (p && total) p.value = loaded / total; });
      const r = await LIVE.createJob(lv.cfg, keys, options);
      if (r.status !== 202) { fail(r, uploadAndProcess); return; }
      const now = new Date().toISOString();
      const row = { jobId: r.body.jobId, status: r.body.status || "queued", task: "resize", createdAt: now, updatedAt: now, attempts: 0, fileCount: files.length, completedCount: 0, failedCount: 0 };
      lv.local.push(row);
      lv.rows = LIVE.mergeJobs(lv.local, lv.rows);
      $("#lv-files").value = ""; showChosen();
      selectJob(row.jobId);
      schedulePoll();
    } catch (e) {
      fail({ status: e.status || 0, body: e.body || null }, uploadAndProcess);
    } finally {
      lv.busy = false; $("#lv-go").disabled = false; $("#lv-go").classList.remove("loading");
    }
  }

  $("#lv-files").onchange = showChosen;
  $("#lv-preset").onchange = () => { $("#lv-custom").hidden = $("#lv-preset").value !== "custom"; };
  $("#lv-go").onclick = uploadAndProcess;
  $("#live-retry").onclick = () => { const f = lv.retry; say(""); if (f) f(); };
  $("#lv-signin").onclick = () => LIVE.beginSignIn(lv.cfg);
  $("#cta-signin").onclick = () => LIVE.beginSignIn(lv.cfg);
  $("#signout").onclick = () => LIVE.signOut(lv.cfg);
  $$("#modeswitch button").forEach((b) => (b.onclick = () => { if (!b.disabled) setMode(b.dataset.mode); }));

  // Live is available only when config.json loads (never under file://); otherwise the page stays browser-demo-only.
  (async function initLive() {
    lv.cfg = await LIVE.loadConfig();
    if (!lv.cfg) return;
    LIVE.applyCsp(lv.cfg);
    $("#mode-live").disabled = false;
    $("#mode-live").removeAttribute("title");
    render(); // shows the Sign in call to action
    const cb = await LIVE.handleCallback(lv.cfg, location);
    if (cb.handled) {
      location.hash = "#runs";
      setMode("live");
      if (!cb.ok) say(cb.error);
    } else if (LIVE.getSession() && location.hash === "#runs") setMode("live");
  })();

  renderTable();
  route();
})();
