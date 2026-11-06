/* CloudFlow architecture: the data behind the Architecture diagram (public copy).
 * Every box and arrow is drawn from the JSON block below; in the private repository a test checks each configuration
 * fact against the Terraform. Edge types: request, data, status, auth, failure. Control nodes have no edges: they
 * govern the services and are drawn as a strip, never as data flow. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CloudFlowArch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DATA = /*JSON-START*/{
  "versions": {
    "v2": {
      "label": "Current deployment",
      "title": "Serverless image processing",
      "status": "Deployed on AWS (us-east-2) on 2026-11-05 and verified end to end",
      "verified": true,
      "note": "120 resources from one terraform apply. Sign-in, direct uploads, processing, downloads, isolation between accounts, daily quotas, the dead-letter path, the operator switch and both cost-guard drills were exercised on the real services."
    }
  },
  "edgeTypes": {
    "request": {
      "label": "Request or message (no image bytes)",
      "style": "solid",
      "color": "primary"
    },
    "data": {
      "label": "Image or result bytes",
      "style": "solid",
      "color": "teal"
    },
    "status": {
      "label": "Job state, signatures (no bytes)",
      "style": "dashed",
      "color": "muted"
    },
    "auth": {
      "label": "Identity and tokens",
      "style": "dotted",
      "color": "amber"
    },
    "failure": {
      "label": "Failure path: retries, dead-letter, alarms",
      "style": "dashed",
      "color": "danger"
    }
  },
  "lanes": [
    "Client",
    "Edge and identity",
    "API",
    "Messaging",
    "Processing",
    "State and storage",
    "Operations"
  ],
  "nodes": [
    {
      "id": "client",
      "kind": "service",
      "category": "client",
      "versions": [
        "v2"
      ],
      "service": "Client",
      "name": {
        "v2": "CloudFlow Console"
      },
      "grid": {
        "v2": [
          0,
          0
        ]
      },
      "role": {
        "v2": "The browser console. It signs in through Cognito, asks the API for presigned upload slots, POSTs the image bytes straight to the private input bucket, creates the job, polls GET /jobs/{jobId}, and downloads results through presigned links. It never holds AWS credentials."
      },
      "config": {
        "v2": [
          "ID token kept in sessionStorage only (cleared when the tab closes)",
          "Uploads go directly to S3 with a presigned POST: the API never relays bytes",
          "Content-Security-Policy injected when the console config loads"
        ]
      },
      "security": {
        "v2": [
          "Authorization code flow with PKCE (S256), state and nonce; the ID token's nonce is checked before use",
          "Tokens expire after 60 minutes; refresh token after 1 day"
        ]
      },
      "source": [
        "scripts/submit_and_poll.py",
        "dashboard/live.js"
      ]
    },
    {
      "id": "cognito",
      "kind": "service",
      "category": "security",
      "versions": [
        "v2"
      ],
      "service": "Amazon Cognito",
      "name": {
        "v2": "User pool + Hosted UI"
      },
      "grid": {
        "v2": [
          1,
          0
        ]
      },
      "role": {
        "v2": "Identity for the console. The owner creates the only users; the hosted sign-in page runs the authorization code flow with PKCE and returns an ID token that API Gateway's authorizer validates on every application route. The token's `sub` becomes the owner prefix for the user's uploads, jobs and results."
      },
      "config": {
        "v2": [
          "Tier LITE (free tier), MFA off, deletion protection inactive",
          "Username is the e-mail address, case-insensitive (set at creation; cannot change later)",
          "Sign-up: admin-create-user only, verified e-mail recovery",
          "App client: no secret, OAuth code flow, scopes openid and email, provider COGNITO",
          "Callback and logout URL: exactly the console's own address (origin plus path), nothing else",
          "Explicit auth flows: refresh only (no SRP or password flow with just the client id)",
          "Token validity: ID 60 min, access 60 min, refresh 1 day; token revocation enabled",
          "Hosted domain: random prefix, classic hosted sign-in page"
        ]
      },
      "security": {
        "v2": [
          "prevent_user_existence_errors ENABLED: sign-in does not reveal whether a user exists",
          "No public registration",
          "Authorizer identity source: the Authorization header; the ID token is used so no custom scopes are needed"
        ]
      },
      "source": [
        "infra/cognito.tf",
        "infra/api_v2.tf"
      ]
    },
    {
      "id": "apigw",
      "kind": "service",
      "category": "integration",
      "versions": [
        "v2"
      ],
      "service": "Amazon API Gateway",
      "name": {
        "v2": "REST API (one stage)"
      },
      "grid": {
        "v2": [
          2,
          0
        ]
      },
      "role": {
        "v2": "The front door. Four Cognito-authorised routes are proxied to the api function: POST /uploads, POST /jobs, GET /jobs and GET /jobs/{jobId}, each with an OPTIONS preflight, and gateway errors carry CORS headers so the browser can read them. Two older API-key routes remain for operator testing: POST /submit writes straight to SQS without a Lambda function, and GET /status/{jobId} proxies to the status function."
      },
      "config": {
        "v2": [
          "Regional endpoint, one stage with X-Ray tracing",
          "Request validator on the body; models built from JSON schemas, with Terraform preconditions that fail the plan if a schema limit drifts from the variables",
          "COGNITO_USER_POOLS authorizer (identity source: the Authorization header) on POST /uploads, POST /jobs, GET /jobs and GET /jobs/{jobId}; each is an AWS_PROXY integration to the api function with its own Lambda permission",
          "OPTIONS on /uploads, /jobs and /jobs/{jobId}: MOCK integration returning the console origin, Authorization,Content-Type, GET,POST,OPTIONS and Access-Control-Max-Age 600, so a browser repeats the preflight at most every ten minutes",
          "Gateway responses DEFAULT_4XX and DEFAULT_5XX carry Access-Control-Allow-Origin so the browser can read 401 and 429 bodies",
          "Throttling is set per method, because a stage-wide limit applies to each method separately: default 2 requests/s (burst 4); uploads, job creation, the legacy routes and the three unauthenticated OPTIONS preflights 1 request/s (burst 2); job reads 2 requests/s (burst 4)",
          "A `paused` variable sets every throttle to zero, so a pause survives the next apply",
          "Detailed per-method CloudWatch metrics are off (they bill as custom metrics)",
          "Legacy API-key routes: POST /submit is an AWS integration to SQS SendMessage through an IAM role and a mapping template; GET /status/{jobId} proxies to the status function; a usage plan caps them at 1,000 requests a day"
        ]
      },
      "security": {
        "v2": [
          "Every application route needs a valid Cognito ID token; API Gateway rejects the rest with 401 before Lambda runs (observed live)",
          "Schema validation rejects malformed bodies with 400 before Lambda runs (observed live)",
          "Uploads and jobs are limited by daily quotas in the api function; the usage-plan quota covers only the legacy API-key routes",
          "A CloudWatch alarm on the request count trips the cost guard, which sets every throttle to zero (exercised live in a drill)",
          "Reserved task name: the POST /submit schema forbids `resize`, and the worker refuses any resize job that was not registered by the api function, so an API-key caller cannot create or claim a user's job"
        ]
      },
      "source": [
        "infra/apigw.tf",
        "infra/api_v2.tf",
        "infra/schemas/"
      ]
    },
    {
      "id": "api_lambda",
      "kind": "service",
      "category": "compute",
      "versions": [
        "v2"
      ],
      "service": "AWS Lambda",
      "name": {
        "v2": "api function"
      },
      "grid": {
        "v2": [
          3,
          0
        ]
      },
      "role": {
        "v2": "The request handler. It issues presigned POST slots for uploads, creates jobs (registers the item as queued, then sends the SQS message), lists the caller's jobs through the owner-index, and returns one job with presigned download links. The owner always comes from the validated token, never from the request body."
      },
      "config": {
        "v2": [
          "Python 3.12, 256 MB, 10 s timeout, X-Ray active, own log group (14 days)",
          "POST /uploads: 1 to 10 files, name ≤ 120 chars sanitised, type jpeg/png/webp, size 1 B to 5 MB; key uploads/<owner>/<uploadId>/<index>-<name>",
          "Presigned POST policy: exact Content-Type and content-length-range 1..5,242,880; expires in 60 s",
          "Daily quota on POST /uploads as well: 60 calls for the whole service and 20 per user, counted in the same transaction style as jobs; 429 \"daily upload limit reached\"",
          "POST /jobs: inputs must sit under uploads/<owner>/; item written as queued, then a message with the job id, owner, input keys and options",
          "Daily quotas on POST /jobs: 10 per user and 30 for the whole service per UTC day, both counters updated in one DynamoDB transaction (either both or neither); 429 when reached",
          "Processing switch: POST /uploads and POST /jobs answer 503 while the operator or the budget guard has paused processing",
          "GET /jobs: Query owner-index; nextToken is opaque base64 (not signed) and must belong to the caller; bad tokens and limits answer 400",
          "GET /jobs/{jobId}: 404 for anyone else's job; presigned GET links (300 s) only for keys under the caller's prefixes, signed locally with no S3 call"
        ]
      },
      "security": {
        "v2": [
          "IAM: s3:PutObject uploads/*, s3:GetObject uploads/* and results/*, dynamodb Put/Get/Update on the table, Query on owner-index only, sqs:SendMessage on the main queue; no ListBucket, DeleteObject, Scan or DeleteItem",
          "Error bodies are fixed strings; logs carry route, owner, decision and job id, never payloads or tokens",
          "Invoked only by its four route paths (one Lambda permission each)"
        ]
      },
      "source": [
        "app/api.py",
        "infra/lambda.tf",
        "infra/iam.tf"
      ]
    },
    {
      "id": "input",
      "kind": "service",
      "category": "storage",
      "versions": [
        "v2"
      ],
      "service": "Amazon S3",
      "name": {
        "v2": "Input bucket (private)"
      },
      "grid": {
        "v2": [
          1,
          1
        ]
      },
      "role": {
        "v2": "Where the browser puts the original images, one presigned POST per file, under the user's own prefix. Readers: the worker (GetObject) and the api function (HeadObject checks and presigned preview links for the owner's own files). Objects expire after a day, so the bucket never accumulates personal data."
      },
      "config": {
        "v2": [
          "All four public-access blocks on; SSE-S3 (AES256) with bucket keys",
          "Lifecycle: uploads/ expires after 1 day; incomplete multipart uploads aborted after 1 day",
          "CORS: the console origin only, POST and GET, max-age 300 s",
          "force_destroy so terraform destroy can empty it"
        ]
      },
      "security": {
        "v2": [
          "Bucket policy denies any request without TLS",
          "Upload key, content type and size range are pinned in the presigned POST policy, which is valid for 60 seconds; a different key or a larger file is rejected by S3",
          "Only the api function (PutObject/GetObject on uploads/*) and the worker (GetObject on uploads/*) hold permissions"
        ]
      },
      "source": [
        "infra/input_bucket.tf",
        "app/api.py"
      ]
    },
    {
      "id": "status_lambda",
      "kind": "service",
      "category": "compute",
      "versions": [
        "v2"
      ],
      "service": "AWS Lambda",
      "name": {
        "v2": "status function (legacy route)"
      },
      "grid": {
        "v2": [
          2,
          1
        ]
      },
      "role": {
        "v2": "Answers the legacy GET /status/{jobId} route for API-key clients: it reads one item and, when the job is completed, adds a presigned download link that works for five minutes. Jobs that belong to a signed-in user answer 404 here; those are read through GET /jobs/{jobId} on the api function."
      },
      "config": {
        "v2": [
          "Python 3.12, 128 MB, 10 s timeout, X-Ray active, own log group (14 days)",
          "Presigns against the regional S3 endpoint with SigV4",
          "Invoked only by GET /status/* of this API (Lambda permission source ARN)",
          "Items that carry an owner answer 404 on this route"
        ]
      },
      "security": {
        "v2": [
          "IAM: dynamodb:GetItem on the table and s3:GetObject on results/* only",
          "Owner isolation: no item with an owner is ever returned through the API-key route",
          "Fixed error bodies; the item's error field is a class name plus an AWS error code, never raw exception text"
        ]
      },
      "source": [
        "app/status.py",
        "infra/lambda.tf",
        "infra/iam.tf"
      ]
    },
    {
      "id": "sqs",
      "kind": "service",
      "category": "integration",
      "versions": [
        "v2"
      ],
      "service": "Amazon SQS",
      "name": {
        "v2": "Main queue"
      },
      "grid": {
        "v2": [
          3,
          1
        ]
      },
      "role": {
        "v2": "The buffer between accepting a job and doing it. Messages carry only the job id, the owner and the S3 keys: image bytes never travel through SQS. A taken message stays invisible for 720 seconds, six times the worker's 120-second timeout; a failed one reappears for another attempt, and after three failed receives SQS moves it to the dead-letter queue."
      },
      "config": {
        "v2": [
          "Standard queue, SQS-managed encryption",
          "Visibility timeout 720 s (six times the 120 s worker timeout)",
          "Redrive: maxReceiveCount 3 → dead-letter queue",
          "Queue policy allows the API Gateway integration role to SendMessage; the api function sends through its own IAM policy"
        ]
      },
      "security": {
        "v2": [
          "Queue policy denies any request without TLS",
          "SendMessage is granted only to the API Gateway integration role and the api function"
        ]
      },
      "source": [
        "infra/sqs.tf",
        "infra/variables.tf"
      ]
    },
    {
      "id": "lambda",
      "kind": "service",
      "category": "compute",
      "versions": [
        "v2"
      ],
      "service": "AWS Lambda",
      "name": {
        "v2": "processor (Pillow worker)"
      },
      "grid": {
        "v2": [
          4,
          1
        ]
      },
      "role": {
        "v2": "The image worker. One message at a time: it claims the job atomically in DynamoDB (a conditional UpdateItem that also takes a lease), fetches each input from the input bucket, decodes it behind a format allow-list and a 24-megapixel cap, resizes with Pillow, strips metadata, writes each output and a manifest to the results bucket under the owner's prefix, and records per-file outcomes. A corrupt file fails alone and is never retried; an AWS error is reported so SQS redelivers."
      },
      "config": {
        "v2": [
          "Python 3.12, 1024 MB, 120 s timeout, Pillow 13.0.0 layer (hash-pinned manylinux wheel, x86_64)",
          "Event source mapping: batch size 1 (variable allows 1 or 2), batching window 5 s, maximum concurrency 2, ReportBatchItemFailures",
          "LEASE_SECONDS = timeout + 10 = 130; MAX_IMAGE_PIXELS 24,000,000; MAX_UPLOAD_BYTES 5,242,880",
          "Outputs: results/<owner>/<jobId>/<index>-<stem>.<ext> plus manifest.json; the item records completedCount, failedCount and manifestKey",
          "X-Ray active; own log group, 14-day retention"
        ]
      },
      "security": {
        "v2": [
          "IAM: receive/delete on the main queue, Get/Put/Update on the table, GetObject on uploads/* and PutObject on results/* only; no ListBucket, no DeleteObject",
          "Lambda trust policy carries aws:SourceAccount (confused-deputy guard)",
          "Owner is taken from the registered item, never from the message; a message for someone else's job is refused by the claim condition",
          "Decoder allow-list (JPEG, PNG, WebP), decompression-bomb warnings promoted to errors, EXIF and ICC stripped from outputs"
        ]
      },
      "source": [
        "app/processor.py",
        "app/lease.py",
        "app/tasks/resize.py",
        "infra/lambda.tf",
        "infra/layer.tf",
        "infra/iam.tf"
      ]
    },
    {
      "id": "dynamodb",
      "kind": "service",
      "category": "database",
      "versions": [
        "v2"
      ],
      "service": "Amazon DynamoDB",
      "name": {
        "v2": "jobs table + owner-index"
      },
      "grid": {
        "v2": [
          4,
          0
        ]
      },
      "role": {
        "v2": "One item per job: owner, status, attempts, options, per-file counts, timestamps and the lease fields. A job is claimed with a single conditional UpdateItem that succeeds only if the job is new, queued, retryable, or held by an expired lease; every later write is conditional on still holding the lease, so two deliveries of one message cannot both run. The owner-index lets GET /jobs list one user's jobs newest first."
      },
      "config": {
        "v2": [
          "On-demand capacity (PAY_PER_REQUEST), partition key jobId; TTL on expiresAt (30 days), point-in-time recovery on, AWS-owned key encryption",
          "Global secondary index owner-index: partition owner, sort createdAt, projecting status, task, updatedAt, attempts, fileCount, completedCount, failedCount",
          "Claim condition: no `final` flag and (no status, or not completed and (not processing or lease expired))",
          "Lease fields leaseOwner = requestId:messageId and leaseUntil = now + 130 s; terminal writes set `final`",
          "A refused claim returns the current item (ReturnValuesOnConditionCheckFailure) so the worker classifies it without a second read",
          "The table also holds the daily quota counters and the processing switch as items with reserved ids; they are never returned as jobs"
        ]
      },
      "security": {
        "v2": [
          "The worker and the api function may Get, Put and Update; the api function may Query the owner index only; the status function may GetItem; nobody may Scan or Delete",
          "Error fields hold a class name and AWS error code, never raw messages"
        ]
      },
      "source": [
        "infra/dynamodb.tf",
        "app/processor.py",
        "app/lease.py"
      ]
    },
    {
      "id": "s3",
      "kind": "service",
      "category": "storage",
      "versions": [
        "v2"
      ],
      "service": "Amazon S3",
      "name": {
        "v2": "Results bucket (private)"
      },
      "grid": {
        "v2": [
          5,
          1
        ]
      },
      "role": {
        "v2": "Resized images and a manifest per job under results/<owner>/<jobId>/. GET /jobs/{jobId} returns presigned links only for keys under the caller's own prefix."
      },
      "config": {
        "v2": [
          "All four public-access blocks on; versioning on; SSE-S3 (AES256) with bucket keys",
          "Lifecycle: results/ expires after 7 days; noncurrent versions after 7 days; incomplete multipart uploads aborted after 7 days",
          "force_destroy so terraform destroy can empty it"
        ]
      },
      "security": {
        "v2": [
          "Bucket policy denies any request without TLS",
          "Writer: the worker (PutObject results/*). Readers: the api function and the status function (GetObject results/*), for presigning; no ListBucket anywhere"
        ]
      },
      "source": [
        "infra/s3.tf"
      ]
    },
    {
      "id": "dlq",
      "kind": "service",
      "category": "integration",
      "versions": [
        "v2"
      ],
      "service": "Amazon SQS",
      "name": {
        "v2": "Dead-letter queue"
      },
      "grid": {
        "v2": [
          3,
          2
        ]
      },
      "role": {
        "v2": "Receives any message the worker failed three times. Kept 14 days for inspection or redrive; nothing is silently dropped. A corrupt image never reaches it (that is recorded per file and not retried); only messages the worker could not process at all do."
      },
      "config": {
        "v2": [
          "Retention 14 days (the SQS maximum), SQS-managed encryption",
          "Redrive allow policy: byQueue, only the main queue may use it as a target"
        ]
      },
      "security": {
        "v2": [
          "Queue policy denies any request without TLS"
        ]
      },
      "source": [
        "infra/sqs.tf"
      ]
    },
    {
      "id": "alarm",
      "kind": "service",
      "category": "management",
      "versions": [
        "v2"
      ],
      "service": "Amazon CloudWatch",
      "name": {
        "v2": "Alarms (7)"
      },
      "grid": {
        "v2": [
          4,
          2
        ]
      },
      "role": {
        "v2": "Seven alarms: dead-letter queue depth, worker errors, api function errors, guard function errors, and the API request count over three windows (5 minutes for a flood, an hour and a day for a slow trickle). All notify the alerts topic; the three request-count alarms also trip the cost guard, which pauses the service."
      },
      "config": {
        "v2": [
          "dlq-messages: AWS/SQS ApproximateNumberOfMessagesVisible, Maximum ≥ 1 over one 60 s period, missing data not breaching",
          "processor-errors: AWS/Lambda Errors, Sum ≥ 1 over one 60 s period",
          "api-errors: AWS/Lambda Errors on the api function, Sum ≥ 1 over one 60 s period",
          "guard-errors: AWS/Lambda Errors on the guard function, Sum ≥ 1 over one 60 s period",
          "api-requests: AWS/ApiGateway Count, Sum ≥ 600 over one 300 s period (2 requests/s sustained); actions: alerts topic and the budget-guard topic",
          "api-requests-hour: Count Sum ≥ 3,000 over 3,600 s; api-requests-day: Count Sum ≥ 15,000 over 86,400 s; same two actions",
          "An alarm acts only when it changes from OK to ALARM, so the operator switch refuses to re-enable while one is still in ALARM"
        ]
      },
      "security": {
        "v2": [
          "Alarm actions publish to one SNS topic in the same account"
        ]
      },
      "source": [
        "infra/monitoring.tf"
      ]
    },
    {
      "id": "sns",
      "kind": "service",
      "category": "integration",
      "versions": [
        "v2"
      ],
      "service": "Amazon SNS",
      "name": {
        "v2": "Alerts topic → e-mail"
      },
      "grid": {
        "v2": [
          5,
          2
        ]
      },
      "role": {
        "v2": "The topic the alarms publish to, with an e-mail subscription that has to be confirmed once before alerts arrive. A second topic carries the cost-guard triggers (budget alerts and request alarms) to the guard function."
      },
      "config": {
        "v2": [
          "Alerts topic with one e-mail subscription (address from a Terraform variable, never committed)",
          "Budget-guard topic with a Lambda subscription"
        ]
      },
      "security": {
        "v2": [
          "The alert address lives in a gitignored tfvars file or the shell",
          "The guard topic accepts publishes only from AWS Budgets and this account's CloudWatch alarms"
        ]
      },
      "source": [
        "infra/monitoring.tf",
        "infra/variables.tf"
      ]
    },
    {
      "id": "iam",
      "kind": "control",
      "category": "security",
      "versions": [
        "v2"
      ],
      "service": "AWS IAM",
      "name": {
        "v2": "5 roles, least privilege"
      },
      "grid": {
        "v2": [
          0,
          3
        ]
      },
      "role": {
        "v2": "One role per function, plus one for the API Gateway queue integration, each with the exact actions its code calls on named resources. Not a data path: IAM decides whether each arrow above is allowed. A static test parses the Terraform and fails if any statement widens, if a role gains a policy outside the reviewed documents, or if a managed policy appears."
      },
      "config": {
        "v2": [
          "Queue-integration role (trusted by apigateway.amazonaws.com): sqs:SendMessage on the main queue only",
          "Worker role: queue receive/delete, table Get/Put/Update, GetObject uploads/*, PutObject results/*, logs on its own group, X-Ray",
          "api function role: PutObject uploads/*, GetObject uploads/* and results/*, table Put/Get/Update, Query owner-index, sqs:SendMessage, logs, X-Ray",
          "Status function role: table GetItem, GetObject results/*, logs, X-Ray",
          "Guard role: dynamodb:PutItem on the single control item only (dynamodb:LeadingKeys), apigateway:PATCH on this one API stage, plus its own log group"
        ]
      },
      "security": {
        "v2": [
          "Lambda trust policies carry aws:SourceAccount; the API Gateway trust does not, because API Gateway does not populate that key when assuming an integration role (every request returned 500 until it was removed: the first live bug)",
          "The only `*` resource is X-Ray, which supports nothing narrower",
          "Enforced by an automated test on every push"
        ]
      },
      "source": [
        "infra/iam.tf",
        "tests/test_iam_static.py"
      ]
    },
    {
      "id": "xray",
      "kind": "control",
      "category": "management",
      "versions": [
        "v2"
      ],
      "service": "AWS X-Ray",
      "name": {
        "v2": "Tracing: stage + 3 functions"
      },
      "grid": {
        "v2": [
          1,
          3
        ]
      },
      "role": {
        "v2": "Active tracing on the API stage and the three application functions, so a request can be followed across services; the budget guard is not traced. An observability control, not a data path."
      },
      "config": {
        "v2": [
          "tracing_config mode Active on the three application functions; xray_tracing_enabled on the stage"
        ]
      },
      "security": {
        "v2": [
          "The X-Ray write actions are the only IAM statements with a `*` resource"
        ]
      },
      "source": [
        "infra/lambda.tf",
        "infra/apigw.tf"
      ]
    },
    {
      "id": "logs",
      "kind": "control",
      "category": "management",
      "versions": [
        "v2"
      ],
      "service": "Amazon CloudWatch Logs",
      "name": {
        "v2": "4 log groups, 14 days"
      },
      "grid": {
        "v2": [
          2,
          3
        ]
      },
      "role": {
        "v2": "Explicit log groups with 14-day retention for the four functions, created before the functions so nothing is logged forever. Log lines carry ids, decisions and error codes, never payloads, tokens or raw exception text."
      },
      "config": {
        "v2": [
          "Retention 14 days (variable log_retention_days)",
          "API Gateway execution logging stays off: it needs an account-level CloudWatch role"
        ]
      },
      "security": {
        "v2": [
          "Each role may write only to its own log group (resource-scoped logs:CreateLogStream and logs:PutLogEvents)"
        ]
      },
      "source": [
        "infra/lambda.tf",
        "infra/iam.tf"
      ]
    },
    {
      "id": "terraform",
      "kind": "control",
      "category": "management",
      "versions": [
        "v2"
      ],
      "service": "Terraform",
      "name": {
        "v2": "One configuration, 104 resource blocks"
      },
      "grid": {
        "v2": [
          3,
          3
        ]
      },
      "role": {
        "v2": "Everything here comes from one `terraform apply` of 104 resource blocks (120 resources) and can leave with one `terraform destroy`. Random suffixes keep bucket, queue and sign-in domain names unique; every resource carries the Project tag. The configuration validates without the gitignored Pillow layer zip and refuses to plan without it."
      },
      "config": {
        "v2": [
          "Provider aws ≥ 6.23, region us-east-2, default tag Project = 01-async-api-platform",
          "Terraform ≥ 1.10; providers archive and random",
          "State and variables are gitignored",
          "Preconditions tie the request schemas to the variables and require the layer zip at plan time"
        ]
      },
      "security": {
        "v2": [
          "Nothing is applied or destroyed without an explicit instruction; the plan is reviewed first"
        ]
      },
      "source": [
        "infra/providers.tf",
        "infra/versions.tf",
        "infra/locals.tf",
        "infra/api_v2.tf",
        "infra/layer.tf"
      ]
    },
    {
      "id": "budget",
      "kind": "control",
      "category": "management",
      "versions": [
        "v2"
      ],
      "service": "AWS Budgets",
      "name": {
        "v2": "$10 budget + automatic pause"
      },
      "grid": {
        "v2": [
          4,
          3
        ]
      },
      "role": {
        "v2": "A cost guard, not a data path. One budget of $10, measured on gross usage before credits, e-mails at 20, 50, 80 and 95 percent of actual spend and when the forecast reaches 100 percent. The 80 and 95 percent alerts, and the three API request-count alarms, publish to an SNS topic that invokes a small guard function. It turns the processing switch off and sets every API throttle to zero: new uploads and jobs are refused and the site falls back to its browser demo. Budgets data can lag by up to a day, so the daily quotas and the request-count alarms are the fast limits."
      },
      "config": {
        "v2": [
          "Budget: type COST, limit 10 USD, credits and refunds excluded so it tracks usage before credits",
          "Notifications: actual spend at 20, 50, 80 and 95 percent, forecast at 100 percent, by e-mail; the 80 and 95 percent alerts also trip the guard",
          "Guard function: Python 3.12, 128 MB, 10 s; writes the switch off first, then sets the stage and per-method throttles to zero; if the throttle step fails it reports an error, which raises the guard-errors alarm; it never turns anything back on",
          "Operator switch: scripts/kill_switch.py disable | enable | status; for a pause that survives the next apply, set `paused = true` in Terraform"
        ]
      },
      "security": {
        "v2": [
          "Guard role: dynamodb:PutItem limited by dynamodb:LeadingKeys to the single control item, apigateway:PATCH on this one stage, and its own log group; no X-Ray, no wildcard",
          "Topic policy: only AWS Budgets and this account's own CloudWatch alarms may publish, over TLS",
          "AWS offers no hard spending cap below the Free plan itself; this is alerts plus a fail-closed switch, not a guarantee"
        ]
      },
      "source": [
        "infra/budgets.tf",
        "infra/guard.tf",
        "app/guard.py",
        "scripts/kill_switch.py"
      ]
    }
  ],
  "edges": [
    {
      "id": "e-submit",
      "from": "client",
      "to": "apigw",
      "type": "request",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "POST /uploads, POST /jobs, GET /jobs, GET /jobs/{jobId} (Bearer ID token)"
      }
    },
    {
      "id": "e-login",
      "from": "client",
      "to": "cognito",
      "type": "auth",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "Hosted UI sign-in, code + PKCE → ID token (60 min)"
      }
    },
    {
      "id": "e-authz",
      "from": "cognito",
      "to": "apigw",
      "type": "auth",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "authorizer validates the ID token on every application route"
      }
    },
    {
      "id": "e-apigw-sqs",
      "from": "apigw",
      "to": "sqs",
      "type": "request",
      "versions": [
        "v2"
      ],
      "legacy": [
        "v2"
      ],
      "label": {
        "v2": "legacy API-key route: POST /submit → SendMessage (refuses task resize)"
      }
    },
    {
      "id": "e-apigw-status",
      "from": "apigw",
      "to": "status_lambda",
      "type": "request",
      "versions": [
        "v2"
      ],
      "legacy": [
        "v2"
      ],
      "label": {
        "v2": "legacy API-key route: GET /status/{jobId}"
      }
    },
    {
      "id": "e-apigw-api",
      "from": "apigw",
      "to": "api_lambda",
      "type": "request",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "AWS_PROXY, one Lambda permission per route"
      }
    },
    {
      "id": "e-api-presign",
      "from": "api_lambda",
      "to": "input",
      "type": "status",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "signs presigned POST policies (key, type, 1 B–5 MB, 60 s) and preview GET links; HeadObject checks at job creation; no bytes"
      }
    },
    {
      "id": "e-upload",
      "from": "client",
      "to": "input",
      "type": "data",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "presigned POST: image bytes to uploads/<owner>/<uploadId>/<n>-<name>"
      }
    },
    {
      "id": "e-preview",
      "from": "input",
      "to": "client",
      "type": "data",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "GET presigned preview of the original (300 s, owner's keys only)"
      }
    },
    {
      "id": "e-api-ddb",
      "from": "api_lambda",
      "to": "dynamodb",
      "type": "status",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "PutItem queued (UpdateItem to failed if the send fails) · Query owner-index · GetItem"
      }
    },
    {
      "id": "e-api-sqs",
      "from": "api_lambda",
      "to": "sqs",
      "type": "request",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "SendMessage {jobId, submittedAt, data: {task: resize, payload: {owner, inputs, options}}}"
      }
    },
    {
      "id": "e-sqs-lambda",
      "from": "sqs",
      "to": "lambda",
      "type": "request",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "event source mapping, batch 1, max concurrency 2, ReportBatchItemFailures"
      }
    },
    {
      "id": "e-lambda-ddb",
      "from": "lambda",
      "to": "dynamodb",
      "type": "status",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "atomic claim + lease (130 s) → per-file counts → completed | failed"
      }
    },
    {
      "id": "e-lambda-input",
      "from": "input",
      "to": "lambda",
      "type": "data",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "GetObject uploads/<owner>/* (bounded read, decode allow-list)"
      }
    },
    {
      "id": "e-lambda-s3",
      "from": "lambda",
      "to": "s3",
      "type": "data",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "PutObject results/<owner>/<jobId>/<n>-<stem>.<ext> + manifest.json"
      }
    },
    {
      "id": "e-status-ddb",
      "from": "status_lambda",
      "to": "dynamodb",
      "type": "status",
      "versions": [
        "v2"
      ],
      "legacy": [
        "v2"
      ],
      "label": {
        "v2": "GetItem"
      }
    },
    {
      "id": "e-status-presign",
      "from": "status_lambda",
      "to": "s3",
      "type": "status",
      "versions": [
        "v2"
      ],
      "legacy": [
        "v2"
      ],
      "label": {
        "v2": "presigns GET (300 s); no bytes"
      }
    },
    {
      "id": "e-api-presign-results",
      "from": "api_lambda",
      "to": "s3",
      "type": "status",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "presigns GET links (300 s) for keys under results/<owner>/ only; no bytes"
      }
    },
    {
      "id": "e-download",
      "from": "s3",
      "to": "client",
      "type": "data",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "GET presigned URLs: resized image bytes"
      }
    },
    {
      "id": "e-redrive",
      "from": "sqs",
      "to": "dlq",
      "type": "failure",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "after 3 failed receives (visibility 720 s each)"
      }
    },
    {
      "id": "e-dlq-alarm",
      "from": "dlq",
      "to": "alarm",
      "type": "failure",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "ApproximateNumberOfMessagesVisible ≥ 1"
      }
    },
    {
      "id": "e-lambda-alarm",
      "from": "lambda",
      "to": "alarm",
      "type": "failure",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "Lambda Errors ≥ 1"
      }
    },
    {
      "id": "e-api-alarm",
      "from": "api_lambda",
      "to": "alarm",
      "type": "failure",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "Lambda Errors ≥ 1 (api-errors alarm)"
      }
    },
    {
      "id": "e-alarm-sns",
      "from": "alarm",
      "to": "sns",
      "type": "failure",
      "versions": [
        "v2"
      ],
      "label": {
        "v2": "alarm action → publish"
      }
    }
  ],
  "paths": {
    "legacy-success": {
      "version": "v2",
      "nodes": [
        "client",
        "apigw",
        "sqs",
        "lambda",
        "dynamodb",
        "s3",
        "status_lambda"
      ],
      "edges": [
        "e-submit",
        "e-apigw-sqs",
        "e-sqs-lambda",
        "e-lambda-ddb",
        "e-lambda-s3",
        "e-apigw-status",
        "e-status-ddb",
        "e-status-presign",
        "e-download"
      ]
    },
    "legacy-transient": {
      "version": "v2",
      "nodes": [
        "client",
        "apigw",
        "sqs",
        "lambda",
        "dynamodb",
        "s3"
      ],
      "edges": [
        "e-submit",
        "e-apigw-sqs",
        "e-sqs-lambda",
        "e-lambda-ddb",
        "e-lambda-s3"
      ]
    },
    "legacy-poison": {
      "version": "v2",
      "nodes": [
        "client",
        "apigw",
        "sqs",
        "lambda",
        "dlq",
        "alarm",
        "sns"
      ],
      "edges": [
        "e-submit",
        "e-apigw-sqs",
        "e-sqs-lambda",
        "e-redrive",
        "e-dlq-alarm",
        "e-alarm-sns"
      ]
    },
    "images": {
      "version": "v2",
      "nodes": [
        "client",
        "cognito",
        "apigw",
        "api_lambda",
        "input",
        "sqs",
        "lambda",
        "dynamodb",
        "s3"
      ],
      "edges": [
        "e-login",
        "e-authz",
        "e-submit",
        "e-apigw-api",
        "e-api-presign",
        "e-upload",
        "e-preview",
        "e-api-ddb",
        "e-api-sqs",
        "e-sqs-lambda",
        "e-lambda-input",
        "e-lambda-ddb",
        "e-lambda-s3",
        "e-api-presign-results",
        "e-download"
      ]
    }
  },
  "stageNodes": {
    "signin": [
      "client",
      "cognito"
    ],
    "uploads": [
      "client",
      "apigw",
      "api_lambda",
      "input"
    ],
    "submit": [
      "client",
      "apigw",
      "api_lambda",
      "dynamodb",
      "sqs"
    ],
    "queue": [
      "sqs"
    ],
    "worker": [
      "sqs",
      "lambda",
      "input",
      "s3"
    ],
    "record": [
      "lambda",
      "dynamodb"
    ],
    "status": [
      "client",
      "apigw",
      "api_lambda",
      "dynamodb",
      "s3"
    ],
    "dlq": [
      "sqs",
      "dlq"
    ],
    "alarm": [
      "dlq",
      "alarm",
      "sns"
    ]
  }
}/*JSON-END*/;

  const byId = Object.fromEntries(DATA.nodes.map((n) => [n.id, n]));
  const inVersion = (item, v) => item.versions.includes(v);
  const nodesFor = (v) => DATA.nodes.filter((n) => inVersion(n, v));
  const edgesFor = (v) => DATA.edges.filter((e) => inVersion(e, v));
  const text = (field, v) => (field && typeof field === "object" && !Array.isArray(field)) ? (field[v] !== undefined ? field[v] : "") : field;

  return Object.freeze({
    DATA,
    versions: DATA.versions,
    edgeTypes: DATA.edgeTypes,
    lanes: DATA.lanes,
    nodes: DATA.nodes,
    edges: DATA.edges,
    paths: DATA.paths,
    stageNodes: DATA.stageNodes,
    node: (id) => byId[id] || null,
    nodesFor,
    edgesFor,
    text,
    isLegacy: (edge, v) => Array.isArray(edge.legacy) && edge.legacy.includes(v),
  });
});
