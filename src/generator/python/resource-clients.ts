import type { DataSourceIR, StorageIR, SystemIR, WorkflowStmtIR } from "../../ir/types/loom-ir.js";
import { walkWorkflowStmtExprsDeep } from "../../ir/util/walk.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { resourceEnvBase } from "../../util/resource-env.js";
import { supportsSurfaceKind } from "../../util/source-types.js";

// ---------------------------------------------------------------------------
// Python ResourceAdapter — async client modules for the non-persistence
// infrastructure kinds (objectStore / queue / api).  Sibling of the
// dotnet `adapters/resource-clients.ts`; emits one module per sourceType
// under `app/resources/<sourceType>.py`, with one `async def
// <resource_snake>_<verb_snake>(...)` per (resource, verb).  The render
// layer (`render-expr.ts` resource-op case) calls
// `(await <resource_snake>_<verb_snake>(args))`; the workflow / dispatch
// emitters import the helpers from `app.resources.<sourceType>`.
//
// Library choices (all async, chosen for clean `mypy --strict` typing):
//   objectStore → boto3 (sync, boto3-stubs typed) wrapped in
//                 asyncio.to_thread so the helper stays `async`
//   queue       → aio-pika (async-native, py.typed)
//   api         → httpx   (async-native, fully typed)
//
// The closed verb vocabulary is the registry's (`ir/resource-verbs.ts`);
// `supports()` delegates to the sourceType registry so there is one
// source of truth.
// ---------------------------------------------------------------------------

interface PyResourceAdapter {
  readonly name: string;
  /** PEP 508 runtime deps (string list) merged into pyproject. */
  deps(): string[];
  /** Dev-only deps (type stubs) merged into pyproject's dev group. */
  devDeps(): string[];
  /** Full `app/resources/<sourceType>.py` body for the wired resources. */
  emitModule(resources: readonly DataSourceIR[], stores: readonly StorageIR[]): string;
}

function cfg(store: StorageIR | undefined, key: string): string | undefined {
  const entry = store?.config?.find((c) => c.key === key);
  return entry && entry.value.kind === "string" ? entry.value.value : undefined;
}

/** `salesFiles` → `SALES_FILES` (the env-var stem).  Shared with compose so
 *  the injected name and the read name cannot drift. */
const envVar = resourceEnvBase;

function storeOf(resource: DataSourceIR, stores: readonly StorageIR[]): StorageIR | undefined {
  return stores.find((s) => s.name === resource.storageName);
}

const s3Adapter: PyResourceAdapter = {
  name: "s3",
  deps: () => ["boto3>=1.35,<2"],
  devDeps: () => ["boto3-stubs[s3]>=1.35,<2"],
  emitModule(resources, stores): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      const bucket = cfg(storeOf(r, stores), "bucket") ?? "";
      body.push(
        `_${fn}_bucket = os.environ.get("${envVar(r.name)}_BUCKET", ${JSON.stringify(bucket)})`,
        "",
        "",
        `async def ${fn}_put(key: str, body: object) -> None:`,
        `    await asyncio.to_thread(`,
        `        _client.put_object,`,
        `        Bucket=_${fn}_bucket,`,
        "        Key=key,",
        "        Body=json.dumps(body).encode(),",
        '        ContentType="application/json",',
        "    )",
        "",
        "",
        `async def ${fn}_get(key: str) -> object | None:`,
        "    try:",
        `        res = await asyncio.to_thread(_client.get_object, Bucket=_${fn}_bucket, Key=key)`,
        "    except _client.exceptions.NoSuchKey:",
        "        return None",
        `    raw = await asyncio.to_thread(res["Body"].read)`,
        "    return json.loads(raw) if raw else None",
        "",
        "",
        `async def ${fn}_list(prefix: str) -> list[str]:`,
        "    res = await asyncio.to_thread(",
        `        _client.list_objects_v2, Bucket=_${fn}_bucket, Prefix=prefix`,
        "    )",
        '    return [o["Key"] for o in res.get("Contents", [])]',
        "",
        "",
        `async def ${fn}_signed_url(key: str) -> str:`,
        "    return await asyncio.to_thread(",
        "        _client.generate_presigned_url,",
        '        "get_object",',
        `        Params={"Bucket": _${fn}_bucket, "Key": key},`,
        "        ExpiresIn=3600,",
        "    )",
        "",
        "",
        `async def ${fn}_delete(key: str) -> None:`,
        `    await asyncio.to_thread(_client.delete_object, Bucket=_${fn}_bucket, Key=key)`,
        "",
        "",
        // Raw-bytes verbs consumed by the File upload/download endpoints
        // (M-T1.2).  Unlike put/get (which JSON-encode), these store the exact
        // bytes + contentType so a downloaded object streams back byte-identical.
        `async def ${fn}_put_bytes(key: str, body: bytes, content_type: str) -> None:`,
        "    await asyncio.to_thread(",
        "        _client.put_object,",
        `        Bucket=_${fn}_bucket,`,
        "        Key=key,",
        "        Body=body,",
        "        ContentType=content_type,",
        "    )",
        "",
        "",
        `async def ${fn}_get_bytes(key: str) -> tuple[bytes, str] | None:`,
        "    try:",
        `        res = await asyncio.to_thread(_client.get_object, Bucket=_${fn}_bucket, Key=key)`,
        "    except _client.exceptions.NoSuchKey:",
        "        return None",
        `    raw = await asyncio.to_thread(res["Body"].read)`,
        `    content_type = res.get("ContentType") or "application/octet-stream"`,
        "    return (raw, content_type)",
        "",
        "",
      );
    }
    return lines(
      '"""S3 object-store resource clients (resources.md).  Auto-generated."""',
      "",
      "import asyncio",
      "import json",
      "import os",
      "",
      "import boto3",
      "",
      '_client = boto3.client("s3")',
      "",
      "",
      body,
    );
  },
};

/** localDisk — a dependency-free local-directory object store (M-T1.2), the
 *  Python twin of `localDiskResourceAdapter` (hono/v4).  Stores each object's
 *  raw bytes under a data dir keyed by `key`, plus a `<key>.meta.json` sidecar
 *  carrying the contentType so a download round-trips its metadata.  Backs the
 *  File upload/download endpoints without any cloud SDK (stdlib `pathlib`). */
const localDiskAdapter: PyResourceAdapter = {
  name: "localDisk",
  deps: () => [],
  devDeps: () => [],
  emitModule(resources): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      body.push(
        `# objectStore '${r.name}' — local-directory store (raw bytes + sidecar meta).`,
        `_${fn}_dir = Path(os.environ.get("${envVar(r.name)}_DIR", "data/${r.name}"))`,
        "",
        "",
        // Guard against path traversal: minted keys are uuids, but a
        // `GET /files/{key}` param is caller-supplied, so keep the resolved
        // path inside the data dir.
        `def _${fn}_path(key: str) -> Path:`,
        '    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in key)',
        `    return _${fn}_dir / safe`,
        "",
        "",
        // Raw-bytes verbs — the File endpoints' storage seam.
        `async def ${fn}_put_bytes(key: str, body: bytes, content_type: str) -> None:`,
        `    _${fn}_dir.mkdir(parents=True, exist_ok=True)`,
        `    path = _${fn}_path(key)`,
        "    path.write_bytes(body)",
        '    path.with_name(path.name + ".meta.json").write_text(',
        '        json.dumps({"contentType": content_type, "size": len(body)})',
        "    )",
        "",
        "",
        `async def ${fn}_get_bytes(key: str) -> tuple[bytes, str] | None:`,
        `    path = _${fn}_path(key)`,
        "    if not path.exists():",
        "        return None",
        "    body = path.read_bytes()",
        '    content_type = "application/octet-stream"',
        '    meta = path.with_name(path.name + ".meta.json")',
        "    if meta.exists():",
        "        data = json.loads(meta.read_text())",
        '        stored = data.get("contentType")',
        "        if isinstance(stored, str):",
        "            content_type = stored",
        "    return (body, content_type)",
        "",
        "",
        // Vendor-neutral JSON verbs (parity with s3's put/get/list/delete) so
        // workflow bodies that reach the store keep working against localDisk.
        `async def ${fn}_put(key: str, body: object) -> None:`,
        `    await ${fn}_put_bytes(key, json.dumps(body).encode(), "application/json")`,
        "",
        "",
        `async def ${fn}_get(key: str) -> object | None:`,
        `    obj = await ${fn}_get_bytes(key)`,
        "    if obj is None:",
        "        return None",
        "    decoded: object = json.loads(obj[0])",
        "    return decoded",
        "",
        "",
        `async def ${fn}_list(prefix: str) -> list[str]:`,
        `    if not _${fn}_dir.exists():`,
        "        return []",
        "    return [",
        "        p.name",
        `        for p in _${fn}_dir.iterdir()`,
        '        if not p.name.endswith(".meta.json") and p.name.startswith(prefix)',
        "    ]",
        "",
        "",
        `async def ${fn}_delete(key: str) -> None:`,
        `    path = _${fn}_path(key)`,
        "    path.unlink(missing_ok=True)",
        '    path.with_name(path.name + ".meta.json").unlink(missing_ok=True)',
        "",
        "",
      );
    }
    return lines(
      '"""Local-directory object-store resource clients (resources.md).  Auto-generated."""',
      "",
      "import json",
      "import os",
      "from pathlib import Path",
      "",
      "",
      body,
    );
  },
};

const rabbitmqAdapter: PyResourceAdapter = {
  name: "rabbitmq",
  deps: () => ["aio-pika>=9.5,<10"],
  devDeps: () => [],
  emitModule(resources): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      body.push(
        `_${fn}_url = os.environ.get("${envVar(r.name)}", "amqp://guest:guest@${r.name}:5672")`,
        "",
        "",
        `async def _${fn}_channel() -> aio_pika.abc.AbstractChannel:`,
        `    global _${fn}_conn`,
        `    if _${fn}_conn is None or _${fn}_conn.is_closed:`,
        `        _${fn}_conn = await aio_pika.connect_robust(_${fn}_url)`,
        `    return await _${fn}_conn.channel()`,
        "",
        "",
        `async def ${fn}_enqueue(message: object) -> None:`,
        `    channel = await _${fn}_channel()`,
        `    await channel.declare_queue("${r.name}", durable=True)`,
        "    await channel.default_exchange.publish(",
        "        aio_pika.Message(",
        "            body=json.dumps(message).encode(),",
        "            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,",
        "        ),",
        `        routing_key="${r.name}",`,
        "    )",
        "",
        "",
        `async def ${fn}_publish(topic: str, message: object) -> None:`,
        `    channel = await _${fn}_channel()`,
        "    exchange = await channel.declare_exchange(",
        `        "${r.name}", aio_pika.ExchangeType.TOPIC, durable=True`,
        "    )",
        "    await exchange.publish(",
        "        aio_pika.Message(",
        "            body=json.dumps(message).encode(),",
        "            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,",
        "        ),",
        "        routing_key=topic,",
        "    )",
        "",
        "",
      );
    }
    const conns = resources.map(
      (r) => `_${snake(r.name)}_conn: aio_pika.abc.AbstractRobustConnection | None = None`,
    );
    return lines(
      '"""RabbitMQ queue resource clients (resources.md).  Auto-generated."""',
      "",
      "import json",
      "import os",
      "",
      "import aio_pika",
      "import aio_pika.abc",
      "",
      ...conns,
      "",
      "",
      body,
    );
  },
};

const restApiAdapter: PyResourceAdapter = {
  name: "restApi",
  deps: () => ["httpx>=0.28,<1"],
  devDeps: () => [],
  emitModule(resources, stores): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      const baseUrl = cfg(storeOf(r, stores), "baseUrl") ?? "";
      body.push(
        `_${fn}_base_url = os.environ.get("${envVar(r.name)}", ${JSON.stringify(baseUrl)})`,
        "",
        "",
        `async def ${fn}_get(path: str) -> object:`,
        `    async with httpx.AsyncClient(base_url=_${fn}_base_url) as client:`,
        "        res = await client.get(path)",
        "        res.raise_for_status()",
        "        return res.json()",
        "",
        "",
        `async def ${fn}_post(path: str, body: object) -> object:`,
        `    async with httpx.AsyncClient(base_url=_${fn}_base_url) as client:`,
        "        res = await client.post(path, json=body)",
        "        res.raise_for_status()",
        "        return res.json()",
        "",
        "",
      );
    }
    return lines(
      '"""REST-API resource clients (resources.md).  Auto-generated."""',
      "",
      "import os",
      "",
      "import httpx",
      "",
      "",
      body,
    );
  },
};

function mailFrom(r: DataSourceIR, stores: readonly StorageIR[]): string {
  return cfg(storeOf(r, stores), "from") ?? "no-reply@example.test";
}

const smtpAdapter: PyResourceAdapter = {
  name: "smtp",
  deps: () => ["aiosmtplib>=3.0,<4"],
  devDeps: () => [],
  emitModule(resources, stores): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      body.push(
        `_${fn}_url = os.environ.get("${envVar(r.name)}_URL", "smtp://localhost:1025")`,
        `_${fn}_from = os.environ.get("${envVar(r.name)}_FROM", ${JSON.stringify(mailFrom(r, stores))})`,
        "",
        "",
        `async def ${fn}_send(to: str, subject: str, body: str) -> None:`,
        `    parsed = urlparse(_${fn}_url)`,
        "    msg = EmailMessage()",
        `    msg["From"] = _${fn}_from`,
        '    msg["To"] = to',
        '    msg["Subject"] = subject',
        "    msg.set_content(body)",
        "    await aiosmtplib.send(",
        "        msg,",
        '        hostname=parsed.hostname or "localhost",',
        "        port=parsed.port or 25,",
        "        username=parsed.username or None,",
        "        password=parsed.password or None,",
        '        use_tls=parsed.scheme == "smtps",',
        "    )",
        "",
        "",
      );
    }
    return lines(
      '"""SMTP mailer resource clients (resources.md).  Auto-generated."""',
      "",
      "import os",
      "from email.message import EmailMessage",
      "from urllib.parse import urlparse",
      "",
      "import aiosmtplib",
      "",
      "",
      body,
    );
  },
};

const sesAdapter: PyResourceAdapter = {
  name: "ses",
  deps: () => ["boto3>=1.35,<2"],
  devDeps: () => ["boto3-stubs[ses]>=1.35,<2"],
  emitModule(resources, stores): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      const region = cfg(storeOf(r, stores), "region") ?? "us-east-1";
      body.push(
        `_${fn}_region = os.environ.get("${envVar(r.name)}_REGION", ${JSON.stringify(region)})`,
        `_${fn}_from = os.environ.get("${envVar(r.name)}_FROM", ${JSON.stringify(mailFrom(r, stores))})`,
        `_${fn}_client = boto3.client("ses", region_name=_${fn}_region)`,
        "",
        "",
        `async def ${fn}_send(to: str, subject: str, body: str) -> None:`,
        `    await asyncio.to_thread(`,
        `        _${fn}_client.send_email,`,
        `        Source=_${fn}_from,`,
        '        Destination={"ToAddresses": [to]},',
        '        Message={"Subject": {"Data": subject}, "Body": {"Text": {"Data": body}}},',
        "    )",
        "",
        "",
      );
    }
    return lines(
      '"""Amazon SES mailer resource clients (resources.md).  Auto-generated."""',
      "",
      "import asyncio",
      "import os",
      "",
      "import boto3",
      "",
      "",
      body,
    );
  },
};

const sendgridAdapter: PyResourceAdapter = {
  name: "sendgrid",
  deps: () => ["httpx>=0.28,<1"],
  devDeps: () => [],
  emitModule(resources, stores): string {
    const body: string[] = [];
    for (const r of resources) {
      const fn = snake(r.name);
      body.push(
        `_${fn}_key = os.environ.get("SENDGRID_API_KEY", "")`,
        `_${fn}_from = os.environ.get("${envVar(r.name)}_FROM", ${JSON.stringify(mailFrom(r, stores))})`,
        "",
        "",
        `async def ${fn}_send(to: str, subject: str, body: str) -> None:`,
        `    async with httpx.AsyncClient() as client:`,
        "        res = await client.post(",
        '            "https://api.sendgrid.com/v3/mail/send",',
        `            headers={"Authorization": f"Bearer {_${fn}_key}"},`,
        "            json={",
        '                "personalizations": [{"to": [{"email": to}]}],',
        `                "from": {"email": _${fn}_from},`,
        '                "subject": subject,',
        '                "content": [{"type": "text/plain", "value": body}],',
        "            },",
        "        )",
        "        res.raise_for_status()",
        "",
        "",
      );
    }
    return lines(
      '"""SendGrid mailer resource clients (resources.md).  Auto-generated."""',
      "",
      "import os",
      "",
      "import httpx",
      "",
      "",
      body,
    );
  },
};

const ADAPTERS: readonly PyResourceAdapter[] = [
  s3Adapter,
  localDiskAdapter,
  rabbitmqAdapter,
  restApiAdapter,
  smtpAdapter,
  sesAdapter,
  sendgridAdapter,
];

/** The Python ResourceAdapter realizing a sourceType, if any. */
function pyResourceAdapterFor(sourceType: string): PyResourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === sourceType);
}

/** Does any Python adapter realize `(sourceType, kind)`? */
export function pySupportsResource(sourceType: string, kind: DataSourceIR["kind"]): boolean {
  return !!pyResourceAdapterFor(sourceType) && supportsSurfaceKind(sourceType, kind);
}

export interface PyResourceEmission {
  /** `app/resources/<sourceType>.py` files keyed by relative path. */
  files: Map<string, string>;
  /** Runtime + dev deps the wired adapters need. */
  deps: string[];
  devDeps: string[];
  /** `<sourceType>` → its module path stem (`s3` → `app.resources.s3`),
   *  used by the workflow / dispatch emitters to import the verb helpers. */
  modules: string[];
}

/** Emit `app/resources/<sourceType>.py` client modules for every
 *  consumable resource the deployable wires (objectStore / queue / api),
 *  grouped by sourceType.  Persistence resources are ignored. */
export function emitPyResourceFiles(
  sys: SystemIR,
  dataSourceNames: readonly string[],
): PyResourceEmission {
  const files = new Map<string, string>();
  const deps: string[] = [];
  const devDeps: string[] = [];
  const modules: string[] = [];
  const wired = new Set(dataSourceNames);
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const bySourceType = new Map<string, DataSourceIR[]>();
  for (const r of sys.dataSources) {
    if (!wired.has(r.name)) continue;
    if (r.kind !== "objectStore" && r.kind !== "queue" && r.kind !== "api" && r.kind !== "mailer")
      continue;
    const st = storeType.get(r.storageName);
    if (!st || !pyResourceAdapterFor(st)) continue;
    const group = bySourceType.get(st);
    if (group) group.push(r);
    else bySourceType.set(st, [r]);
  }
  for (const [sourceType, group] of bySourceType) {
    const adapter = pyResourceAdapterFor(sourceType)!;
    files.set(`app/resources/${snake(sourceType)}.py`, adapter.emitModule(group, sys.storages));
    deps.push(...adapter.deps());
    devDeps.push(...adapter.devDeps());
    modules.push(snake(sourceType));
  }
  if (files.size > 0) files.set("app/resources/__init__.py", "");
  return { files, deps, devDeps, modules };
}

/** `<resource>.<verb>` → the verb helper's module + function name, for
 *  the workflow / dispatch emitters to build the import line.  The
 *  module is `app.resources.<sourceType_snake>`; the function is
 *  `<resource_snake>_<verb_snake>` (matching `render-expr.ts`). */
export function resourceVerbImport(
  sys: SystemIR,
  resourceName: string,
  verb: string,
): { module: string; fn: string } | undefined {
  const r = sys.dataSources.find((d) => d.name === resourceName);
  if (!r) return undefined;
  const sourceType = sys.storages.find((s) => s.name === r.storageName)?.type;
  if (!sourceType || !pyResourceAdapterFor(sourceType)) return undefined;
  return {
    module: `app.resources.${snake(sourceType)}`,
    fn: `${snake(resourceName)}_${snake(verb)}`,
  };
}

// ---------------------------------------------------------------------------
// Resource-op discovery — find every `<resource>.<verb>(...)` call in a
// workflow / saga statement sequence so the emitter can import the verb
// helpers from `app.resources.<sourceType>`.
// ---------------------------------------------------------------------------

/** Import lines (`from app.resources.<src> import a_put, b_get`) for every
 *  resource-op called across `statements`, deduped + grouped by module.
 *
 *  Both halves ride the SHARED, `never`-checked walker (`ir/util/walk.ts`).
 *  The untyped half used to walk a hand-enumerated statement/expression switch
 *  that reached neither `if-let`'s `thenBody`/`elseBody` nor
 *  `domain-service-call.call` / `repo-delete.entity` — so
 *  `if let o = … { salesFiles.put(…) }` emitted the call with no import (ruff
 *  F821 → runtime `NameError`) while the typed half, already on the deep
 *  walker, was fine.  One walker, one traversal, no second copy to drift. */
export function resourceImportLines(
  sys: SystemIR,
  statements: readonly WorkflowStmtIR[],
): string[] {
  const byModule = new Map<string, Set<string>>();
  // Typed in-system api helpers (M-T4.8): `<resource>_<operation_id>` from the
  // single generated client module.
  const apiFns = new Set<string>();
  for (const st of statements) {
    walkWorkflowStmtExprsDeep(st, (e) => {
      if (e.kind !== "call") return;
      if (e.callKind === "resource-op" && e.resourceOp) {
        const resolved = resourceVerbImport(sys, e.resourceOp.resourceName, e.resourceOp.verb);
        if (!resolved) return;
        const fns = byModule.get(resolved.module) ?? new Set<string>();
        fns.add(resolved.fn);
        byModule.set(resolved.module, fns);
      } else if (e.callKind === "remote-api-op" && e.remoteApiOp) {
        apiFns.add(`${snake(e.remoteApiOp.resourceName)}_${snake(e.remoteApiOp.operationId)}`);
      }
    });
  }
  if (apiFns.size > 0) {
    byModule.set("app.resources.api_clients", apiFns);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, fns]) => `from ${module} import ${[...fns].sort().join(", ")}`);
}
