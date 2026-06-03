import type {
  AggregateIR,
  BoundedContextIR,
  LoomModel,
  ProvSite,
  StmtIR,
  SystemIR,
  TypeIR,
} from "../ir/types/loom-ir.js";
import { hasAnyProvSite, stmtHasProv } from "../ir/util/prov-id.js";

// ---------------------------------------------------------------------------
// Provenance rule-snapshot capture — the `ddd snapshot` prebuild step.
//
// Unlike the diffable `.loom/wire-spec.json` (regenerated in place every
// build), provenance snapshots are an immutable, append-only HISTORY:
// each capture writes one timestamped + GUID-named file under
// `.loom/snapshots/`, never overwriting a prior one.  A capture records
// every `provenanced` write-site as a rule snapshot — the RHS expression
// structure (text + fully-resolved IR `ast`) anchored at a source span,
// plus the resolved target field — with NO runtime values.  The runtime
// trace records (generated `domain/provenance.ts`) reference these by the
// content-addressed `snapshotId`, so a deployed build can always be
// explained against the capture taken from the same code.
//
// Invoked explicitly (CLI `ddd snapshot`, or the playground capture
// action) rather than auto-emitted on `generate system`: capturing a
// snapshot version is a deliberate step, like `dotnet ef migrations add`.
// ---------------------------------------------------------------------------

export interface LoomSnapDoc {
  /** GUID identifying this capture event (one per file). */
  captureId: string;
  system: string;
  commitHash: string;
  capturedAt: string;
  snapshots: Record<string, SnapshotEntry>;
}

export interface SnapshotEntry {
  kind: "write-site";
  target: { type: string; field: string; valueType: string };
  expression: { text: string; ast: unknown };
  source: { path: string; span: { start: number; end: number } };
}

/** Build the snapshot document for one system. */
export function buildLoomSnap(
  sys: SystemIR,
  envelope: { captureId: string; commitHash: string; capturedAt: string },
): LoomSnapDoc {
  const doc: LoomSnapDoc = {
    captureId: envelope.captureId,
    system: sys.name,
    commitHash: envelope.commitHash,
    capturedAt: envelope.capturedAt,
    snapshots: {},
  };
  for (const m of sys.subdomains) {
    for (const ctx of m.contexts) collectContext(ctx, doc);
  }
  return doc;
}

function collectContext(ctx: BoundedContextIR, doc: LoomSnapDoc): void {
  for (const agg of ctx.aggregates) {
    for (const op of agg.operations) {
      for (const s of op.statements) {
        if (stmtHasProv(s)) addEntry(doc, agg, s.prov, s);
      }
    }
  }
}

function addEntry(
  doc: LoomSnapDoc,
  agg: AggregateIR,
  prov: ProvSite,
  stmt: Extract<StmtIR, { kind: "assign" | "add" | "remove" }>,
): void {
  const field = agg.fields.find((f) => f.name === prov.target.field);
  doc.snapshots[prov.snapshotId] = {
    kind: "write-site",
    target: {
      type: prov.target.type,
      field: prov.target.field,
      valueType: field ? typeName(field.type) : "unknown",
    },
    expression: { text: prov.exprText, ast: stmt.value },
    source: prov.source,
  };
}

function typeName(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `${t.targetName} id`;
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `${typeName(t.element)}[]`;
    case "optional":
      return `${typeName(t.inner)}?`;
    case "slot":
      return "slot";
    case "genericInstance":
      return `${typeName(t.arg)} ${t.ctor}`;
  }
}

/**
 * Capture a snapshot file for every system that has at least one written
 * `provenanced` field.  Returns `relative path → content`; the path is a
 * fresh immutable `.loom/snapshots/<timestamp>-<guid>.loomsnap.json` per
 * system.  Shared by the CLI `snapshot` command and the playground.
 */
export function captureSnapshots(loom: LoomModel): Map<string, string> {
  const out = new Map<string, string>();
  const commitHash = resolveCommitHash();
  const capturedAt = new Date().toISOString();
  const stamp = compactStamp(capturedAt);
  for (const sys of loom.systems) {
    if (!hasAnyProvSite(sys)) continue;
    const captureId = newGuid();
    const doc = buildLoomSnap(sys, { captureId, commitHash, capturedAt });
    out.set(
      `.loom/snapshots/${stamp}-${captureId}.loomsnap.json`,
      JSON.stringify(doc, null, 2) + "\n",
    );
  }
  return out;
}

/** ISO timestamp → filesystem-safe compact form, e.g. `20260522T101500Z`. */
function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Browser- and Node-safe UUID (Web Crypto in workers, `crypto` global in
 *  Node 19+).  Falls back to a timestamp-seeded id if unavailable. */
function newGuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `nocrypto-${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`;
}

/** Best-effort git commit for the snapshot envelope.  Browser-safe: reads
 *  `LOOM_COMMIT_HASH` under Node (the CLI populates it), else
 *  `"uncommitted"`.  `snapshotId` is content-addressed and independent of
 *  this, so it only labels the capture envelope. */
export function resolveCommitHash(): string {
  if (typeof process !== "undefined" && process.env?.LOOM_COMMIT_HASH) {
    return process.env.LOOM_COMMIT_HASH;
  }
  return "uncommitted";
}
