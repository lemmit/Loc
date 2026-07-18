// Closed per-kind verb vocabulary for resource consumption from
// workflow bodies (RFC `workflow-resource-consumption.md` §3.1).
//
// Single source of truth — the data lives here at IR altitude.  IR
// validation (`ir/validate`) and the per-platform `ResourceAdapter`s
// read it directly; unlike the page-walker stdlib, no `language/`-side
// mirror is needed because resource-op validation runs in the IR layer
// (which may import `ir/`), not the AST validator.
//
// 4a ships `objectStore` `put` / `get` only, carrying `json`.  `list` /
// `signedUrl` / `delete`, plus the `queue` / `api` verbs, land in 4b —
// add a row here and an `emitOperation` arm in each adapter.

import type { DataSourceKind, LoomInterface } from "./types/loom-ir.js";

/** A primitive type name as it appears in a verb signature, plus the
 *  `?`-optional and `[]`-array shapes the vocabulary needs. */
export type VerbType = "string" | "json" | "json?" | "string[]" | "void";

export interface VerbParam {
  readonly name: string;
  readonly type: VerbType;
}

export interface ResourceVerbDef {
  /** Infra kind the verb belongs to (objectStore / queue / api). */
  readonly kind: DataSourceKind;
  /** The method name written in source (`files.put(...)`). */
  readonly verb: string;
  /** Capability the bound sourceType must offer for this verb (RFC §5). */
  readonly capability: string;
  readonly params: readonly VerbParam[];
  /** Result type; `void` when the verb returns nothing. */
  readonly result: VerbType;
  /** Per-verb access-interface override (RFC §3.5).  When set, this verb
   *  forces a specific interface rather than the resource's default —
   *  e.g. `signedUrl` is reached over `rest` even though the object
   *  store's default interface for backend use is `sdk`. */
  readonly interfaceOverride?: LoomInterface;
}

export const RESOURCE_VERBS: readonly ResourceVerbDef[] = [
  {
    kind: "objectStore",
    verb: "put",
    capability: "blob",
    params: [
      { name: "key", type: "string" },
      { name: "body", type: "json" },
    ],
    result: "void",
  },
  {
    kind: "objectStore",
    verb: "get",
    capability: "blob",
    params: [{ name: "key", type: "string" }],
    result: "json?",
  },
  {
    kind: "objectStore",
    verb: "list",
    capability: "list",
    params: [{ name: "prefix", type: "string" }],
    result: "string[]",
  },
  {
    kind: "objectStore",
    verb: "signedUrl",
    capability: "signedUrl",
    params: [{ name: "key", type: "string" }],
    result: "string",
    // Pre-signed URLs are produced by the REST signing flow, not the
    // SDK data path — force `rest` regardless of the resource default.
    interfaceOverride: "rest",
  },
  {
    kind: "objectStore",
    verb: "delete",
    capability: "blob",
    params: [{ name: "key", type: "string" }],
    result: "void",
  },
  {
    kind: "queue",
    verb: "enqueue",
    capability: "enqueue",
    params: [{ name: "message", type: "json" }],
    result: "void",
  },
  {
    kind: "queue",
    verb: "publish",
    capability: "publish",
    params: [
      { name: "topic", type: "string" },
      { name: "message", type: "json" },
    ],
    result: "void",
  },
  {
    kind: "api",
    verb: "get",
    capability: "request",
    params: [{ name: "path", type: "string" }],
    result: "json",
  },
  {
    kind: "api",
    verb: "post",
    capability: "request",
    params: [
      { name: "path", type: "string" },
      { name: "body", type: "json" },
    ],
    result: "json",
  },
  {
    // Surface `kind: mailer` → infra `email`.  Single plain-text verb for
    // v1; templated / HTML / multi-recipient email is a later slice.
    kind: "mailer",
    verb: "send",
    capability: "send",
    params: [
      { name: "to", type: "string" },
      { name: "subject", type: "string" },
      { name: "body", type: "string" },
    ],
    result: "void",
  },
];

/** Look up a verb definition by (kind, verb), or `undefined`. */
export function findVerb(kind: DataSourceKind, verb: string): ResourceVerbDef | undefined {
  return RESOURCE_VERBS.find((v) => v.kind === kind && v.verb === verb);
}

/** The verb names admissible for a kind, sorted — for diagnostics. */
export function verbsForKind(kind: DataSourceKind): string[] {
  return RESOURCE_VERBS.filter((v) => v.kind === kind)
    .map((v) => v.verb)
    .sort();
}
