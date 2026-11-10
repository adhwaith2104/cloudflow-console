/* CloudFlow Console, Live mode client. Plain script: no modules, no framework.
   Sign-in is Cognito Hosted UI, authorization code + PKCE (PLAN-v2.md section 10a).
   This is the ONLY file allowed to use fetch() and XMLHttpRequest; every host it talks to comes from config.json.
   Browser: window.CloudFlowLive. Node (tests): module.exports. Browser globals are read from globalThis at call time. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CloudFlowLive = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const g = globalThis;
  const KEY_PKCE = "cf.pkce", KEY_SESSION = "cf.session";
  const MAX_FILES = 10, MAX_BYTES = 5 * 1024 * 1024, TYPES = ["image/jpeg", "image/png", "image/webp"];
  const STALE_MS = 10 * 60 * 1000;            // queued but never picked up (submit registered, send lost)
  const STUCK_MS = 3 * 720 * 1000;            // processing past three visibility timeouts: every receive crashed, message is in the DLQ

  // ---- PKCE primitives (RFC 7636) -------------------------------------------
  function b64url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return g.btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(bytes) {
    const a = new Uint8Array(bytes);
    g.crypto.getRandomValues(a);
    return b64url(a);
  }
  async function pkceChallenge(verifier) {
    const digest = await g.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }
  function constantTimeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  // ---- URLs -------------------------------------------------------------------
  // The page's own directory URL: a GitHub Pages project site lives under /<repo>/, not at the origin root.
  // Used identically in the authorize request, the token exchange and the logout URL, and registered in Cognito as console_origin + console_path.
  function pageDirUrl(loc) {
    let path = String(loc.pathname || "/").replace(/index\.html$/, "");
    if (!path.endsWith("/")) path += "/";
    return loc.origin + path;
  }
  const redirectUri = () => pageDirUrl(g.location);
  function buildAuthorizeUrl(cfg, p, path) {
    const q = new URLSearchParams({
      response_type: "code", client_id: cfg.clientId, redirect_uri: redirectUri(), scope: "openid email",
      code_challenge_method: "S256", code_challenge: p.challenge, state: p.state, nonce: p.nonce,
    });
    return `https://${cfg.cognitoDomain}/${path || "oauth2/authorize"}?${q}`; // path "signup" opens the hosted sign-up page with the same PKCE request
  }
  function buildLogoutUrl(cfg) {
    return `https://${cfg.cognitoDomain}/logout?` + new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri() });
  }
  const issuerOf = (cfg) => `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;

  // ---- ID token checks (the API Gateway authorizer verifies the signature) ------
  function decodeJwtPayload(token) {
    try {
      const part = String(token).split(".")[1];
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
      const bin = g.atob(b64);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch (e) { return null; }
  }
  function validateIdToken(payload, cfg, nonce, nowSeconds) {
    if (!payload || typeof payload !== "object") return ["token payload unreadable"];
    const problems = [];
    if (payload.aud !== cfg.clientId) problems.push("aud does not match the client id");
    if (payload.iss !== issuerOf(cfg)) problems.push("iss does not match the user pool");
    if (payload.token_use !== "id") problems.push("token_use is not id");
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) problems.push("token expired");
    if (!payload.nonce) problems.push("nonce missing");
    else if (!constantTimeEqual(payload.nonce, nonce || "")) problems.push("nonce mismatch");
    return problems;
  }

  // ---- session: sessionStorage only (cleared when the tab closes) ---------------
  function readJson(key) { try { return JSON.parse(g.sessionStorage.getItem(key)); } catch (e) { return null; } }
  const getSession = () => readJson(KEY_SESSION);
  const setSession = (s) => g.sessionStorage.setItem(KEY_SESSION, JSON.stringify(s));
  const clearSession = () => g.sessionStorage.removeItem(KEY_SESSION);

  const form = (obj) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(obj).toString() });
  const tokenUrl = (cfg) => `https://${cfg.cognitoDomain}/oauth2/token`;

  async function begin(cfg, path) {
    const verifier = randomString(32), state = randomString(16), nonce = randomString(16);
    g.sessionStorage.setItem(KEY_PKCE, JSON.stringify({ verifier, state, nonce }));
    g.location.assign(buildAuthorizeUrl(cfg, { state, nonce, challenge: await pkceChallenge(verifier) }, path));
  }
  const beginSignIn = (cfg) => begin(cfg, "oauth2/authorize");
  // Same saved verifier, state and nonce, so handleCallback completes it after the visitor confirms the e-mailed code.
  const beginSignUp = (cfg) => begin(cfg, "signup");

  // Returns {handled:false} when the URL is not a sign-in callback, else {handled:true, ok, error?}.
  async function handleCallback(cfg, loc) {
    const params = new URLSearchParams(loc.search || "");
    if (!params.has("code") && !params.has("error")) return { handled: false };
    const code = params.get("code"), state = params.get("state"), refused = params.has("error");
    g.history.replaceState(null, "", loc.pathname + (loc.hash || "")); // the code must not stay in the URL or history
    const saved = readJson(KEY_PKCE);
    g.sessionStorage.removeItem(KEY_PKCE); // single use
    if (refused) return { handled: true, ok: false, error: "Sign-in was cancelled or refused." };
    const unverified = { handled: true, ok: false, error: "Sign-in could not be verified." };
    if (!saved || !code || !constantTimeEqual(state || "", saved.state)) return unverified;
    let res;
    try {
      res = await g.fetch(tokenUrl(cfg), form({ grant_type: "authorization_code", client_id: cfg.clientId, code, redirect_uri: redirectUri(), code_verifier: saved.verifier }));
    } catch (e) { return { handled: true, ok: false, error: "Could not reach the sign-in service." }; }
    const tokens = res.ok ? await res.json().catch(() => null) : null;
    if (!tokens || !tokens.id_token) return { handled: true, ok: false, error: "Sign-in failed." };
    const payload = decodeJwtPayload(tokens.id_token);
    if (validateIdToken(payload, cfg, saved.nonce, Math.floor(Date.now() / 1000)).length) return unverified;
    setSession({ idToken: tokens.id_token, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000, email: payload.email || "" });
    return { handled: true, ok: true };
  }

  // One attempt. Concurrent callers share it so a refresh token is never spent twice.
  let refreshing = null;
  function refresh(cfg) {
    if (!refreshing) refreshing = doRefresh(cfg).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function doRefresh(cfg) {
    const s = getSession();
    if (!s || !s.refreshToken) { clearSession(); return false; }
    try {
      const res = await g.fetch(tokenUrl(cfg), form({ grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: s.refreshToken }));
      const tokens = res.ok ? await res.json().catch(() => null) : null;
      const payload = tokens && tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
      // The nonce belongs to the original authorize request; a refresh response is not required to repeat it.
      const problems = validateIdToken(payload, cfg, "", Math.floor(Date.now() / 1000)).filter((p) => !p.startsWith("nonce"));
      if (!tokens || !tokens.id_token || problems.length) { clearSession(); return false; }
      setSession(Object.assign({}, s, { idToken: tokens.id_token, accessToken: tokens.access_token || s.accessToken, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000, email: payload.email || s.email }));
      return true;
    } catch (e) { clearSession(); return false; }
  }

  async function signOut(cfg) {
    const s = getSession();
    if (s && s.refreshToken) {
      try { await g.fetch(`https://${cfg.cognitoDomain}/oauth2/revoke`, form({ token: s.refreshToken, client_id: cfg.clientId })); } catch (e) { /* best effort */ }
    }
    clearSession();
    g.sessionStorage.removeItem(KEY_PKCE);
    g.location.assign(buildLogoutUrl(cfg));
  }

  // ---- API client ----------------------------------------------------------------
  // Returns {status, body}; status 0 with networkError:true when the API could not be reached. Never throws.
  async function apiFetch(cfg, path, opts) {
    const o = opts || {};
    const qs = o.query ? "?" + new URLSearchParams(o.query) : "";
    const send = async () => {
      const s = getSession();
      const headers = { Accept: "application/json" };
      if (s && s.idToken) headers.Authorization = cfg.authHeaderScheme === "bearer" ? "Bearer " + s.idToken : s.idToken;
      if (o.body !== undefined) headers["Content-Type"] = "application/json";
      try {
        const res = await g.fetch(cfg.apiBaseUrl.replace(/\/+$/, "") + path + qs, { method: o.method || "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch (e) { return { status: 0, body: null, networkError: true }; }
    };
    let r = await send();
    if (r.status === 401 && (await refresh(cfg))) r = await send(); // one refresh, one retry
    return r;
  }

  function postForm(upload, file, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new g.FormData();
      for (const [k, v] of Object.entries(upload.fields)) fd.append(k, v); // policy fields first, the file last
      fd.append("file", file);
      const xhr = new g.XMLHttpRequest();
      xhr.open("POST", upload.url);
      if (xhr.upload) xhr.upload.onprogress = (e) => onProgress && onProgress(e.loaded, e.total);
      xhr.onload = () => resolve(xhr.status);
      xhr.onerror = () => reject(new Error("network"));
      xhr.send(fd);
    });
  }
  // Throws Error({status, body}) on failure so the caller can show errorMessage(). Returns the object keys.
  async function uploadFiles(cfg, files, onProgress) {
    const r = await apiFetch(cfg, "/uploads", { method: "POST", body: { files: files.map((f) => ({ name: f.name, contentType: f.type, size: f.size })) } });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.uploads) || r.body.uploads.length !== files.length) {
      throw Object.assign(new Error("upload request failed"), { status: r.status || 0, body: r.body });
    }
    await Promise.all(r.body.uploads.map(async (u, i) => {
      let status;
      try { status = await postForm(u, files[i], (loaded, total) => onProgress && onProgress(i, loaded, total)); }
      catch (e) { throw Object.assign(new Error("network"), { status: 0, body: null }); }
      if (![200, 201, 204].includes(status)) throw Object.assign(new Error("upload rejected"), { status, body: { message: `Upload of ${files[i].name} was refused (HTTP ${status}).` } });
    }));
    return r.body.uploads.map((u) => u.key);
  }
  const createJob = (cfg, keys, options) => apiFetch(cfg, "/jobs", { method: "POST", body: { task: "resize", inputs: keys, options } });
  const listJobs = (cfg) => apiFetch(cfg, "/jobs", { query: { limit: 50 } });
  const getJob = (cfg, jobId) => apiFetch(cfg, "/jobs/" + encodeURIComponent(jobId));

  // ---- config and CSP ---
  // The documented fields of config.json (config.example.json). Anything else, e.g. a client secret or a token, is refused.
  const REQUIRED_KEYS = ["apiBaseUrl", "region", "userPoolId", "clientId", "cognitoDomain", "inputBucketHost"];
  const CONFIG_KEYS = REQUIRED_KEYS.concat("authHeaderScheme");
  const unknownConfigKeys = (c) => (c && typeof c === "object" && !Array.isArray(c) ? Object.keys(c).filter((k) => !CONFIG_KEYS.includes(k)) : ["<not an object>"]);
  async function loadConfig() {
    if (g.location.protocol === "file:") return null; // fetch cannot read files; Simulation only
    try {
      const res = await g.fetch("config.json", { cache: "no-store" });
      if (!res.ok) return null;
      const c = await res.json();
      if (unknownConfigKeys(c).length) return null; // only documented, public fields are ever used
      for (const k of REQUIRED_KEYS) if (typeof c[k] !== "string" || !c[k]) return null;
      return Object.assign({}, c, { authHeaderScheme: c.authHeaderScheme === "bearer" ? "bearer" : "raw" });
    } catch (e) { return null; }
  }
  function buildCsp(cfg) {
    const api = new URL(cfg.apiBaseUrl).origin, cog = "https://" + cfg.cognitoDomain, bucket = "https://" + cfg.inputBucketHost;
    // A strict tightening of the static baseline in index.html (both policies apply, so the result is the intersection).
    return "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      "img-src 'self' blob: data: https://*.s3.us-east-2.amazonaws.com; " +
      `connect-src 'self' ${api} ${cog} ${bucket}`;
  }
  function applyCsp(cfg) {
    const m = g.document.createElement("meta");
    m.httpEquiv = "Content-Security-Policy";
    m.content = buildCsp(cfg);
    g.document.head.appendChild(m);
  }

  // ---- pure helpers for the Runs table and inspector --------------------------------
  const RANK = { queued: 0, processing: 1, completed: 2, failed: 2 };
  const isTerminal = (s) => s === "completed" || s === "failed";
  const isStale = (row, nowMs) =>
    (row.status === "queued" && nowMs - Date.parse(row.createdAt) > STALE_MS) ||
    (row.status === "processing" && nowMs - Date.parse(row.updatedAt || row.createdAt) > STUCK_MS);
  const needsPolling = (rows, nowMs) => rows.some((r) => (r.status === "queued" || r.status === "processing") && !isStale(r, nowMs));
  // Listed rows win unless the locally known row is further along (the index is eventually consistent).
  function mergeJobs(local, listed) {
    const byId = new Map();
    for (const r of listed) byId.set(r.jobId, r);
    for (const r of local) {
      const other = byId.get(r.jobId);
      if (!other || (RANK[r.status] ?? 0) > (RANK[other.status] ?? 0)) byId.set(r.jobId, r);
    }
    return Array.from(byId.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }
  // Which diagram nodes light up for a job status.
  function pipelineFor(status) {
    if (status === "queued") return [{ node: "apigw" }, { node: "sqs" }];
    if (status === "processing") return [{ node: "lambda" }];
    if (status === "completed") return [{ node: "s3", tone: "good" }];
    if (status === "failed") return [{ node: "lambda", tone: "bad" }];
    return [];
  }
  function checkFiles(files) {
    if (!files.length || files.length > MAX_FILES) return [`Choose between 1 and ${MAX_FILES} images.`];
    const out = [];
    for (const f of files) {
      if (!TYPES.includes(f.type)) out.push(`${f.name}: only JPEG, PNG or WebP images are accepted.`);
      else if (f.size < 1) out.push(`${f.name}: the file is empty.`);
      else if (f.size > MAX_BYTES) out.push(`${f.name}: ${(f.size / 1048576).toFixed(1)} MB is over the 5 MB limit.`);
      else if (f.name.length > 120) out.push(`${f.name.slice(0, 30)}…: file names must be 120 characters or fewer.`);
    }
    return out;
  }
  const dimensionOk = (v) => Number.isInteger(v) && v >= 16 && v <= 4096;
  // Maps an API result {status, body} to the sentence shown to the visitor (the backend's quotas and kill switch included).
  function errorMessage(r) {
    const text = String((r.body && (r.body.message || r.body.error)) || "");
    if (r.status === 0) return "Could not reach the API.";
    if (r.status === 401) return "Session expired, sign in again.";
    if (r.status === 400) return (r.body && r.body.message) || "The request was rejected.";
    // The backend's quota reply names itself; any other 429 is API Gateway throttling (also what a paused backend with throttle 0 returns).
    if (r.status === 429) {
      if (/daily job limit reached/i.test(text)) return "Daily job limit reached (per account or for the whole service); try again tomorrow.";
      if (/daily upload limit reached/i.test(text)) return "Daily upload limit reached (per account or for the whole service); try again tomorrow.";
      return "The service is busy or paused; try again in a minute. The browser demo still works.";
    }
    if (r.status === 503 && /processing is paused/i.test(text)) return "Live processing is paused by the operator; the browser demo still works.";
    if (r.status >= 500) return "AWS backend error; the browser demo still works.";
    return `Unexpected response (HTTP ${r.status}).`;
  }
  const safeUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? u : "");

  // Strings shown ONLY to a signed-in visitor talking to the real backend. They live here, not in index.html or app.js,
  // because the static test forbids "processed on AWS" phrasing anywhere in the browser/simulation workflow.
  const LABELS = {
    badge: "Real: processed on AWS",
    statement: "Real: processed on AWS. Your files went to a private S3 bucket and a queue, and the worker function wrote the results; the image links below are short-lived signed links.",
  };

  return {
    LABELS, randomString, pkceChallenge, constantTimeEqual, pageDirUrl, CONFIG_KEYS, unknownConfigKeys, buildAuthorizeUrl, buildLogoutUrl, decodeJwtPayload, validateIdToken,
    getSession, setSession, clearSession, beginSignIn, beginSignUp, handleCallback, refresh, signOut,
    apiFetch, uploadFiles, createJob, listJobs, getJob, loadConfig, buildCsp, applyCsp,
    isStale, isTerminal, needsPolling, mergeJobs, pipelineFor, checkFiles, dimensionOk, errorMessage, safeUrl,
    MAX_FILES, MAX_BYTES, STALE_MS, STUCK_MS,
  };
});
