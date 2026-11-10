/* CloudFlow architecture diagram renderer. Draws the SVG from arch.js (the single source of truth); it adds no facts of its own.
 * API: render, highlight, clear, select, zoom. Browser only, no network access, no dependencies besides arch.js.
 * The SVG is built as one HTML string (inline <svg> needs no namespace), so this file contains no URLs. */
(function (root, factory) {
  root.CloudFlowArchView = factory(root.CloudFlowArch);
})(typeof self !== "undefined" ? self : this, function (ARCH) {
  "use strict";

  // arch.js also keeps the first deployment as a private historical record; this page always draws the current one, which is listed last.
  const CURRENT = Object.keys(ARCH.versions).pop();

  // ---- geometry: grid cell [column 0-5, row 0-3] -> pixels in a 1220 x 640 viewBox -----------------
  const W = 1220, H = 640, CW = 180, CH = 68, X0 = 14, PX = 202, BAND_P = 152, BAND_H = 144, Y0 = 16, NODE_DY = 44;
  const colX = (c) => X0 + c * PX;
  const bandTop = (r) => Y0 + r * BAND_P;
  const rowY = (r) => bandTop(r) + NODE_DY;
  const ROW_LABELS = ["Request path", "Processing and data", "Failure path", "Operational controls (govern the services; not a data flow)"];
  const LANE_TOP = 124, LANE_BOTTOM = 157; // y offsets below a row's band top; the next band's label sits at +168

  // ---- line styles -----------------------------------------------------------------------------------
  // Colours live in styles.css (the design tokens): an edge type gets a class "t-<type>", a lit state "lit-<tone>". Only the dash pattern is set here.
  const TYPE_DASH = { solid: "", dashed: "6 5", dotted: "1.5 4.5" };
  const LIT_TONES = ["active", "good", "bad", "trail"];
  const LIT_MARKERS = ["active", "good", "bad"];

  // ---- icons: original simplified glyphs on a 24px grid, drawn white on the category-colour tile ------
  // The official AWS Architecture Icons (whose licence permits use in architecture diagrams) can be dropped in here by replacing these SVG strings.
  const ICONS = {
    "Client": '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M3 9h18M6.5 7h.01M9 7h.01M9 21h6M12 18v3"/>',
    "Amazon Cognito": '<circle cx="12" cy="8" r="3.3"/><path d="M5.5 20c.6-3.7 3.1-5.6 6.5-5.6s5.9 1.9 6.5 5.6"/>',
    "Amazon API Gateway": '<path d="M4 8h12M12.5 4.5 16 8l-3.5 3.5M20 16H8M11.5 12.5 8 16l3.5 3.5"/>',
    "AWS Lambda": '<path d="M6.5 4.5h3.2L17.5 20M12.3 12.6 6.6 20"/>',
    "Amazon S3": '<path d="M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 7l1.6 11.2c.2 1.2 2.6 1.8 5.4 1.8s5.2-.6 5.4-1.8L19 7"/>',
    "Amazon DynamoDB": '<path d="M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    "Amazon SQS": '<rect x="3" y="8" width="5" height="8" rx="1"/><rect x="9.5" y="8" width="5" height="8" rx="1"/><rect x="16" y="8" width="5" height="8" rx="1"/>',
    "Amazon SNS": '<circle cx="12" cy="12" r="2.3"/><path d="M7.4 7.4a6.5 6.5 0 0 0 0 9.2M16.6 7.4a6.5 6.5 0 0 1 0 9.2M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8"/>',
    "Amazon CloudWatch": '<circle cx="12" cy="12" r="8.2"/><path d="M12 7v5.2l3.4 2"/>',
    "Amazon CloudWatch Logs": '<path d="M6 3h8.5L19 7.5V21H6zM14 3v5h5M9 12h7M9 15.5h7M9 8.5h2.5"/>',
    "AWS Budgets": '<path d="M4 7h16v11H4zM4 10.5h16M15.5 14.5h2"/><path d="M8 4.5h8"/>',
    "AWS X-Ray": '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M7 10.6h2l1.2-2.4 1.8 4.6 1-2.2h1.2"/>',
    "AWS IAM": '<path d="M12 3l7.5 3v5.5c0 4.4-3 7.7-7.5 9.5-4.5-1.8-7.5-5.1-7.5-9.5V6zM8.8 12l2.2 2.2 4.2-4.4"/>',
    "Terraform": '<path fill="currentColor" stroke="none" d="M4 3.5l5.5 3.2v6.4L4 9.9zM10.5 6.7 16 9.9v6.4l-5.5-3.2zM17 3.9l3.5 2v6.4l-3.5-2z"/>',
  };
  const GENERIC_ICON = '<rect x="5" y="5" width="14" height="14" rx="2"/>';

  // ---- helpers -----------------------------------------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = new WeakMap(); // container -> state
  const nameOf = (n, v) => ARCH.text(n.name, v);
  const wrap = (text, max) => {
    const lines = [];
    let cur = "";
    for (const w of String(text).split(" ")) {
      if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
    }
    if (cur) lines.push(cur);
    return lines;
  };

  // ---- layout and routing -------------------------------------------------------------------------------
  // Edges are orthogonal. Same-row neighbours and one-column steps run through the gap between columns;
  // everything else drops into the horizontal channel under a row and runs along its own lane.
  function plan(A, B, occ) {
    const dc = B.c - A.c, dr = B.r - A.r;
    if (dr === 0 && Math.abs(dc) > 1) {
      let clear = true;
      for (let c = Math.min(A.c, B.c) + 1; c < Math.max(A.c, B.c); c++) if (occ.has(c + "," + A.r)) clear = false;
      if (!clear) return { kind: "v", sa: "b", sb: "b", ch: A.r }; // loop under the row
    }
    if (dr === 0 || Math.abs(dc) === 1) return { kind: "h", sa: dc > 0 ? "r" : "l", sb: dc > 0 ? "l" : "r" };
    return { kind: "v", sa: dr > 0 ? "b" : "t", sb: dr > 0 ? "t" : "b", ch: Math.min(A.r, B.r) };
  }

  function layout(v) {
    const nodes = ARCH.nodesFor(v).map((n) => ({ n, id: n.id, c: n.grid[v][0], r: n.grid[v][1], x: colX(n.grid[v][0]), y: rowY(n.grid[v][1]) }));
    const byId = Object.fromEntries(nodes.map((o) => [o.id, o]));
    const occ = new Set(nodes.map((o) => o.c + "," + o.r));
    const edges = ARCH.edgesFor(v).map((e) => {
      const A = byId[e.from], B = byId[e.to];
      return Object.assign({ e, A, B }, plan(A, B, occ));
    });
    // Ports: spread the edges that meet on one side of a card, ordered by where they go; a straight edge takes the centre.
    const groups = new Map();
    const add = (node, side, p, end) => {
      const k = node.id + "|" + side;
      if (!groups.has(k)) groups.set(k, { node, side, items: [] });
      groups.get(k).items.push({ p, end });
    };
    edges.forEach((p) => { add(p.A, p.sa, p, "a"); add(p.B, p.sb, p, "b"); });
    groups.forEach((g) => {
      const vertical = g.side === "t" || g.side === "b";
      const own = vertical ? g.node.x + CW / 2 : g.node.y + CH / 2;
      const step = vertical ? 18 : 14;
      const info = g.items.map((it) => {
        const o = it.end === "a" ? it.p.B : it.p.A;
        const pos = vertical ? o.x + CW / 2 : o.y + CH / 2;
        const straight = vertical ? o.c === g.node.c && it.p.sa !== it.p.sb : o.r === g.node.r;
        return { it, pos, straight };
      });
      const left = info.filter((i) => !i.straight && i.pos < own).sort((a, b) => a.pos - b.pos);
      const right = info.filter((i) => !i.straight && i.pos >= own).sort((a, b) => a.pos - b.pos);
      const mid = info.filter((i) => i.straight);
      const place = (i, off) => { i.it.p["off" + i.it.end] = off; };
      if (mid.length) {
        mid.forEach((i) => place(i, 0));
        left.forEach((i, k) => place(i, -(left.length - k) * step));
        right.forEach((i, k) => place(i, (k + 1) * step));
      } else {
        const all = left.concat(right);
        all.forEach((i, k) => place(i, (k - (all.length - 1) / 2) * step));
      }
    });
    const port = (node, side, off) => ({ t: [node.x + CW / 2 + off, node.y], b: [node.x + CW / 2 + off, node.y + CH], l: [node.x, node.y + CH / 2 + off], r: [node.x + CW, node.y + CH / 2 + off] }[side]);
    edges.forEach((p) => { p.pa = port(p.A, p.sa, p.offa); p.pb = port(p.B, p.sb, p.offb); });
    // Lanes: gap lanes for 'h' edges that need a jog, channel lanes for 'v' edges that need to move sideways.
    const gapReq = new Map(), chReq = new Map();
    edges.forEach((p) => {
      if (p.kind === "h") {
        if (Math.abs(p.pa[1] - p.pb[1]) < 0.5) return;
        const g = p.B.c > p.A.c ? p.A.c : p.A.c - 1;
        p.gap = g;
        if (!gapReq.has(g)) gapReq.set(g, []);
        gapReq.get(g).push(p);
      } else if (p.sa === p.sb || Math.abs(p.pa[0] - p.pb[0]) >= 0.5) {
        if (!chReq.has(p.ch)) chReq.set(p.ch, []);
        chReq.get(p.ch).push(p);
      }
    });
    gapReq.forEach((list, g) => list.forEach((p, i) => { p.gx = colX(g) + CW + (PX - CW) / 2 + (i - (list.length - 1) / 2) * 6; }));
    chReq.forEach((list, ch) => {
      list.sort((a, b) => Math.abs(a.pa[0] - a.pb[0]) - Math.abs(b.pa[0] - b.pb[0]));
      const gap = list.length > 1 ? Math.min(11, (LANE_BOTTOM - LANE_TOP) / (list.length - 1)) : 0;
      list.forEach((p, i) => { p.ly = bandTop(ch) + LANE_TOP + i * gap; });
    });
    edges.forEach((p) => {
      const [ax, ay] = p.pa, [bx, by] = p.pb;
      if (p.kind === "h") p.pts = p.gx === undefined ? [p.pa, p.pb] : [p.pa, [p.gx, ay], [p.gx, by], p.pb];
      else p.pts = p.ly === undefined ? [p.pa, p.pb] : [p.pa, [ax, p.ly], [bx, p.ly], p.pb];
    });
    return { nodes, byId, edges };
  }

  function roundedPath(pts, r) {
    let d = "M" + pts[0][0] + "," + pts[0][1];
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
      const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y), k = Math.min(r, l1 / 2, l2 / 2);
      if (!k) continue;
      d += ` L${x + ((px - x) / l1) * k},${y + ((py - y) / l1) * k} Q${x},${y} ${x + ((nx - x) / l2) * k},${y + ((ny - y) / l2) * k}`;
    }
    return d + " L" + pts[pts.length - 1][0] + "," + pts[pts.length - 1][1];
  }

  // ---- drawing -------------------------------------------------------------------------------------------
  function nodeSvg(o, v, interactive) {
    const n = o.n, name = nameOf(n, v);
    const lines = wrap(name, 21);
    if (lines.length > 2) lines.splice(1, lines.length, lines.slice(1).join(" "));
    const avail = CW - 56 - 6;
    const svcText = n.service.toUpperCase();
    const svcSq = svcText.length * 6.1 > avail ? ` textLength="${avail}" lengthAdjust="spacingAndGlyphs"` : "";
    const nameY = lines.length === 1 ? 43 : 40;
    const nameTxt = lines.map((l, i) => `<tspan x="${o.x + 56}" y="${o.y + nameY + i * 13}"${l.length * 6.2 > avail ? ` textLength="${avail}" lengthAdjust="spacingAndGlyphs"` : ""}>${esc(l)}</tspan>`).join("");
    const attrs = interactive
      ? ` role="button" tabindex="0" aria-label="${esc(name + ", " + n.service)}"`
      : ' tabindex="-1"';
    return `<g class="node ${n.kind}" data-node="${n.id}"${attrs}><title>${esc(name + ", " + n.service)}</title>` +
      `<rect class="card" x="${o.x}" y="${o.y}" width="${CW}" height="${CH}" rx="9"/>` +
      `<rect class="tile" x="${o.x + 12}" y="${o.y + 16}" width="36" height="36" rx="7"/>` +
      `<g class="glyph" transform="translate(${o.x + 18},${o.y + 22})" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n.service] || GENERIC_ICON}</g>` +
      `<text class="svc" x="${o.x + 56}" y="${o.y + 23}"${svcSq}>${esc(svcText)}</text><text class="nm">${nameTxt}</text></g>`;
  }

  function legendHtml(v, edgeTypes, hasLegacy) {
    const items = Object.entries(edgeTypes).map(([k, t]) => `<li><svg class="lg t-${k}" width="42" height="10" viewBox="0 0 42 10" aria-hidden="true"><line x1="2" y1="5" x2="40" y2="5" stroke-width="2" stroke-linecap="round"${TYPE_DASH[t.style] ? ` stroke-dasharray="${TYPE_DASH[t.style]}"` : ""}/></svg><span>${esc(t.label)}</span></li>`);
    if (hasLegacy) items.push('<li><svg class="lg t-status" width="42" height="10" viewBox="0 0 42 10" aria-hidden="true"><line x1="2" y1="5" x2="40" y2="5" stroke-width="2" stroke-linecap="round" opacity=".45"/></svg><span>Muted line: legacy API-key route kept for operator testing</span></li>');
    items.push('<li class="lg-note"><span>Bottom strip: operational controls that govern the services above; not a data flow.</span></li>');
    return `<ul class="av-legend" aria-label="Legend">${items.join("")}</ul>`;
  }

  /* render(container, { mode: "full"|"compact", interactive, idPrefix }): always the current deployment. */
  function render(container, opts) {
    const v = CURRENT;
    const mode = opts.mode === "compact" || opts.mode === "ledger" ? opts.mode : "full";
    const interactive = mode === "full" && !!opts.interactive;
    const p = opts.idPrefix || "x";
    const L = layout(v);
    const bands = ROW_LABELS.map((label, r) => `<rect class="band${r === 3 ? " strip" : ""}" x="4" y="${bandTop(r)}" width="${W - 8}" height="${BAND_H}" rx="12"/><text class="bandlabel" x="18" y="${bandTop(r) + 19}">${esc(label)}</text>`).join("");
    const markers = Object.keys(ARCH.edgeTypes).map((k) => [`${p}-arr-${k}`, "t-" + k]).concat(LIT_MARKERS.map((k) => [`${p}-arr-lit-${k}`, "mk-lit-" + k]))
      .map(([id, cls]) => `<marker id="${id}" class="${cls}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path d="M0,0.5 L10,5 L0,9.5 z"/></marker>`).join("");
    const edges = L.edges.map((q) => {
      const legacy = ARCH.isLegacy(q.e, v), dash = TYPE_DASH[ARCH.edgeTypes[q.e.type].style];
      return `<g class="edge t-${q.e.type}${legacy ? " legacy" : ""}" data-edge="${q.e.id}" data-type="${q.e.type}"><path d="${roundedPath(q.pts, 8)}" fill="none" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linecap="round" marker-end="url(#${p}-arr-${q.e.type})"/></g>`;
    }).join("");
    const nodes = L.nodes.map((o) => nodeSvg(o, v, interactive)).join("");
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="CloudFlow architecture"><defs>${markers}</defs>${bands}<g class="av-edges">${edges}</g><g class="av-nodes">${nodes}</g><g class="av-labels"></g></svg>`;
    // "ledger": the same nodes as a readable list grouped by the diagram's own lanes (no drawing), for column-width spaces.
    const lanes = mode === "ledger"
      ? `<div class="arch-lanes">${ROW_LABELS.map((label, r) => {
        const [name, note] = label.replace(/\)$/, "").split(" (");
        const items = L.nodes.filter((o) => o.r === r).sort((a, b) => a.c - b.c).map((o) => `<li data-node="${o.id}"><small>${esc(o.n.service)}</small>${esc(nameOf(o.n, v))}</li>`).join("");
        return `<section class="lane"><h3>${esc(name)}${note ? ` <small>${esc(note)}</small>` : ""}</h3><ul>${items}</ul></section>`;
      }).join("")}</div>`
      : "";
    const list = mode === "compact"
      ? `<ol class="arch-list">${L.nodes.map((o) => `<li data-node="${o.id}"><button type="button" tabindex="-1"><small>${esc(o.n.service)}</small>${esc(nameOf(o.n, v))}</button></li>`).join("")}</ol>`
      : "";
    const legend = mode === "full" ? legendHtml(v, ARCH.edgeTypes, L.edges.some((q) => ARCH.isLegacy(q.e, v))) : "";
    container.className = (container.className.replace(/\barchview\b|\bav-(full|compact|current)\b|\bzoomed\b|\bfitted\b/g, "").trim() + ` archview av-${mode} av-current`).trim();
    container.innerHTML = mode === "ledger" ? lanes : `<div class="av-stage">${svg}</div>${list}${legend}`;
    const st = { opts, version: v, mode, interactive, L, selected: null, hover: null, z: 1, cx: W / 2, cy: H / 2, drag: null, moved: false };
    S.set(container, st);
    if (interactive) bind(container, st);
  }

  // ---- interaction -----------------------------------------------------------------------------------------
  function bind(container, st) {
    const stage = container.querySelector(".av-stage");
    container.querySelectorAll(".node").forEach((el) => {
      const id = el.dataset.node;
      const choose = () => {
        select(container, id);
        container.dispatchEvent(new CustomEvent("archselect", { detail: { id, version: st.version } }));
      };
      el.addEventListener("click", (e) => { e.preventDefault(); if (!st.moved) choose(); st.moved = false; });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
      el.addEventListener("pointerenter", () => { st.hover = id; paintFocus(container); });
      el.addEventListener("pointerleave", () => { st.hover = null; paintFocus(container); });
      el.addEventListener("focus", () => { st.hover = id; paintFocus(container); });
      el.addEventListener("blur", () => { st.hover = null; paintFocus(container); });
    });
    // Drag to pan (mouse, pen and touch use the same pointer events). Only meaningful once zoomed in.
    stage.addEventListener("pointerdown", (e) => {
      if (st.z <= 1 || (e.pointerType === "mouse" && e.button !== 0)) return;
      st.drag = { x: e.clientX, y: e.clientY, cx: st.cx, cy: st.cy, id: e.pointerId, active: false };
    });
    stage.addEventListener("pointermove", (e) => {
      const d = st.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.active) {
        if (Math.hypot(dx, dy) < 5) return;
        d.active = true; st.moved = true;
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
        container.classList.add("panning");
      }
      const svg = stage.querySelector("svg"), k = (W / st.z) / svg.getBoundingClientRect().width;
      st.cx = d.cx - dx * k; st.cy = d.cy - dy * k;
      applyView(container, st);
    });
    const end = (e) => {
      const d = st.drag;
      if (!d || d.id !== e.pointerId) return;
      st.drag = null;
      container.classList.remove("panning");
      if (d.active) setTimeout(() => { st.moved = false; }, 0); // the click that follows a drag must not select a node
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }

  function applyView(container, st) {
    const w = W / st.z, h = H / st.z;
    st.cx = Math.min(W - w / 2, Math.max(w / 2, st.cx));
    st.cy = Math.min(H - h / 2, Math.max(h / 2, st.cy));
    const r = (n) => Math.round(n * 10) / 10;
    container.querySelector("svg").setAttribute("viewBox", `${r(st.cx - w / 2)} ${r(st.cy - h / 2)} ${r(w)} ${r(h)}`);
    container.classList.toggle("zoomed", st.z > 1);
  }

  /* zoom(container, "in" | "out" | "fit"): changes the SVG viewBox; "fit" shows the whole diagram at the container width. */
  function zoom(container, dir) {
    const st = S.get(container);
    if (!st) return;
    if (dir === "fit") { st.z = 1; st.cx = W / 2; st.cy = H / 2; container.classList.add("fitted"); }
    else {
      st.z = Math.min(4, Math.max(1, dir === "in" ? st.z * 1.35 : st.z / 1.35));
      if (st.z < 1.02) { st.z = 1; st.cx = W / 2; st.cy = H / 2; }
      container.classList.remove("fitted");
    }
    applyView(container, st);
  }

  // Hovering or selecting a node dims the rest and draws the labels of its edges near their midpoints (full mode only).
  function paintFocus(container) {
    const st = S.get(container);
    if (!st || st.mode !== "full") return;
    const focus = st.hover || st.selected;
    const svg = container.querySelector("svg"), labels = svg.querySelector(".av-labels");
    labels.innerHTML = "";
    svg.classList.toggle("focusing", !!focus);
    const rel = new Set(focus ? [focus] : []);
    const attached = focus ? st.L.edges.filter((q) => q.A.id === focus || q.B.id === focus) : [];
    attached.forEach((q) => { rel.add(q.A.id); rel.add(q.B.id); });
    svg.querySelectorAll(".node").forEach((el) => el.classList.toggle("rel", rel.has(el.dataset.node)));
    const on = new Set(attached.map((q) => q.e.id));
    svg.querySelectorAll(".edge").forEach((el) => el.classList.toggle("rel", on.has(el.dataset.edge)));
    if (!st.interactive) return;
    const placed = [];
    const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const cards = st.L.nodes.map((o) => ({ x: o.x - 2, y: o.y - 2, w: CW + 4, h: CH + 4 }));
    attached.forEach((q) => {
      const lines = wrap(ARCH.text(q.e.label, st.version), 34);
      const w = Math.max(...lines.map((l) => l.length)) * 5.9 + 14, h = lines.length * 13 + 8;
      // Anchor on the longest segment, then search the free space around it for a spot that covers no card and no other label.
      let seg = 0, longest = -1;
      for (let i = 0; i < q.pts.length - 1; i++) {
        const len = Math.abs(q.pts[i + 1][0] - q.pts[i][0]) + Math.abs(q.pts[i + 1][1] - q.pts[i][1]);
        if (len > longest) { longest = len; seg = i; }
      }
      const mx = (q.pts[seg][0] + q.pts[seg + 1][0]) / 2, my = (q.pts[seg][1] + q.pts[seg + 1][1]) / 2;
      let best = null;
      for (let dx = -200; dx <= 200; dx += 14) {
        for (let dy = -90; dy <= 90; dy += 10) {
          const box = { x: Math.min(W - w - 4, Math.max(4, mx + dx - w / 2)), y: Math.min(H - h - 4, Math.max(4, my + dy - h / 2)), w, h };
          const cost = cards.reduce((n, c) => n + overlap(box, c) * 20, 0) + placed.reduce((n, c) => n + overlap(box, c) * 20, 0) + Math.hypot(box.x + w / 2 - mx, box.y + h / 2 - my);
          if (!best || cost < best.cost) best = { cost, box };
        }
      }
      const { x, y } = best.box;
      placed.push(best.box);
      const lx = Math.min(x + w, Math.max(x, mx)), ly = Math.min(y + h, Math.max(y, my));
      const leader = Math.hypot(lx - mx, ly - my) > 3 ? `<line class="leader" x1="${mx}" y1="${my}" x2="${lx}" y2="${ly}"/>` : "";
      const text = lines.map((l, i) => `<tspan x="${x + 7}" y="${y + 15 + i * 13}">${esc(l)}</tspan>`).join("");
      labels.insertAdjacentHTML("beforeend", `<g class="elabel t-${q.e.type}">${leader}<circle class="dot" cx="${mx}" cy="${my}" r="3"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/><text>${text}</text></g>`);
    });
  }

  /* select(container, nodeId): marks the node selected and shows its edge labels; pass null to clear. */
  function select(container, id) {
    const st = S.get(container);
    if (!st) return;
    st.selected = id && st.L.byId[id] ? id : null;
    container.querySelectorAll("[data-node]").forEach((el) => el.classList.toggle("selected", el.dataset.node === st.selected));
    paintFocus(container);
  }

  /* highlight(container, { nodes, edges, tone }): adds the tone class ("active" | "good" | "bad" | "trail") to nodes and animates edges. */
  function highlight(container, o) {
    const tone = LIT_TONES.includes(o.tone) ? o.tone : "active";
    const p = (container.querySelector("marker") || { id: "x-arr-" }).id.replace(/-arr-.*$/, "");
    (o.nodes || []).forEach((id) => container.querySelectorAll(`[data-node="${id}"]`).forEach((el) => el.classList.add(tone)));
    (o.edges || []).forEach((id) => container.querySelectorAll(`[data-edge="${id}"]`).forEach((el) => {
      el.classList.remove("lit-active", "lit-good", "lit-bad");
      el.classList.add("lit", "lit-" + (tone === "trail" ? "active" : tone));
      el.querySelector("path").setAttribute("marker-end", `url(#${p}-arr-lit-${tone === "trail" ? "active" : tone})`);
    }));
  }

  /* clear(container): removes every highlight. */
  function clear(container) {
    const p = (container.querySelector("marker") || { id: "x-arr-" }).id.replace(/-arr-.*$/, "");
    container.querySelectorAll("[data-node]").forEach((el) => el.classList.remove(...LIT_TONES));
    container.querySelectorAll("[data-edge]").forEach((el) => {
      el.classList.remove("lit", "lit-active", "lit-good", "lit-bad");
      el.querySelector("path").setAttribute("marker-end", `url(#${p}-arr-${el.dataset.type})`);
    });
  }

  return { render, highlight, clear, select, zoom, ICONS, CURRENT };
});
