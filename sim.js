/* CloudFlow browser simulation of Project 01.
 *
 * A deterministic, in-memory model of the deployed pipeline:
 * API Gateway (validator + mapping template) -> SQS main queue (visibility
 * timeout, redrive to a DLQ after three failed receives) -> Lambda event source
 * mapping (batches of five, partial batch failures) -> processor (a port of
 * app/processor.py) -> DynamoDB table and S3 results bucket (maps) -> status
 * handler (a port of app/status.py) -> CloudWatch alarm on the DLQ.
 *
 * Everything here is SIMULATED. Nothing talks to the network. Timestamps come
 * from a virtual clock that starts at 2026-11-04T19:00:00Z; ids come from a
 * seeded generator so every scenario replays identically. Real AWS results
 * live in evidence/*.md and are shown separately in the dashboard.
 *
 * UMD wrapper: loaded by index.html as a plain script (works from file://)
 * and by tests/sim.test.js under `node --test`.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CloudFlowSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Values copied from infra/variables.tf defaults and infra/lambda.tf.
  const CONFIG = Object.freeze({
    batchSize: 5,
    batchWindowSeconds: 5,
    visibilityTimeoutSeconds: 360,
    maxReceiveCount: 3,
    processorTimeoutSeconds: 60,
    simulatedWorkSeconds: 1,
    presignTtlSeconds: 300,
    jobTtlDays: 30,
    dlqRetentionDays: 14,
    resultsExpirationDays: 7,
    apiRateLimit: 10,
    apiBurstLimit: 5,
    apiDailyQuota: 1000,
    region: "us-east-2",
    // Placeholder names: the live suffix was random and is not needed here.
    bucket: "cdd-async-sim-results",
    table: "cdd-async-sim-jobs",
    mainQueue: "cdd-async-sim-main",
    dlq: "cdd-async-sim-dlq",
  });

  const EPOCH = Date.UTC(2026, 10, 4, 19, 0, 0); // 2026-11-04T19:00:00Z
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TASK_RE = /^[a-z][a-z0-9_]{0,63}$/;

  // ---- deterministic helpers -------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function uuidFrom(rand) {
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
      else if (i === 14) out += "4";
      else if (i === 19) out += hex[(Math.floor(rand() * 4) | 8)];
      else out += hex[Math.floor(rand() * 16)];
    }
    return out;
  }

  function iso(ms) {
    // Same shape as Python's datetime.now(timezone.utc).isoformat(): microseconds, +00:00.
    const d = new Date(ms);
    const pad = (n, w) => String(n).padStart(w, "0");
    const frac = d.getUTCMilliseconds() ? `.${pad(d.getUTCMilliseconds(), 3)}000` : "";
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T` +
      `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}${frac}+00:00`
    );
  }

  function clockLabel(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  }

  // Python json.dumps default separators are ", " and ": ". The processor
  // counts len(json.dumps(payload)), so the simulation must count the same way
  // (live result: {"hello": "world", "n": 3} -> 26 characters).
  function pythonDumps(value) {
    if (value === null) return "null";
    if (value === true) return "true";
    if (value === false) return "false";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(pythonDumps).join(", ") + "]";
    if (typeof value === "object") {
      return "{" + Object.keys(value).map((k) => JSON.stringify(k) + ": " + pythonDumps(value[k])).join(", ") + "}";
    }
    return "null";
  }

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  // ---- validation (schema + processor.validate_data) ---------------------

  // Mirrors infra/schemas/submit-job.schema.json (draft 4) as API Gateway
  // applies it to POST /submit, and app/processor.py:validate_data, which
  // re-checks the same rules on the queue side.
  function validateData(data, apiRoute) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return "data must be an object";
    const extra = Object.keys(data).filter((k) => k !== "task" && k !== "payload").sort();
    if (extra.length) return `unexpected keys [${extra.map((k) => `'${k}'`).join(", ")}]`;
    const task = data.task;
    if (typeof task !== "string" || !TASK_RE.test(task)) return "task must match ^[a-z][a-z0-9_]*$ (1-64 chars)";
    if ("payload" in data) {
      const p = data.payload;
      if (p === null || typeof p !== "object" || Array.isArray(p)) return "payload must be an object";
      if (Object.keys(p).length > 50) return "payload may have at most 50 properties";
    }
    // POST /submit refuses "resize" (the schema has not: enum [resize]); v2 jobs enter through POST /jobs.
    if (apiRoute && data.task === "resize") return 'task must not be "resize" on POST /submit (use POST /jobs)';
    // The queue side (app/processor.py:validate_data) checks the resize payload.
    if (!apiRoute && data.task === "resize") {
      const p = data.payload || {};
      if (typeof p.owner !== "string" || !p.owner) return "resize payload needs a non-empty owner";
      if (!Array.isArray(p.inputs) || p.inputs.length < 1 || p.inputs.length > 10 || !p.inputs.every((i) => typeof i === "string")) return "resize payload needs 1-10 string inputs";
      if (p.options === null || typeof p.options !== "object" || Array.isArray(p.options)) return "resize payload needs an options object";
    }
    return null;
  }

  // ---- world ---------------------------------------------------------------

  class World {
    constructor(opts) {
      opts = opts || {};
      this.rand = mulberry32(opts.seed === undefined ? 20261104 : opts.seed);
      this.now = EPOCH;
      this.events = [];
      this.queue = []; // main queue messages
      this.dlq = [];
      this.table = new Map(); // jobId -> item
      this.bucket = new Map(); // key -> object
      this.faults = new Map(); // jobId -> {s3Failures, lookupFailures, validationException}
      this.defects = { apiRoleTrustCondition: false, legacyPresignHost: false };
      this.alarms = { dlqMessages: "OK", processorErrors: "OK" };
      this.dlqSince = null;
      this.invocations = [];
      this.apiCalls = 0;
      this.invokeSeq = 0;
      this.validApiKey = "sim-api-key"; // placeholder, never a real key
    }

    uuid() {
      return uuidFrom(this.rand);
    }

    log(actor, kind, text, extra) {
      const e = Object.assign({ t: this.now, clock: clockLabel(this.now), actor, kind, text }, extra || {});
      this.events.push(e);
      return e;
    }

    advance(seconds) {
      this.now += Math.round(seconds * 1000);
      this.evaluateAlarms();
    }

    evaluateAlarms() {
      // dlq-messages: ApproximateNumberOfMessagesVisible >= 1, period 60 s,
      // 1 evaluation period, missing data not breaching.
      if (this.dlq.length >= 1 && this.dlqSince === null) this.dlqSince = this.now;
      if (this.dlqSince !== null && this.alarms.dlqMessages === "OK" && this.now >= this.dlqSince + 60 * 1000) {
        this.alarms.dlqMessages = "ALARM";
        this.log("cloudwatch", "alarm", "alarm dlq-messages: OK -> ALARM (ApproximateNumberOfMessagesVisible >= 1 for one 60 s period)", {
          alarm: "dlq-messages",
          state: "ALARM",
        });
        this.log("sns", "notify", "alarm action: message published to the alerts SNS topic (in the real run the email subscription was still pending, so no email was received)");
      }
    }

    snapshot() {
      return {
        now: this.now,
        clock: clockLabel(this.now),
        queue: this.queue.map((m) => ({ messageId: m.messageId, receiveCount: m.receiveCount, visible: m.visibleAt <= this.now, body: m.body })),
        dlq: this.dlq.map((m) => ({ messageId: m.messageId, receiveCount: m.receiveCount, body: m.body })),
        table: Array.from(this.table.values()).map(clone),
        bucket: Array.from(this.bucket.entries()).map(([key, o]) => ({ key, bytes: o.bytes, contentType: o.contentType, sse: o.sse, body: clone(o.body) })),
        alarms: Object.assign({}, this.alarms),
        invocations: this.invocations.map(clone),
      };
    }
  }

  // ---- API Gateway: POST /submit -----------------------------------------

  // headers: { "x-api-key": string|undefined, "content-type": string|undefined }
  // rawBody: the request body as text (what a client would actually send).
  function submit(world, req) {
    req = req || {};
    const headers = {};
    for (const k of Object.keys(req.headers || {})) headers[k.toLowerCase()] = req.headers[k];
    const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body === undefined ? {} : req.body);
    world.apiCalls += 1;
    const requestId = world.uuid();
    world.log("client", "request", `POST /submit (${rawBody.length} bytes)`, { http: "POST /submit", requestId });

    // 1. API key (usage plan) is checked before anything else.
    if (!headers["x-api-key"] || headers["x-api-key"] !== world.validApiKey) {
      world.log("apigw", "response", "403 Forbidden: missing or unknown x-api-key", { status: 403 });
      return { status: 403, body: { message: "Forbidden" }, requestId };
    }
    // 2. Request validator with the SubmitJob model, only for application/json.
    const contentType = (headers["content-type"] || "application/json").split(";")[0].trim();
    if (contentType === "application/json") {
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch (err) {
        world.log("apigw", "response", "400 Invalid request body: body is not JSON", { status: 400 });
        return { status: 400, body: { message: "Invalid request body" }, requestId };
      }
      const problem = validateData(parsed, true);
      if (problem) {
        world.log("apigw", "response", `400 Invalid request body (validator: ${problem})`, { status: 400 });
        return { status: 400, body: { message: "Invalid request body" }, requestId };
      }
      // 3. Integration: assume the API role and call SQS SendMessage.
      if (world.defects.apiRoleTrustCondition) {
        world.log(
          "apigw",
          "response",
          "500 Internal server error: execution failed, API Gateway does not have permission to assume the provided role (historical defect: aws:SourceAccount on the trust policy)",
          { status: 500 }
        );
        return { status: 500, body: { message: "Internal server error" }, requestId };
      }
      const message = { jobId: requestId, submittedAt: String(world.now), data: parsed };
      const body = JSON.stringify(message);
      world.log("apigw", "template", `mapping template built the SQS message: Action=SendMessage&Version=2012-11-05&MessageBody=<url-encoded ${body.length} bytes>`);
      enqueue(world, body, "apigw");
      world.log("apigw", "response", `202 Accepted: {"jobId":"${requestId}","status":"queued"}`, { status: 202, jobId: requestId });
      return { status: 202, body: { jobId: requestId, status: "queued" }, requestId };
    }
    // 4. Any other content type: passthrough NEVER, no template -> 415.
    world.log("apigw", "response", `415 Unsupported Media Type: no mapping template for ${contentType}`, { status: 415 });
    return { status: 415, body: { message: "Unsupported Media Type" }, requestId };
  }

  function enqueue(world, body, sender) {
    const msg = { messageId: world.uuid(), body, receiveCount: 0, visibleAt: world.now, sentAt: world.now };
    world.queue.push(msg);
    world.log("sqs", "enqueue", `SendMessage accepted on the main queue (messageId ${msg.messageId.slice(0, 8)}…, sender: ${sender})`, { messageId: msg.messageId });
    return msg;
  }

  // Direct SendMessage by a same-account principal, bypassing API Gateway
  // (what scripts/poison.py does). Only way to get a poison or rejected
  // message onto the queue, because the validator blocks them at the API.
  function sendRaw(world, body) {
    world.log("client", "request", `sqs send-message directly to the main queue (bypasses the API validator): ${JSON.stringify(body).slice(0, 80)}`);
    return enqueue(world, body, "direct send");
  }

  // ---- SQS + event source mapping ----------------------------------------

  function nextVisibleAt(world) {
    let t = Infinity;
    for (const m of world.queue) t = Math.min(t, m.visibleAt);
    return t;
  }

  function poll(world) {
    const batch = [];
    const remaining = [];
    for (const m of world.queue) {
      if (m.visibleAt > world.now || batch.length >= CONFIG.batchSize) {
        remaining.push(m);
        continue;
      }
      m.receiveCount += 1;
      if (m.receiveCount > CONFIG.maxReceiveCount) {
        // Redrive policy: receive count exceeded maxReceiveCount, move to the DLQ instead of delivering.
        world.dlq.push(m);
        world.log("sqs", "dlq", `message ${m.messageId.slice(0, 8)}… moved to the dead-letter queue (receive count ${m.receiveCount} > maxReceiveCount ${CONFIG.maxReceiveCount})`, {
          messageId: m.messageId,
        });
        continue;
      }
      m.visibleAt = world.now + CONFIG.visibilityTimeoutSeconds * 1000;
      batch.push(m);
    }
    world.queue = remaining;
    if (batch.length) {
      world.log("sqs", "receive", `event source mapping received ${batch.length} message(s); each hidden for the ${CONFIG.visibilityTimeoutSeconds} s visibility timeout`, {
        messageIds: batch.map((m) => m.messageId),
      });
    }
    world.evaluateAlarms();
    return batch;
  }

  // ---- processor (port of app/processor.py) ------------------------------

  function expiresAt(world) {
    return Math.floor((world.now + CONFIG.jobTtlDays * 86400 * 1000) / 1000);
  }

  function upsertJob(world, jobId, fields) {
    const now = iso(world.now);
    if (!world.table.has(jobId)) {
      world.table.set(jobId, Object.assign({ jobId, createdAt: now, updatedAt: now, expiresAt: expiresAt(world) }, clone(fields)));
      world.log("dynamodb", "put", `PutItem ${jobId.slice(0, 8)}… (condition attribute_not_exists(jobId)) status=${fields.status} attempts=${fields.attempts}`, { jobId });
      return;
    }
    world.log("dynamodb", "put", `PutItem ${jobId.slice(0, 8)}…: ConditionalCheckFailedException, item exists (a retry); falling back to a conditional update`, { jobId });
    updateUnlessCompleted(world, jobId, Object.assign({ updatedAt: now, expiresAt: expiresAt(world) }, fields));
  }

  function updateUnlessCompleted(world, jobId, fields) {
    const item = world.table.get(jobId);
    if (item && item.status === "completed") {
      world.log("dynamodb", "update", `UpdateItem ${jobId.slice(0, 8)}… skipped: condition "#status <> :completed" failed (job already completed)`, { jobId });
      return false;
    }
    if (item) Object.assign(item, clone(fields));
    else world.table.set(jobId, Object.assign({ jobId }, clone(fields)));
    world.log("dynamodb", "update", `UpdateItem ${jobId.slice(0, 8)}… SET status=${fields.status}${fields.error ? ", error=" + JSON.stringify(fields.error) : ""} attempts=${fields.attempts}`, { jobId });
    return true;
  }

  function updateJob(world, jobId, removeKeys, fields) {
    const item = world.table.get(jobId);
    Object.assign(item, clone(fields));
    for (const k of removeKeys) delete item[k];
    world.log("dynamodb", "update", `UpdateItem ${jobId.slice(0, 8)}… SET status=${fields.status}, resultKey=${fields.resultKey}${removeKeys.length ? " REMOVE " + removeKeys.join(", ") : ""}`, { jobId });
  }

  // Returns {ok, outcome}. ok=true means "delete the message"; ok=false means
  // "report it in batchItemFailures so SQS retries it".
  function processRecord(world, record) {
    const messageId = record.messageId;
    const attempts = Number(record.attributes.ApproximateReceiveCount);
    let body;
    let jobId;
    try {
      body = JSON.parse(record.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("'str' object has no attribute 'get'");
      jobId = body.jobId;
      if (!("jobId" in body)) throw Object.assign(new Error("'jobId'"), { name: "KeyError" });
      if (typeof jobId !== "string" || !UUID_RE.test(jobId)) throw Object.assign(new Error("malformed jobId"), { name: "ValueError" });
    } catch (err) {
      const name = err instanceof SyntaxError ? "JSONDecodeError" : err.name;
      world.log("processor", "poison", `poison message ${messageId.slice(0, 8)}…: ${name}(${JSON.stringify(err.message)}) -> reported in batchItemFailures, nothing written`, { messageId, outcome: "poison" });
      return { ok: false, outcome: "poison" };
    }
    const data = body.data;
    const submittedAt = body.submittedAt === undefined ? "" : body.submittedAt;
    const fault = world.faults.get(jobId) || {};

    // Duplicate check first, before any write.
    if (fault.lookupFailures > 0) {
      fault.lookupFailures -= 1;
      world.log("processor", "transient", `job ${jobId.slice(0, 8)}… lookup failed on attempt ${attempts}/${CONFIG.maxReceiveCount}: ClientError(ProvisionedThroughputExceededException) -> reported for retry`, { jobId, outcome: "transient" });
      return { ok: false, outcome: "transient" };
    }
    const existing = world.table.get(jobId);
    world.log("dynamodb", "get", `GetItem ${jobId.slice(0, 8)}… (ConsistentRead) -> ${existing ? "status=" + existing.status : "no item"}`, { jobId });
    if (existing && existing.status === "completed") {
      world.log("processor", "duplicate", `duplicate delivery of completed job ${jobId.slice(0, 8)}…, skipping (no writes, message deleted)`, { jobId, outcome: "duplicate" });
      return { ok: true, outcome: "duplicate" };
    }
    const problem = validateData(data);
    if (problem) {
      world.log("processor", "rejected", `rejected job ${jobId.slice(0, 8)}…: ${problem} -> status=failed, not retried`, { jobId, outcome: "rejected" });
      upsertJob(world, jobId, { status: "failed", error: `invalid job data: ${problem}`, attempts, submittedAt });
      return { ok: true, outcome: "rejected" };
    }

    if (data.task === "resize") return claimResize(world, jobId, data, attempts);
    const payload = data.payload === undefined ? {} : data.payload;
    upsertJob(world, jobId, { status: "processing", attempts, task: data.task, payload, submittedAt });
    world.log("processor", "work", `job ${jobId.slice(0, 8)}… processing (simulated work ${CONFIG.simulatedWorkSeconds} s)`, { jobId, outcome: "processing" });
    world.advance(CONFIG.simulatedWorkSeconds);

    if (fault.s3Failures > 0) {
      fault.s3Failures -= 1;
      world.log("s3", "error", `PutObject results/${jobId.slice(0, 8)}….json failed: ClientError(InternalError) (injected fault)`, { jobId });
      world.log("processor", "transient", `job ${jobId.slice(0, 8)}… transient failure on attempt ${attempts}/${CONFIG.maxReceiveCount}: ClientError: InternalError -> item marked failed, message reported for retry`, { jobId, outcome: "transient" });
      updateUnlessCompleted(world, jobId, { status: "failed", error: "ClientError: InternalError", attempts, updatedAt: iso(world.now), expiresAt: expiresAt(world) });
      return { ok: false, outcome: "transient" };
    }
    if (fault.validationException) {
      world.log("dynamodb", "error", `UpdateItem ${jobId.slice(0, 8)}… failed: ValidationException (item too large or nested too deep)`, { jobId });
      world.log("processor", "rejected", `job ${jobId.slice(0, 8)}… rejected failure on attempt ${attempts}/${CONFIG.maxReceiveCount}: ClientError: ValidationException -> permanent, message deleted`, { jobId, outcome: "rejected" });
      updateUnlessCompleted(world, jobId, { status: "failed", error: "ClientError: ValidationException", attempts, updatedAt: iso(world.now), expiresAt: expiresAt(world) });
      return { ok: true, outcome: "rejected" };
    }

    const key = `results/${jobId}.json`;
    const result = {
      jobId,
      task: data.task,
      result: { echo: clone(payload), characters: pythonDumps(payload).length },
      processedAt: iso(world.now),
      attempts,
    };
    const bytes = pythonDumps(result).length;
    world.bucket.set(key, { body: result, contentType: "application/json", sse: "AES256", bytes });
    world.log("s3", "put", `PutObject ${key} (${bytes} bytes, application/json, SSE-S3)`, { jobId, key });
    updateJob(world, jobId, ["error"], { status: "completed", resultKey: key, updatedAt: iso(world.now) });
    world.log("processor", "completed", `job ${jobId.slice(0, 8)}… completed on attempt ${attempts}`, { jobId, outcome: "completed" });
    return { ok: true, outcome: "completed" };
  }

  function invoke(world, batch) {
    if (!batch.length) return null;
    world.invokeSeq += 1;
    const requestId = world.uuid();
    const start = world.now;
    world.log("lambda", "invoke", `processor invoked with a batch of ${batch.length} (invocation ${world.invokeSeq})`, { requestId, size: batch.length });
    const failures = [];
    const outcomes = [];
    for (const m of batch) {
      const record = { messageId: m.messageId, body: m.body, attributes: { ApproximateReceiveCount: String(m.receiveCount) } };
      const r = processRecord(world, record);
      outcomes.push({ messageId: m.messageId, outcome: r.outcome });
      if (!r.ok) failures.push({ itemIdentifier: m.messageId });
    }
    const durationMs = world.now - start + 3;
    world.log("lambda", "return", `processor returned {"batchItemFailures": [${failures.length} item(s)]} after ${durationMs} ms`, { failures: failures.length });
    // The mapping deletes every message not reported; reported ones stay on
    // the queue, hidden until the visibility timeout expires.
    const failed = new Set(failures.map((f) => f.itemIdentifier));
    let deleted = 0;
    let retained = 0;
    for (const m of batch) {
      if (failed.has(m.messageId)) {
        world.queue.push(m);
        retained += 1;
      } else deleted += 1;
    }
    if (deleted) world.log("sqs", "delete", `event source mapping deleted ${deleted} succeeded message(s)`);
    if (retained)
      world.log("sqs", "retain", `${retained} reported message(s) stay on the queue, visible again at ${clockLabel(world.now + CONFIG.visibilityTimeoutSeconds * 1000 - (world.now - start))}`);
    const inv = { requestId, invocation: world.invokeSeq, startedAt: clockLabel(start), size: batch.length, failures: failures.length, durationMs, outcomes };
    world.invocations.push(inv);
    return inv;
  }

  // One worker step: advance the clock to the next visible message if needed, poll, invoke.
  function step(world) {
    if (!world.queue.length) return { idle: true };
    const nextAt = nextVisibleAt(world);
    if (nextAt > world.now) {
      const wait = (nextAt - world.now) / 1000;
      world.log("clock", "wait", `nothing visible; waiting ${wait} s for the visibility timeout to expire`, { waitSeconds: wait });
      world.advance(wait);
    } else {
      world.advance(CONFIG.batchWindowSeconds);
    }
    const batch = poll(world);
    if (!batch.length) return { idle: world.queue.length === 0, moved: true };
    return { idle: false, invocation: invoke(world, batch) };
  }

  function runUntilIdle(world, maxSteps) {
    let n = 0;
    while (n < (maxSteps || 50)) {
      const r = step(world);
      n += 1;
      if (r.idle) break;
    }
    if (world.dlqSince !== null && world.alarms.dlqMessages === "OK") {
      world.log("clock", "wait", "waiting 60 s for the next CloudWatch metric period", { waitSeconds: 60 });
      world.advance(60);
    }
    return n;
  }

  // ---- v2 routes (ports of app/api.py and app/tasks/resize.py) -------------
  // Used by the console's image jobs. The image bytes never enter the engine: the page resizes the files
  // in the browser and then hands the per-file outcomes to completeResize, which writes what the worker writes.

  const RESIZE_EXT = { jpeg: "jpg", png: "png", webp: "webp" };
  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_FILES = 10;
  const MAX_UPLOAD_BYTES = 5242880;

  function sanitiseName(key) {
    const base = String(key).split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, ".").slice(0, 120);
    return base || "file";
  }

  function stemOf(name) {
    const stem = name.slice(1).includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    return stem || "file";
  }

  const dimOk = (v) => Number.isInteger(v) && v >= 16 && v <= 4096;

  // app/tasks/resize.py:parse_options
  function parseOptions(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (!dimOk(raw.width) || !dimOk(raw.height)) return null;
    const o = { width: raw.width, height: raw.height, format: raw.format === undefined ? "jpeg" : raw.format, fit: raw.fit === undefined ? "inside" : raw.fit, upscale: raw.upscale === undefined ? false : raw.upscale };
    if (!(o.format in RESIZE_EXT) || (o.fit !== "inside" && o.fit !== "cover") || typeof o.upscale !== "boolean") return null;
    return o;
  }

  // The Cognito hosted sign-in (authorization code + PKCE). Returns the owner: the ID token's sub claim.
  function signIn(world) {
    const owner = world.uuid();
    world.log("client", "request", "sign-in on the Cognito hosted page (authorization code with PKCE) returned an ID token; its sub claim is the owner", { owner });
    return owner;
  }

  function reply(world, actor, status, body, text) {
    world.log(actor, "response", `${status} ${text}`, { status });
    return { status, body };
  }

  // POST /uploads: one presigned POST per file, keyed uploads/<owner>/<uploadId>/<index>-<name>.
  function createUploads(world, req) {
    const files = req.files;
    world.apiCalls += 1;
    world.log("client", "request", `POST /uploads for ${Array.isArray(files) ? files.length : 0} file(s), authorised by the ID token`, { http: "POST /uploads" });
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return reply(world, "apigw", 400, { message: `files must be a list of 1 to ${MAX_FILES} entries` }, `Bad request: files must be a list of 1 to ${MAX_FILES} entries`);
    const uploadId = world.uuid();
    const uploads = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {};
      if (typeof f.name !== "string" || f.name.length > 120) return reply(world, "apigw", 400, { message: "invalid name" }, "Bad request: invalid name");
      if (!IMAGE_TYPES.includes(f.contentType)) return reply(world, "apigw", 400, { message: "contentType must be image/jpeg, image/png or image/webp" }, "Bad request: contentType must be image/jpeg, image/png or image/webp");
      if (!Number.isInteger(f.size) || f.size < 1 || f.size > MAX_UPLOAD_BYTES) return reply(world, "apigw", 400, { message: `size must be an integer from 1 to ${MAX_UPLOAD_BYTES}` }, "Bad request: size out of range");
      const clean = sanitiseName(f.name);
      uploads.push({ name: clean, key: `uploads/${req.owner}/${uploadId}/${i}-${clean}`, url: "(simulated presigned POST: nothing is uploaded)" });
    }
    return reply(world, "apigw", 200, { uploads }, `OK: ${uploads.length} presigned POST(s) issued (simulated; the files stay in the browser)`);
  }

  // POST /jobs: validate, register the item as queued, send the SQS message, answer 202.
  function createJob(world, req) {
    const { owner, inputs } = req;
    world.apiCalls += 1;
    world.log("client", "request", `POST /jobs with the ID token and ${Array.isArray(inputs) ? inputs.length : 0} input key(s)`, { http: "POST /jobs" });
    const bad = (m) => reply(world, "apigw", 400, { message: m }, `Bad request: ${m}`);
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_FILES) return bad(`inputs must be a list of 1 to ${MAX_FILES} keys`);
    const prefix = `uploads/${owner}/`;
    for (const key of inputs) if (typeof key !== "string" || key.length > 1024 || !key.startsWith(prefix) || key.includes("..")) return bad("invalid input key");
    const options = parseOptions(req.options);
    if (options === null) return bad("invalid options");
    const jobId = world.uuid();
    const now = iso(world.now);
    const submittedAt = String(world.now);
    world.table.set(jobId, {
      jobId, owner, task: "resize", status: "queued", inputs: clone(inputs), options,
      files: inputs.map((key) => ({ name: sanitiseName(key), inputKey: key, status: "pending" })),
      fileCount: inputs.length, completedCount: 0, failedCount: 0, attempts: 0,
      createdAt: now, updatedAt: now, submittedAt, expiresAt: expiresAt(world),
    });
    world.log("dynamodb", "put", `PutItem ${jobId.slice(0, 8)}… (condition attribute_not_exists(jobId)) status=queued owner, inputs, options`, { jobId });
    const message = { jobId, submittedAt, data: { task: "resize", payload: { owner, inputs: clone(inputs), options } } };
    enqueue(world, JSON.stringify(message), "api function");
    world.log("apigw", "response", `202 Accepted: {"jobId":"${jobId}","status":"queued"}`, { status: 202, jobId });
    return { status: 202, body: { jobId, status: "queued" } };
  }

  // The worker's atomic claim (app/processor.py:claim). The resize itself is done by the page; see completeResize.
  function claimResize(world, jobId, data, attempts) {
    const item = world.table.get(jobId);
    const id = jobId.slice(0, 8) + "…";
    if (!item || item.owner !== data.payload.owner) {
      world.log("processor", "rejected", `rejected job ${id}: job not registered -> status=failed, not retried`, { jobId, outcome: "rejected" });
      updateUnlessCompleted(world, jobId, { status: "failed", error: "job not registered", attempts, updatedAt: iso(world.now) });
      return { ok: true, outcome: "rejected" };
    }
    Object.assign(item, { status: "processing", leaseOwner: world.uuid(), leaseUntil: Math.floor(world.now / 1000) + 130, attempts, updatedAt: iso(world.now) });
    world.log("dynamodb", "claim", `UpdateItem ${id} atomic claim: SET status=processing, leaseOwner, leaseUntil, attempts=${attempts}`, { jobId });
    world.log("processor", "work", `job ${id} resize: decoding and resizing are done by the page in the browser (the demo has no Pillow)`, { jobId, outcome: "processing" });
    return { ok: true, outcome: "awaiting-browser" };
  }

  // The worker's final writes (app/tasks/resize.py:run): per-file results, manifest, counts, final status.
  // results[i] = { status: "completed", width, height, bytes } or { status: "failed", error }.
  function completeResize(world, jobId, results) {
    const item = world.table.get(jobId);
    const ext = RESIZE_EXT[item.options.format];
    const files = item.inputs.map((key, i) => {
      const name = sanitiseName(key), r = results[i] || { status: "failed", error: "unsupported or corrupt image" };
      if (r.status !== "completed") return { name, inputKey: key, status: "failed", error: r.error };
      return { name, inputKey: key, status: "completed", outputKey: `results/${item.owner}/${jobId}/${i}-${stemOf(name)}.${ext}`, width: r.width, height: r.height, bytes: r.bytes };
    });
    const completed = files.filter((f) => f.status === "completed").length;
    const manifestKey = `results/${item.owner}/${jobId}/manifest.json`;
    const manifest = { jobId, options: item.options, files };
    const bytes = pythonDumps(manifest).length;
    world.bucket.set(manifestKey, { body: manifest, contentType: "application/json", sse: "AES256", bytes });
    world.log("s3", "put", `PutObject ${manifestKey} (${bytes} bytes, application/json, SSE-S3)`, { jobId, key: manifestKey });
    Object.assign(item, { files, completedCount: completed, failedCount: files.length - completed, manifestKey, status: completed ? "completed" : "failed", final: true, updatedAt: iso(world.now) });
    if (completed) delete item.error;
    else item.error = "all files failed";
    world.log("dynamodb", "update", `UpdateItem ${jobId.slice(0, 8)}… (condition: lease still held) SET status=${item.status}, files, completedCount=${completed}, failedCount=${files.length - completed}, manifestKey${item.error ? ", error=" + JSON.stringify(item.error) : ""}`, { jobId });
    world.log("sqs", "delete", "event source mapping deleted 1 succeeded message(s)");
    return clone(item);
  }

  // GET /jobs/{jobId}: the owner's own record only.
  function getJob(world, jobId, owner) {
    world.apiCalls += 1;
    world.log("client", "request", `GET /jobs/${String(jobId).slice(0, 8)}… with the ID token`, { http: "GET /jobs" });
    const item = world.table.get(jobId);
    if (!item || item.owner !== owner) return reply(world, "status", 404, { message: "not found" }, "not found");
    world.log("status", "response", `200: status=${item.status}`, { status: 200 });
    return { status: 200, body: clone(item) };
  }

  // ---- status handler (port of app/status.py) ----------------------------

  function presignedUrl(world, key) {
    const host = world.defects.legacyPresignHost ? `${CONFIG.bucket}.s3.amazonaws.com` : `${CONFIG.bucket}.s3.${CONFIG.region}.amazonaws.com`;
    const d = new Date(world.now);
    const pad = (n) => String(n).padStart(2, "0");
    const amzDate = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    return (
      `https://${host}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=<simulated>&X-Amz-Date=${amzDate}` +
      `&X-Amz-Expires=${CONFIG.presignTtlSeconds}&X-Amz-SignedHeaders=host&X-Amz-Security-Token=<simulated>&X-Amz-Signature=<simulated>`
    );
  }

  function status(world, jobId, opts) {
    world.apiCalls += 1;
    world.log("client", "request", `GET /status/${String(jobId).slice(0, 8)}…`, { http: "GET /status" });
    if (opts && opts.apiKey === false) {
      world.log("status", "response", "403 Forbidden: missing or unknown x-api-key", { status: 403 });
      return { status: 403, body: { message: "Forbidden" } };
    }
    if (!UUID_RE.test(String(jobId))) {
      world.log("status", "response", "400: jobId must be a UUID", { status: 400 });
      return { status: 400, body: { message: "jobId must be a UUID" } };
    }
    const item = world.table.get(jobId);
    if (!item) {
      world.log("status", "response", "202 pending: no item yet (not picked up by a worker, or unknown id)", { status: 202 });
      return { status: 202, body: { jobId, status: "pending", message: "not yet picked up by a worker, or unknown id" } };
    }
    const body = { jobId };
    for (const f of ["status", "task", "attempts", "submittedAt", "createdAt", "updatedAt"]) if (f in item) body[f] = clone(item[f]);
    if (item.status === "failed" && "error" in item) body.error = item.error;
    if (item.status === "completed") {
      body.resultKey = item.resultKey;
      body.resultUrl = presignedUrl(world, item.resultKey);
    }
    world.log("status", "response", `200: status=${item.status}${item.status === "completed" ? ", resultUrl (presigned GET, " + CONFIG.presignTtlSeconds + " s)" : ""}`, { status: 200 });
    return { status: 200, body };
  }

  // What a client sees when it follows the presigned URL (simulated S3).
  function fetchResult(world, url) {
    const m = /^https:\/\/([^/]+)\/(results\/[^?]+)\?/.exec(String(url || ""));
    if (!m) return { status: 400, body: { message: "not a presigned URL" } };
    const host = m[1];
    const key = m[2];
    if (host === `${CONFIG.bucket}.s3.amazonaws.com`) {
      world.log("s3", "redirect", `GET ${host}: 307 redirect to the regional host; signature covered the old host, so the redirected request fails (historical defect)`, { status: 403 });
      return { status: 403, body: { message: "SignatureDoesNotMatch after redirect" }, redirects: 1 };
    }
    if (/X-Amz-Signature=tampered/.test(url)) {
      world.log("s3", "get", `GET ${key}: 403 SignatureDoesNotMatch (tampered signature)`, { status: 403 });
      return { status: 403, body: { message: "SignatureDoesNotMatch" }, redirects: 0 };
    }
    const obj = world.bucket.get(key);
    if (!obj) return { status: 404, body: { message: "NoSuchKey" }, redirects: 0 };
    world.log("s3", "get", `GET ${key}: 200 (${obj.bytes} bytes, 0 redirects)`, { status: 200 });
    return { status: 200, body: clone(obj.body), bytes: obj.bytes, redirects: 0 };
  }

  // ---- scenarios -----------------------------------------------------------

  const GOOD_BODY = { task: "echo", payload: { hello: "world", n: 3 } };

  function withKey(extra) {
    return Object.assign({ "x-api-key": "sim-api-key", "content-type": "application/json" }, extra || {});
  }

  const SCENARIOS = [
    {
      id: "success",
      title: "Successful job",
      summary: "A valid submit is accepted with 202, waits on the queue, is processed once, and the status endpoint ends at 200 completed with a presigned result link.",
      expect: "202 queued → 202 pending → 200 completed, attempts 1, one S3 object, no error attribute.",
      run(world) {
        const r = submit(world, { headers: withKey(), body: GOOD_BODY });
        status(world, r.body.jobId);
        runUntilIdle(world);
        const s = status(world, r.body.jobId);
        fetchResult(world, s.body.resultUrl);
        return { jobId: r.body.jobId };
      },
    },
    {
      id: "invalid",
      title: "Invalid request",
      summary: "Four client mistakes, each stopped at API Gateway before anything touches the queue: a schema violation, a missing API key, a wrong Content-Type, and a body that is not JSON.",
      expect: "400 Invalid request body, 403 Forbidden, 415 Unsupported Media Type. The queue stays empty and no Lambda runs.",
      run(world) {
        submit(world, { headers: withKey(), body: { task: "Bad Task!", payload: {} } });
        submit(world, { headers: { "content-type": "application/json" }, body: GOOD_BODY });
        submit(world, { headers: withKey({ "content-type": "text/plain" }), rawBody: "task=echo" });
        submit(world, { headers: withKey(), rawBody: "{not json" });
        return {};
      },
    },
    {
      id: "transient",
      title: "Transient failure, then retry",
      summary: "The S3 write fails once. The processor marks the item failed with a short error, reports the message, and SQS redelivers it after the visibility timeout. The retry completes and removes the error.",
      expect: "attempt 1: failed, error ClientError: InternalError → wait 360 s → attempt 2: completed, attempts 2, error removed.",
      run(world) {
        const r = submit(world, { headers: withKey(), body: { task: "resize_image", payload: { width: 800 } } });
        world.faults.set(r.body.jobId, { s3Failures: 1 });
        step(world);
        status(world, r.body.jobId);
        runUntilIdle(world);
        status(world, r.body.jobId);
        return { jobId: r.body.jobId };
      },
    },
    {
      id: "duplicate",
      title: "Duplicate delivery",
      summary: "SQS standard queues are at-least-once. The same message is delivered a second time after the job completed. The processor reads the item first, sees completed, and skips without writing.",
      expect: "Second delivery logs 'duplicate delivery of completed job', the item and the S3 object are unchanged, attempts stays 1.",
      run(world) {
        const r = submit(world, { headers: withKey(), body: GOOD_BODY });
        const original = world.queue[0];
        runUntilIdle(world);
        // Redeliver a copy of the already-processed message (what at-least-once looks like).
        world.queue.push({ messageId: original.messageId, body: original.body, receiveCount: 0, visibleAt: world.now, sentAt: original.sentAt });
        world.log("sqs", "enqueue", `at-least-once delivery: a second copy of message ${original.messageId.slice(0, 8)}… becomes visible`, { messageId: original.messageId });
        runUntilIdle(world);
        status(world, r.body.jobId);
        return { jobId: r.body.jobId };
      },
    },
    {
      id: "poison",
      title: "Poison message and DLQ",
      summary: "A body that is not JSON reaches the queue directly (the API validator would have blocked it). The processor cannot find a job id, so it reports the message each time. After three receives SQS moves it to the dead-letter queue and the alarm fires.",
      expect: "Three receives 360 s apart, no table writes, DLQ depth 1 with receive count 4, alarm dlq-messages ALARM after the next metric period, processor-errors stays OK.",
      run(world) {
        sendRaw(world, "this is not valid json");
        runUntilIdle(world);
        return {};
      },
    },
    {
      id: "mixed",
      title: "Mixed batch, partial failure",
      summary: "Five messages arrive together: three good jobs, one poison body, one job whose S3 write fails once. With ReportBatchItemFailures only the two bad messages are retried; the three good ones are deleted after a single run.",
      expect: "Invocation 1: batch 5, batchItemFailures 2. Invocation 2 (after 360 s): the transient job completes on attempt 2; the poison keeps failing until the DLQ.",
      run(world) {
        const ids = [];
        for (const task of ["render_pdf", "send_digest", "index_doc"]) {
          const r = submit(world, { headers: withKey(), body: { task, payload: { n: ids.length } } });
          ids.push(r.body.jobId);
        }
        sendRaw(world, '{"jobId": "not-a-uuid", "data": {"task": "x"}}');
        const r = submit(world, { headers: withKey(), body: { task: "thumbnail", payload: { size: 128 } } });
        ids.push(r.body.jobId);
        world.faults.set(r.body.jobId, { s3Failures: 1 });
        runUntilIdle(world);
        for (const id of ids) status(world, id);
        return { jobIds: ids };
      },
    },
  ];

  function runScenario(id, seed) {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) throw new Error("unknown scenario " + id);
    const world = new World({ seed: seed === undefined ? 20261104 : seed });
    const result = sc.run(world);
    return { scenario: sc, world, result, events: world.events, snapshot: world.snapshot() };
  }

  return {
    CONFIG,
    EPOCH,
    World,
    submit,
    sendRaw,
    poll,
    invoke,
    step,
    runUntilIdle,
    status,
    fetchResult,
    validateData,
    signIn,
    createUploads,
    createJob,
    completeResize,
    getJob,
    parseOptions,
    pythonDumps,
    iso,
    clockLabel,
    SCENARIOS,
    runScenario,
  };
});
