// hono/v4 ResourceAdapters — boot-time client modules for the
// non-persistence infrastructure kinds (objectStore / queue / api).
//
// Each adapter emits a self-contained `resources/<sourceType>.ts`
// module: imports at the top, then one exported client handle per
// resource the deployable wires.  No call-sites — domain logic reaches
// these clients through a workflow-level surface designed later
// (RFC §Phase 4).  `supports()` delegates to the sourceType registry so
// kind/sourceType compatibility has one source of truth.

import type { Lines, ResourceAdapter } from "../../../../generator/_adapters/index.js";
import type { DataSourceIR, StorageIR } from "../../../../ir/types/loom-ir.js";
import { supportsSurfaceKind } from "../../../../util/source-types.js";

/** Read a string `config` value from a storage by key. */
function cfg(store: StorageIR | undefined, key: string): string | undefined {
  const entry = store?.config?.find((c) => c.key === key);
  return entry && entry.value.kind === "string" ? entry.value.value : undefined;
}

/** `SALES_FILES`-style SCREAMING_SNAKE env-var base for a resource. */
function envBase(resourceName: string): string {
  return resourceName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** `SALES_FILES_URL`-style env var name for a resource's connection. */
function envVar(resourceName: string): string {
  return `${envBase(resourceName)}_URL`;
}

/** Resolve each resource to the physical store it `use:`s. */
function storeOf(resource: DataSourceIR, stores: readonly StorageIR[]): StorageIR | undefined {
  return stores.find((s) => s.name === resource.storageName);
}

export const s3ResourceAdapter: ResourceAdapter = {
  name: "s3",
  supportedKinds: ["objectStore"],
  supports: (storageType, kind) => storageType === "s3" && supportsSurfaceKind("s3", kind),
  emitProjectDeps: () => ({
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0",
  }),
  emitClientModule(resources, stores): Lines {
    const out: string[] = [
      `import {`,
      `  DeleteObjectCommand,`,
      `  GetObjectCommand,`,
      `  ListObjectsV2Command,`,
      `  PutObjectCommand,`,
      `  S3Client,`,
      `} from "@aws-sdk/client-s3";`,
      `import { getSignedUrl } from "@aws-sdk/s3-request-presigner";`,
      ``,
    ];
    for (const r of resources) {
      const store = storeOf(r, stores);
      const region = cfg(store, "region") ?? "us-east-1";
      const endpoint = cfg(store, "endpoint");
      const bucket = cfg(store, "bucket") ?? "";
      out.push(`// objectStore '${r.name}' → bucket ${JSON.stringify(bucket)}`);
      out.push(
        `export const ${r.name}Bucket = process.env.${envVar(r.name)}_BUCKET ?? ${JSON.stringify(bucket)};`,
      );
      out.push(`export const ${r.name} = new S3Client({`);
      out.push(`  region: process.env.${envVar(r.name)}_REGION ?? ${JSON.stringify(region)},`);
      if (endpoint) {
        out.push(
          `  endpoint: process.env.${envVar(r.name)}_ENDPOINT ?? ${JSON.stringify(endpoint)},`,
        );
        out.push(`  forcePathStyle: true,`);
      }
      out.push(`});`);
      out.push(``);
      // Verb helpers consumed by workflow bodies (`files.put`/`files.get`
      // → `<resource>$put`/`<resource>$get`).  These own the SDK mapping
      // so the call site stays vendor-neutral.  `body` is the `json`
      // payload (stored as a UTF-8 JSON string); `get` returns the
      // parsed json or `null` when the key is absent.
      out.push(`export async function ${r.name}$put(key: string, body: unknown): Promise<void> {`);
      out.push(`  await ${r.name}.send(`);
      out.push(`    new PutObjectCommand({`);
      out.push(`      Bucket: ${r.name}Bucket,`);
      out.push(`      Key: key,`);
      out.push(`      Body: JSON.stringify(body),`);
      out.push(`      ContentType: "application/json",`);
      out.push(`    }),`);
      out.push(`  );`);
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$get(key: string): Promise<unknown> {`);
      out.push(`  try {`);
      out.push(
        `    const res = await ${r.name}.send(new GetObjectCommand({ Bucket: ${r.name}Bucket, Key: key }));`,
      );
      out.push(`    const text = await res.Body?.transformToString();`);
      out.push(`    return text ? JSON.parse(text) : null;`);
      out.push(`  } catch (err) {`);
      out.push(`    if ((err as { name?: string }).name === "NoSuchKey") return null;`);
      out.push(`    throw err;`);
      out.push(`  }`);
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$list(prefix: string): Promise<string[]> {`);
      out.push(
        `  const res = await ${r.name}.send(new ListObjectsV2Command({ Bucket: ${r.name}Bucket, Prefix: prefix }));`,
      );
      out.push(
        `  return (res.Contents ?? []).map((o) => o.Key ?? "").filter((k) => k.length > 0);`,
      );
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$signedUrl(key: string): Promise<string> {`);
      out.push(
        `  return getSignedUrl(${r.name}, new GetObjectCommand({ Bucket: ${r.name}Bucket, Key: key }), { expiresIn: 3600 });`,
      );
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$delete(key: string): Promise<void> {`);
      out.push(
        `  await ${r.name}.send(new DeleteObjectCommand({ Bucket: ${r.name}Bucket, Key: key }));`,
      );
      out.push(`}`);
      out.push(``);
      // Raw-bytes verbs consumed by the File upload/download endpoints
      // (M-T1.2).  Unlike `$put`/`$get` (which JSON-encode), these store the
      // exact bytes with their contentType, so a downloaded object streams
      // back byte-identical.
      out.push(
        `export async function ${r.name}$putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {`,
      );
      out.push(`  await ${r.name}.send(`);
      out.push(`    new PutObjectCommand({`);
      out.push(`      Bucket: ${r.name}Bucket,`);
      out.push(`      Key: key,`);
      out.push(`      Body: body,`);
      out.push(`      ContentType: contentType,`);
      out.push(`    }),`);
      out.push(`  );`);
      out.push(`}`);
      out.push(``);
      out.push(
        `export async function ${r.name}$getBytes(key: string): Promise<{ body: Uint8Array; contentType: string; size: number } | null> {`,
      );
      out.push(`  try {`);
      out.push(
        `    const res = await ${r.name}.send(new GetObjectCommand({ Bucket: ${r.name}Bucket, Key: key }));`,
      );
      out.push(`    const bytes = await res.Body?.transformToByteArray();`);
      out.push(`    if (!bytes) return null;`);
      out.push(
        `    return { body: bytes, contentType: res.ContentType ?? "application/octet-stream", size: bytes.byteLength };`,
      );
      out.push(`  } catch (err) {`);
      out.push(`    if ((err as { name?: string }).name === "NoSuchKey") return null;`);
      out.push(`    throw err;`);
      out.push(`  }`);
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

/** localDisk — a dependency-free local-directory object store (M-T1.2).
 *  Stores each object's raw bytes under a data dir keyed by `key`, plus a
 *  sidecar `<key>.meta.json` carrying the contentType/size so a download
 *  round-trips its metadata.  Backs the File upload/download endpoints
 *  without any cloud SDK. */
export const localDiskResourceAdapter: ResourceAdapter = {
  name: "localDisk",
  supportedKinds: ["objectStore"],
  supports: (storageType, kind) =>
    storageType === "localDisk" && supportsSurfaceKind("localDisk", kind),
  emitProjectDeps: () => ({}),
  emitClientModule(resources): Lines {
    const out: string[] = [
      `import { promises as fs } from "node:fs";`,
      `import * as path from "node:path";`,
      ``,
    ];
    for (const r of resources) {
      out.push(`// objectStore '${r.name}' — local-directory store (raw bytes + sidecar meta).`);
      out.push(
        `export const ${r.name}Dir = process.env.${envVar(r.name)}_DIR ?? path.join(process.cwd(), "data", ${JSON.stringify(r.name)});`,
      );
      out.push(``);
      out.push(`function ${r.name}$path(key: string): string {`);
      // Guard against path traversal: keys are minted server-side (uuids),
      // but a `GET /files/:key` param is caller-supplied, so keep the resolved
      // path inside the data dir.
      out.push(`  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_");`);
      out.push(`  return path.join(${r.name}Dir, safe);`);
      out.push(`}`);
      out.push(``);
      // Vendor-neutral JSON verbs (parity with s3's $put/$get) so workflow
      // bodies that reach the store keep working against localDisk.
      out.push(`export async function ${r.name}$put(key: string, body: unknown): Promise<void> {`);
      out.push(
        `  await ${r.name}$putBytes(key, Buffer.from(JSON.stringify(body)), "application/json");`,
      );
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$get(key: string): Promise<unknown> {`);
      out.push(`  const obj = await ${r.name}$getBytes(key);`);
      out.push(`  return obj ? JSON.parse(Buffer.from(obj.body).toString("utf8")) : null;`);
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$list(prefix: string): Promise<string[]> {`);
      out.push(`  try {`);
      out.push(`    const names = await fs.readdir(${r.name}Dir);`);
      out.push(
        `    return names.filter((n) => !n.endsWith(".meta.json") && n.startsWith(prefix));`,
      );
      out.push(`  } catch (err) {`);
      out.push(`    if ((err as { code?: string }).code === "ENOENT") return [];`);
      out.push(`    throw err;`);
      out.push(`  }`);
      out.push(`}`);
      out.push(``);
      out.push(`export async function ${r.name}$delete(key: string): Promise<void> {`);
      out.push(`  await fs.rm(${r.name}$path(key), { force: true });`);
      out.push(`  await fs.rm(${r.name}$path(key) + ".meta.json", { force: true });`);
      out.push(`}`);
      out.push(``);
      // Raw-bytes verbs — the File endpoints' storage seam.
      out.push(
        `export async function ${r.name}$putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {`,
      );
      out.push(`  await fs.mkdir(${r.name}Dir, { recursive: true });`);
      out.push(`  await fs.writeFile(${r.name}$path(key), body);`);
      out.push(
        `  await fs.writeFile(${r.name}$path(key) + ".meta.json", JSON.stringify({ contentType, size: body.byteLength }));`,
      );
      out.push(`}`);
      out.push(``);
      out.push(
        `export async function ${r.name}$getBytes(key: string): Promise<{ body: Uint8Array; contentType: string; size: number } | null> {`,
      );
      out.push(`  try {`);
      out.push(`    const body = await fs.readFile(${r.name}$path(key));`);
      out.push(`    let contentType = "application/octet-stream";`);
      out.push(`    try {`);
      out.push(
        `      const meta = JSON.parse(await fs.readFile(${r.name}$path(key) + ".meta.json", "utf8")) as { contentType?: string };`,
      );
      out.push(`      if (meta.contentType) contentType = meta.contentType;`);
      out.push(`    } catch { /* no sidecar — fall back to octet-stream */ }`);
      out.push(`    return { body, contentType, size: body.byteLength };`);
      out.push(`  } catch (err) {`);
      out.push(`    if ((err as { code?: string }).code === "ENOENT") return null;`);
      out.push(`    throw err;`);
      out.push(`  }`);
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

export const rabbitmqResourceAdapter: ResourceAdapter = {
  name: "rabbitmq",
  supportedKinds: ["queue"],
  supports: (storageType, kind) =>
    storageType === "rabbitmq" && supportsSurfaceKind("rabbitmq", kind),
  // `amqplib` ships no bundled type declarations, so the queue client needs
  // `@types/amqplib` or the generated project fails strict tsc (TS7016).
  emitProjectDeps: () => ({ amqplib: "^0.10.4", "@types/amqplib": "^0.10.5" }),
  emitClientModule(resources): Lines {
    const out: string[] = [`import * as amqp from "amqplib";`, ``];
    for (const r of resources) {
      out.push(`// queue '${r.name}' — channel opened lazily and cached.`);
      out.push(
        `export const ${r.name}Url = process.env.${envVar(r.name)} ?? "amqp://guest:guest@${r.name}:5672";`,
      );
      out.push(`let ${r.name}Channel: amqp.Channel | undefined;`);
      out.push(`async function ${r.name}$channel(): Promise<amqp.Channel> {`);
      out.push(`  if (!${r.name}Channel) {`);
      out.push(`    const conn = await amqp.connect(${r.name}Url);`);
      out.push(`    ${r.name}Channel = await conn.createChannel();`);
      out.push(`  }`);
      out.push(`  return ${r.name}Channel;`);
      out.push(`}`);
      out.push(``);
      // enqueue → default exchange, routing key = queue name (asserted).
      out.push(`export async function ${r.name}$enqueue(message: unknown): Promise<void> {`);
      out.push(`  const ch = await ${r.name}$channel();`);
      out.push(`  await ch.assertQueue("${r.name}", { durable: true });`);
      out.push(
        `  ch.sendToQueue("${r.name}", Buffer.from(JSON.stringify(message)), { persistent: true });`,
      );
      out.push(`}`);
      out.push(``);
      // publish → named topic exchange.
      out.push(
        `export async function ${r.name}$publish(topic: string, message: unknown): Promise<void> {`,
      );
      out.push(`  const ch = await ${r.name}$channel();`);
      out.push(`  await ch.assertExchange("${r.name}", "topic", { durable: true });`);
      out.push(
        `  ch.publish("${r.name}", topic, Buffer.from(JSON.stringify(message)), { persistent: true });`,
      );
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

export const restApiResourceAdapter: ResourceAdapter = {
  name: "restApi",
  supportedKinds: ["api"],
  supports: (storageType, kind) =>
    storageType === "restApi" && supportsSurfaceKind("restApi", kind),
  emitProjectDeps: () => ({}),
  emitClientModule(resources, stores): Lines {
    const out: string[] = [];
    for (const r of resources) {
      const baseUrl = cfg(storeOf(r, stores), "baseUrl") ?? "";
      out.push(`// api '${r.name}' — fetch-based client over the platform runtime.`);
      out.push(
        `export const ${r.name}BaseUrl = process.env.${envVar(r.name)} ?? ${JSON.stringify(baseUrl)};`,
      );
      out.push(``);
      out.push(`export async function ${r.name}$get(path: string): Promise<unknown> {`);
      out.push(`  const res = await fetch(new URL(path, ${r.name}BaseUrl));`);
      out.push(
        `  if (!res.ok) throw new Error(\`${r.name} GET \${path} failed: \${res.status}\`);`,
      );
      out.push(`  return res.json();`);
      out.push(`}`);
      out.push(``);
      out.push(
        `export async function ${r.name}$post(path: string, body: unknown): Promise<unknown> {`,
      );
      out.push(`  const res = await fetch(new URL(path, ${r.name}BaseUrl), {`);
      out.push(`    method: "POST",`);
      out.push(`    headers: { "content-type": "application/json" },`);
      out.push(`    body: JSON.stringify(body),`);
      out.push(`  });`);
      out.push(
        `  if (!res.ok) throw new Error(\`${r.name} POST \${path} failed: \${res.status}\`);`,
      );
      out.push(`  return res.json();`);
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

/** The `from:` sender address for a mailer resource — env-overridable,
 *  defaulting to the `from` config on the bound storage. */
function mailFromLine(r: DataSourceIR, stores: readonly StorageIR[]): string {
  const from = cfg(storeOf(r, stores), "from") ?? "no-reply@example.test";
  return `export const ${r.name}From = process.env.${envBase(r.name)}_FROM ?? ${JSON.stringify(from)};`;
}

export const smtpResourceAdapter: ResourceAdapter = {
  name: "smtp",
  supportedKinds: ["mailer"],
  supports: (storageType, kind) => storageType === "smtp" && supportsSurfaceKind("smtp", kind),
  // nodemailer ships no bundled type declarations.
  emitProjectDeps: () => ({ nodemailer: "^6.9.0", "@types/nodemailer": "^6.4.0" }),
  emitClientModule(resources, stores): Lines {
    const out: string[] = [`import nodemailer from "nodemailer";`, ``];
    for (const r of resources) {
      out.push(`// mailer '${r.name}' — SMTP transport (dev: Mailpit on :1025).`);
      out.push(mailFromLine(r, stores));
      out.push(
        `export const ${r.name}Transport = nodemailer.createTransport(process.env.${envVar(r.name)} ?? "smtp://${r.name}:1025");`,
      );
      out.push(``);
      out.push(
        `export async function ${r.name}$send(to: string, subject: string, body: string): Promise<void> {`,
      );
      out.push(
        `  await ${r.name}Transport.sendMail({ from: ${r.name}From, to, subject, text: body });`,
      );
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

export const sesResourceAdapter: ResourceAdapter = {
  name: "ses",
  supportedKinds: ["mailer"],
  supports: (storageType, kind) => storageType === "ses" && supportsSurfaceKind("ses", kind),
  emitProjectDeps: () => ({ "@aws-sdk/client-ses": "^3.700.0" }),
  emitClientModule(resources, stores): Lines {
    const out: string[] = [
      `import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";`,
      ``,
    ];
    for (const r of resources) {
      const region = cfg(storeOf(r, stores), "region") ?? "us-east-1";
      out.push(`// mailer '${r.name}' — Amazon SES.`);
      out.push(mailFromLine(r, stores));
      out.push(
        `export const ${r.name}Client = new SESClient({ region: process.env.${envBase(r.name)}_REGION ?? ${JSON.stringify(region)} });`,
      );
      out.push(``);
      out.push(
        `export async function ${r.name}$send(to: string, subject: string, body: string): Promise<void> {`,
      );
      out.push(`  await ${r.name}Client.send(`);
      out.push(`    new SendEmailCommand({`);
      out.push(`      Source: ${r.name}From,`);
      out.push(`      Destination: { ToAddresses: [to] },`);
      out.push(`      Message: { Subject: { Data: subject }, Body: { Text: { Data: body } } },`);
      out.push(`    }),`);
      out.push(`  );`);
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

export const sendgridResourceAdapter: ResourceAdapter = {
  name: "sendgrid",
  supportedKinds: ["mailer"],
  supports: (storageType, kind) =>
    storageType === "sendgrid" && supportsSurfaceKind("sendgrid", kind),
  emitProjectDeps: () => ({ "@sendgrid/mail": "^8.1.0" }),
  emitClientModule(resources, stores): Lines {
    const out: string[] = [`import sgMail from "@sendgrid/mail";`, ``];
    out.push(`sgMail.setApiKey(process.env.SENDGRID_API_KEY ?? "");`);
    out.push(``);
    for (const r of resources) {
      out.push(`// mailer '${r.name}' — SendGrid.`);
      out.push(mailFromLine(r, stores));
      out.push(``);
      out.push(
        `export async function ${r.name}$send(to: string, subject: string, body: string): Promise<void> {`,
      );
      out.push(`  await sgMail.send({ to, from: ${r.name}From, subject, text: body });`);
      out.push(`}`);
      out.push(``);
    }
    return out;
  },
};

const ADAPTERS: readonly ResourceAdapter[] = [
  s3ResourceAdapter,
  localDiskResourceAdapter,
  rabbitmqResourceAdapter,
  restApiResourceAdapter,
  smtpResourceAdapter,
  sesResourceAdapter,
  sendgridResourceAdapter,
];

/** The hono ResourceAdapter realizing a given sourceType, if any. */
export function resourceAdapterFor(sourceType: string): ResourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === sourceType);
}
