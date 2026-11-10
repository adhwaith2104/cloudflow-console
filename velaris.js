/* Page background: a slow, near-black simplex-noise field behind the whole page (<canvas id="velaris">, --case-study build only).
   Adapted from the Velaris WebGL shader: same three layered noise fields, reduced to one grey channel between #050505 and #2d2d2d,
   with no glow, vignette or animated grain, so text contrast holds and nothing competes with the road or the console.
   Without WebGL the canvas stays invisible and the page keeps its plain background. Reduced motion draws one still frame.
   Rendering stops while the tab is hidden and recovers from a lost WebGL context. No inline styles: only attributes and classes (CSP). */
(function () {
  "use strict";
  const canvas = document.getElementById("velaris");
  if (!canvas) return;

  const VERT = "attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }";
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution;
uniform float u_time;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  vec2 p = gl_FragCoord.xy / u_resolution - 0.5;
  p.x *= u_resolution.x / u_resolution.y;
  float t = u_time;
  float n1 = snoise(p * 0.4 + vec2(t * 0.2, -t * 0.3));
  float n2 = snoise(p * 0.55 + vec2(-t * 0.15, t * 0.25) + n1 * 0.25);
  float n3 = snoise(p * 0.75 + vec2(t * 0.1, -t * 0.2) + n2 * 0.2);
  float v = 0.0;
  v = mix(v, 0.55, smoothstep(-0.2, 0.5, n1) * 0.85);
  v = mix(v, 1.0, smoothstep(-0.1, 0.6, n2) * 0.7);
  v = mix(v, 0.3, smoothstep(-0.3, 0.4, n3) * 0.6);
  v = mix(v, 0.0, smoothstep(0.0, 0.7, n1 * n2) * 0.5);
  float grey = (5.0 + v * 40.0) / 255.0;                 // #050505 (the page background) up to #2d2d2d
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  grey += (dither - 0.5) / 255.0;                        // still, one-level dither: hides banding in the dark greys
  gl_FragColor = vec4(vec3(grey), 1.0);
}`;


  const SPEED = 0.07;        // noise time per second; the original runs about three times faster

  let gl = null;
  try { gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false }); } catch (e) { gl = null; }
  if (!gl) return;

  let program = null, buffer = null, uRes = null, uTime = null;
  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  // Builds the program; called again after the browser restores a lost context (GPU switch, driver reset, memory pressure).
  function setup() {
    const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);                                   // the linked program keeps what it needs
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    uRes = gl.getUniformLocation(program, "u_resolution");
    uTime = gl.getUniformLocation(program, "u_time");
    gl.viewport(0, 0, canvas.width, canvas.height);
    return true;
  }

  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  let raf = 0, last = 0, clock = 0, dead = false;

  // One canvas pixel per CSS pixel is enough for a soft field, whatever the device pixel ratio.
  function resize() {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    return true;
  }
  function draw() {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, clock);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // Every display frame is drawn: skipping frames to save work made the motion uneven.
  function frame(now) {
    raf = requestAnimationFrame(frame);
    clock += Math.min(now - last, 100) / 1000 * SPEED;     // a long pause does not jump the field forward
    last = now;
    draw();
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function sync() {
    if (dead) return;
    const run = !document.hidden && !still.matches;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    if (!run) stop();
    if (!run && !document.hidden) draw();        // reduced motion: one still frame
  }

  resize();
  if (!setup()) return;
  draw();
  canvas.classList.add("on");
  new ResizeObserver(() => { if (!dead && resize()) draw(); }).observe(canvas);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pageshow", sync);
  still.addEventListener("change", sync);
  // A lost context is not the end: keep the last look out of the way, then rebuild when the browser hands the context back.
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); dead = true; stop(); canvas.classList.remove("on"); });
  canvas.addEventListener("webglcontextrestored", () => {
    if (!setup()) return;
    dead = false;
    draw();
    canvas.classList.add("on");
    sync();
  });
  window.addEventListener("pagehide", (e) => {
    stop();
    if (dead || e.persisted) return;                       // a page kept for back/forward keeps its context
    dead = true;
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  });
  sync();
})();
