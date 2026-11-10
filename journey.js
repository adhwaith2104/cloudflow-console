/* CloudFlow case study: the winding road and the point of light that travels along it.
 * The road is one SVG path built from the headings of the eight stops (cubic Béziers with vertical tangents, so every bend is an S-curve).
 * The dot's position is a pure function of window.scrollY: the "reading line" (55% of the viewport height) is mapped to a length along the path
 * by interpolating between the stops' anchor points, so scrolling, jumping, back/forward and reloading mid-page always leave the dot on the curve.
 * Geometry is set with setAttribute and state with classList only (no inline styles). One passive scroll listener schedules one requestAnimationFrame.
 * Browser only, no network access. Without JavaScript the page is a plain readable article (the road is hidden by CSS). */
(function () {
  "use strict";
  const doc = document, root = doc.documentElement;
  const journey = doc.getElementById("journey");
  if (!journey) return;
  root.classList.add("js");

  const road = journey.querySelector(".road");
  const base = road.querySelector(".road-base"), lit = road.querySelector(".road-lit"), glow = road.querySelector(".road-glow");
  const rings = [...road.querySelectorAll(".road-ring")];
  const stops = [...journey.querySelectorAll(".stop")];
  const heads = stops.map((s) => s.querySelector("h2"));
  const links = [...doc.querySelectorAll(".jindex a")];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const READING_LINE = 0.55;
  const num = (n) => Math.round(n * 100) / 100;

  // Stop 03: the deployed services grouped by the diagram's own lanes, as a readable list (built from arch.js; it adds no facts of its own).
  const archBox = doc.getElementById("case-arch");
  if (archBox && window.CloudFlowArchView) window.CloudFlowArchView.render(archBox, { mode: "ledger", interactive: false, idPrefix: "c" });

  // Reduced motion: the dot is not rendered at all; the road stays as a static indicator with every ring filled (CSS).
  let dot = road.querySelector(".road-dot");
  if (reduced && dot) { dot.remove(); dot = null; }

  // Layout mirrors casestudy.css: desktop >= 1100px (amplitude 90 in a 260px centre column), tablet >= 700px (36 in 150px), mobile: a straight line 20px from the left.
  function shape() {
    const w = window.innerWidth;
    return w >= 1100 ? { amp: 90, line: false } : w >= 700 ? { amp: 36, line: false } : { amp: 0, line: true };
  }

  // A long stretch between two stops swings across the centre column more than once, so the road keeps winding instead of leaning:
  // one S-curve per ~360px, always an odd number of crossings so the road arrives on the next stop's side.
  const crossings = (dy) => 2 * Math.max(0, Math.round((dy / 360 - 1) / 2)) + 1;

  let anchors = [], total = 0, built = false, dirty = true, frame = 0, shown = { act: -2 };

  // Path length at which the (monotonically descending) path reaches document height y: binary search on getPointAtLength().y.
  function lengthAt(y, total) {
    let lo = 0, hi = total;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (base.getPointAtLength(mid).y < y) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function build() {
    dirty = false;
    const box = journey.getBoundingClientRect();
    const docTop = box.top + window.scrollY;
    const { amp, line } = shape();
    const cx = line ? 20 : box.width / 2;
    const heading = (k) => { const r = heads[k].getBoundingClientRect(); return r.top + r.height / 2 - box.top; };
    const pts = [{ x: cx, y: 0 }]; // stop: index of the stop a point belongs to (waypoints between stops have none)
    stops.forEach((s, k) => {
      const x = line ? 20 : cx + (s.dataset.side === "left" ? -amp : amp), y = heading(k), prev = pts[pts.length - 1];
      if (!line && k > 0) {
        const n = crossings(y - prev.y), side = Math.sign(prev.x - cx);
        for (let j = 1; j < n; j++) pts.push({ x: cx + (j % 2 ? -side : side) * amp, y: prev.y + ((y - prev.y) * j) / n });
      }
      pts.push({ x, y, stop: k });
    });
    {
      const prev = pts[pts.length - 1], n = line ? 1 : crossings(box.height - prev.y), side = Math.sign(prev.x - cx);
      for (let j = 1; j < n; j++) pts.push({ x: cx + (j % 2 ? -side : side) * amp, y: prev.y + ((box.height - prev.y) * j) / n });
      pts.push({ x: cx, y: box.height });
    }
    let d = `M ${num(pts[0].x)} ${num(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) {
      const mid = num((pts[i - 1].y + pts[i].y) / 2);
      d += ` C ${num(pts[i - 1].x)} ${mid}, ${num(pts[i].x)} ${mid}, ${num(pts[i].x)} ${num(pts[i].y)}`;
    }
    road.setAttribute("viewBox", `0 0 ${num(box.width)} ${num(box.height)}`);
    [base, lit, glow].forEach((p) => p.setAttribute("d", d));
    total = base.getTotalLength();
    [lit, glow].forEach((p) => { p.setAttribute("stroke-dasharray", `${total} ${total}`); p.setAttribute("stroke-dashoffset", String(total)); });
    // Anchors: the road's start, each stop's ring, the road's end, with the path length at which the path reaches each of them.
    anchors = pts.map((p, i) => ({ p, i })).filter(({ p, i }) => i === 0 || i === pts.length - 1 || p.stop !== undefined)
      .map(({ p, i }) => ({ y: docTop + p.y, l: i === 0 ? 0 : i === pts.length - 1 ? total : lengthAt(p.y, total), x: p.x, stop: p.stop }));
    rings.forEach((c, k) => { const a = anchors[k + 1]; c.setAttribute("cx", String(num(a.x))); c.setAttribute("cy", String(num(a.y - docTop))); });
    built = true;
    shown = { act: -2 };
  }

  // Which segment of the anchor list holds the reading line, and the length along the path it maps to.
  function travelled(readingY) {
    let i = 0;
    while (i < anchors.length - 2 && readingY >= anchors[i + 1].y) i++;
    const a = anchors[i], b = anchors[i + 1];
    const t = b.y > a.y ? Math.min(1, Math.max(0, (readingY - a.y) / (b.y - a.y))) : 1;
    return a.l + t * (b.l - a.l);
  }

  // A stop counts as reached 1px early: scrolling lands on whole pixels, so a heading placed exactly on the line must not read as "not yet".
  function setClasses(readingY) {
    let act = -1;
    for (let k = 0; k < stops.length; k++) if (readingY >= anchors[k + 1].y - 1) act = k;
    rings.forEach((c, k) => c.classList.toggle("on", readingY >= anchors[k + 1].y - 1));
    if (act === shown.act) return;
    shown.act = act;
    stops.forEach((s, k) => { s.classList.toggle("is-active", k === act); s.classList.toggle("is-past", k < act); });
    links.forEach((a, k) => { if (k === act) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
  }

  function update() {
    frame = 0;
    if (dirty || !built) build();
    if (reduced) return;
    const readingY = window.scrollY + window.innerHeight * READING_LINE;
    const l = travelled(readingY);
    const p = base.getPointAtLength(l);
    [lit, glow].forEach((el) => el.setAttribute("stroke-dashoffset", String(num(total - l))));
    dot.setAttribute("cx", String(num(p.x)));
    dot.setAttribute("cy", String(num(p.y)));
    setClasses(readingY);
  }

  function schedule(rebuild) {
    if (rebuild) dirty = true;
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  // Jump to a stop named in the URL hash so that its heading sits on the reading line (the dot then rests on that stop's ring).
  function alignToHash() {
    const k = stops.findIndex((s) => "#" + s.id === location.hash);
    if (k < 0) return;
    build();
    window.scrollTo(0, Math.max(0, anchors[k + 1].y - window.innerHeight * READING_LINE));
    schedule(false);
  }

  build();
  update();
  if (!reduced) window.addEventListener("scroll", () => schedule(false), { passive: true });
  window.addEventListener("resize", () => schedule(true));
  window.addEventListener("load", () => { schedule(true); alignToHash(); });
  window.addEventListener("hashchange", alignToHash);
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => schedule(true));
  if (window.ResizeObserver) new ResizeObserver(() => schedule(true)).observe(journey);
  doc.querySelectorAll(".deep").forEach((el) => el.addEventListener("toggle", () => schedule(true)));
})();
