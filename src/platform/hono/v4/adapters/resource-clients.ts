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
import { supportsSurfaceKind } from "../../../../ir/source-types.js";
import type { DataSourceIR, StorageIR } from "../../../../ir/types/loom-ir.js";

/** Read a string `config` value from a storage by key. */
function cfg(store: StorageIR | undefined, key: string): string | undefined {
  const entry = store?.config?.find((c) => c.key === key);
  return entry && entry.value.kind === "string" ? entry.value.value : undefined;
}

/** `SALES_FILES_URL`-style env var name for a resource's connection. */
function envVar(resourceName: string): string {
  return `${resourceName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_URL`;
}

/** Resolve each resource to the physical store it `use:`s. */
function storeOf(resource: DataSourceIR, stores: readonly StorageIR[]): StorageIR | undefined {
  return stores.find((s) => s.name === resource.storageName);
}

export const s3ResourceAdapter: ResourceAdapter = {
  name: "s3",
  supportedKinds: ["objectStore"],
  supports: (storageType, kind) => storageType === "s3" && supportsSurfaceKind("s3", kind),
  emitProjectDeps: () => ({ "@aws-sdk/client-s3": "^3.700.0" }),
  emitClientModule(resources, stores): Lines {
    const out: string[] = [`import { S3Client } from "@aws-sdk/client-s3";`, ``];
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
    }
    return out;
  },
};

export const rabbitmqResourceAdapter: ResourceAdapter = {
  name: "rabbitmq",
  supportedKinds: ["queue"],
  supports: (storageType, kind) =>
    storageType === "rabbitmq" && supportsSurfaceKind("rabbitmq", kind),
  emitProjectDeps: () => ({ amqplib: "^0.10.4" }),
  emitClientModule(resources): Lines {
    const out: string[] = [`import * as amqp from "amqplib";`, ``];
    for (const r of resources) {
      out.push(`// queue '${r.name}' — connection opened lazily by the consumer (Phase 4).`);
      out.push(
        `export const ${r.name}Url = process.env.${envVar(r.name)} ?? "amqp://guest:guest@${r.name}:5672";`,
      );
      out.push(`export const connect${cap(r.name)} = () => amqp.connect(${r.name}Url);`);
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
      out.push(`// api '${r.name}' — typed client surface lands with the consumer (Phase 4).`);
      out.push(
        `export const ${r.name}BaseUrl = process.env.${envVar(r.name)} ?? ${JSON.stringify(baseUrl)};`,
      );
      out.push(`export const ${r.name} = {`);
      out.push(`  baseUrl: ${r.name}BaseUrl,`);
      out.push(
        `  fetch: (path: string, init?: RequestInit) => fetch(new URL(path, ${r.name}BaseUrl), init),`,
      );
      out.push(`};`);
      out.push(``);
    }
    return out;
  },
};

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

const ADAPTERS: readonly ResourceAdapter[] = [
  s3ResourceAdapter,
  rabbitmqResourceAdapter,
  restApiResourceAdapter,
];

/** The hono ResourceAdapter realizing a given sourceType, if any. */
export function resourceAdapterFor(sourceType: string): ResourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === sourceType);
}
