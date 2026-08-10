// ---------------------------------------------------------------------------
// The EVOLUTION family of the toolkit — the transport-neutral core behind the
// `loom_snapshot` and `loom_diff` agent tools (and reusable by any surface).
//
// The playground's Migrations dock tab (M-T8.11) made schema migrations, wire-
// contract drift, and provenance snapshots VISIBLE to a human editing a model.
// These two functions give an AGENT editing a model the same evolution signals,
// riding the SAME shipped pure cores the dock does — `captureSnapshots`,
// `buildMigrations`, `buildWireSpec`/`diffWireSpec`, `renderPgStep`. All are
// browser-safe (the build worker already imports them), so this module keeps
// the toolkit's no-Node-only invariant.
//
// Scope note: like every other toolkit verb these take a SINGLE `.ddd` source
// string (the multi-file import-graph baselines the playground worker resolves
// via its VFS project loader are out of scope here — the single-file source is
// the one-entry case).  `diff` is the two-source counterpart of the dock's
// baseline picker: `baseline` is the previous `.ddd`, `current` is the new one.
// ---------------------------------------------------------------------------

import { EmptyFileSystem, type LangiumDocument, URI } from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import type { JsonDiagnostic } from "../diagnostics/contract.js";
import { diagMessage } from "../diagnostics/messages.js";
import { renderPgStep } from "../generator/sql-pg.js";
import { enrichLoomModel } from "../ir/enrich/enrichments.js";
import { lowerModel, mergeLoomModels } from "../ir/lower/lower.js";
import type { EnrichedLoomModel } from "../ir/types/loom-ir.js";
import type { SchemaSnapshot } from "../ir/types/migrations-ir.js";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { captureSnapshots } from "../system/loomsnap.js";
import { buildMigrations, MigrationDestructiveError } from "../system/migrations-builder.js";
import type { SnapshotStore } from "../system/snapshot.js";
import { buildWireSpec } from "../system/wire-spec.js";
import { diffWireSpec } from "../system/wire-spec-diff.js";
import { langiumDiagnosticToJson } from "./report.js";

type EnrichedSystemIR = EnrichedLoomModel["systems"][number];

/** One captured provenance-rule snapshot file (the `ddd snapshot` output). */
export interface SnapshotFile {
  /** Relative artifact path, e.g. `.loom/snapshots/<ts>-<guid>.loomsnap.json`. */
  path: string;
  /** The immutable snapshot JSON. */
  content: string;
}

/** Result of a provenance-snapshot capture — the toolkit twin of `ddd snapshot`
 *  and the playground's snapshot button.  `files` is empty (with `ok: true`)
 *  when the model writes no `provenanced` field, so there is nothing to snapshot. */
export interface SnapshotReport {
  ok: boolean;
  files: SnapshotFile[];
  diagnostics: JsonDiagnostic[];
}

/** One derived schema-migration step, rendered to Postgres SQL for display. */
export interface MigrationStepView {
  op: string;
  sql: string;
}

/** One derived schema migration a source change implies, per owning module. */
export interface MigrationView {
  module: string;
  /** Human-readable name — `"Initial"` on first run, `"AddOrderStatus"` etc. */
  name: string;
  /** Deterministic `<YYYYMMDDHHMMSS>` version slug. */
  version: string;
  steps: MigrationStepView[];
  /** True when the delta drops/loses data — the `--allow-destructive` gate. */
  destructive: boolean;
  /** The `MigrationDestructiveError` message when `destructive`. */
  destructiveMessage?: string;
}

/** One wire-contract change from baseline → current, classified breaking. */
export interface WireChangeView {
  /** `"aggregate Order"` / `"value object Money"` etc. */
  entity: string;
  field?: string;
  kind: string;
  /** True under consumer-compatibility semantics (a removed/retyped field). */
  breaking: boolean;
  detail?: string;
}

/** Result of an evolution diff — the migration + wire-contract delta a change
 *  implies.  `breaking` is true on ANY breaking wire change OR destructive
 *  migration (the single red-flag the human dock surfaces as a red dot). */
export interface DiffReport {
  ok: boolean;
  /** False when no usable baseline was supplied/loadable — every shape reads
   *  "Initial" and the wire diff is skipped as all-new noise. */
  hasBaseline: boolean;
  migrations: MigrationView[];
  wireChanges: WireChangeView[];
  breaking: boolean;
  diagnostics: JsonDiagnostic[];
}

interface ParsedSource {
  doc: LangiumDocument<Model>;
  model: Model | undefined;
  diagnostics: Diagnostic[];
}

/** Parse a `.ddd` source in-memory on a fresh, isolated service instance —
 *  browser-safe (EmptyFileSystem), mirroring `src/api/index.ts`'s parseSource. */
async function parseSource(source: string): Promise<ParsedSource> {
  const services = createDddServices(EmptyFileSystem);
  const factory = services.shared.workspace.LangiumDocumentFactory;
  const doc = factory.fromString<Model>(source, URI.parse("memory:///source.ddd"));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return {
    doc,
    model: doc.parseResult.value as Model | undefined,
    diagnostics: [...(doc.diagnostics ?? [])],
  };
}

function hasParseError(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => {
    const code = (d.data as { code?: string } | undefined)?.code;
    return d.severity === 1 && (code === "parsing-error" || code === "lexing-error");
  });
}

/** Any error-severity diagnostic (parse OR validation).  A migration/wire diff
 *  derived from an invalid model is meaningless, so `diff` blocks on this —
 *  matching the playground worker's evolution path (`runEvolution` bails on any
 *  error diagnostic).  Use `loom_validate` to repair first. */
function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 1);
}

/** An in-memory snapshot store seeded from a baseline's `.next` snapshots —
 *  the browser/CLI-agnostic twin of `memorySnapshotStore`/`memStore`. */
function memStore(initial: Record<string, SchemaSnapshot> = {}): SnapshotStore {
  return { read: (module: string) => initial[module] ?? null };
}

const BUCKET_LABEL: Record<string, string> = {
  aggregates: "aggregate",
  parts: "part",
  valueObjects: "value object",
};

/** Lower + enrich a single parsed source to the enriched IR (the same phases
 *  `generate`/`readModel` run), surfacing a lowering throw as `null`. */
function lowerEnriched(model: Model): EnrichedLoomModel | null {
  try {
    return enrichLoomModel(mergeLoomModels([lowerModel(model)]));
  } catch {
    return null;
  }
}

function loweringDiag(message: string): JsonDiagnostic {
  return {
    code: "loom.ir-internal",
    severity: "error",
    phase: "ir-validate",
    message,
  };
}

/**
 * Capture provenance rule snapshots for a `.ddd` source — the toolkit twin of
 * the CLI `ddd snapshot` prebuild step and the playground's snapshot button.
 * Returns the immutable `.loom/snapshots/*.loomsnap.json` files; `files` is
 * empty (still `ok: true`) when the model has no written `provenanced` field.
 */
export async function snapshot(source: string): Promise<SnapshotReport> {
  const { doc, model, diagnostics } = await parseSource(source);
  const json = diagnostics.map((d) => langiumDiagnosticToJson(d, doc));
  if (!model || hasParseError(diagnostics)) {
    return { ok: false, files: [], diagnostics: json };
  }
  const loom = lowerEnriched(model);
  if (!loom) {
    return {
      ok: false,
      files: [],
      diagnostics: [...json, loweringDiag(diagMessage("loom.ir-internal#snapshot-lowering"))],
    };
  }
  const files = [...captureSnapshots(loom)].map(([path, content]) => ({ path, content }));
  return { ok: true, files, diagnostics: json };
}

/** Derive the pending schema migrations + wire changes a `current` system
 *  implies against an optional `baseline` system.  Pure; never throws. */
function diffSystems(
  curSys: EnrichedSystemIR,
  baseSys: EnrichedSystemIR | null,
): { migrations: MigrationView[]; wireChanges: WireChangeView[]; breaking: boolean } {
  const migrations: MigrationView[] = [];
  const wireChanges: WireChangeView[] = [];
  let breaking = false;

  // -- schema migration -----------------------------------------------------
  // Seed a memory store from the baseline's stamped `.next` snapshots (empty
  // store ⇒ the baseline itself is "Initial"); the steps that come back
  // deriving the current source against it ARE the pending migration.
  const seed: Record<string, SchemaSnapshot> = {};
  if (baseSys) {
    for (const bm of buildMigrations(baseSys, memStore())) seed[bm.module] = bm.next;
  }
  const store = memStore(seed);
  const destructiveByModule = new Map<string, string>();
  let migs: ReturnType<typeof buildMigrations>;
  try {
    migs = buildMigrations(curSys, store);
  } catch (err) {
    if (err instanceof MigrationDestructiveError) {
      destructiveByModule.set(err.module, err.message);
      breaking = true;
      // Re-derive with the gate OFF so the caller still sees the (safe-
      // sequence) steps the change implies, not just the refusal.
      migs = buildMigrations(curSys, store, { allowDestructive: true });
    } else {
      throw err;
    }
  }
  for (const mig of migs) {
    if (mig.steps.length === 0) continue; // clean regen ⇒ no-op, don't list
    migrations.push({
      module: mig.module,
      name: mig.name,
      version: mig.version,
      steps: mig.steps.map((s) => ({ op: s.op, sql: renderPgStep(s) })),
      destructive: destructiveByModule.has(mig.module),
      destructiveMessage: destructiveByModule.get(mig.module),
    });
  }

  // -- wire contract --------------------------------------------------------
  // Only meaningful against a real baseline; with none, every shape is "new"
  // and the contract diff would be noise.
  if (baseSys) {
    const diff = diffWireSpec(buildWireSpec(baseSys), buildWireSpec(curSys));
    if (diff.breaking) breaking = true;
    for (const c of diff.changes) {
      wireChanges.push({
        entity: `${BUCKET_LABEL[c.bucket] ?? c.bucket} ${c.entity}`,
        field: c.field,
        kind: c.kind,
        breaking: c.breaking,
        detail: c.detail,
      });
    }
  }

  return { migrations, wireChanges, breaking };
}

/**
 * The evolution diff between a `baseline` `.ddd` source and the `current` one —
 * the schema migrations the change implies (per owning module, rendered to
 * Postgres SQL, with the destructive-data-loss gate surfaced) plus the wire-
 * contract delta classified breaking vs additive.  The toolkit twin of the
 * playground's Migrations dock tab, at single-source granularity.
 *
 * `baseline` omitted/empty ⇒ every system reads "Initial" (`hasBaseline: false`,
 * wire diff skipped).  A baseline that no longer parses/lowers is treated as
 * absent rather than failing the whole diff.  A broken `current` source returns
 * `ok: false` with its diagnostics — use `loom_validate` to repair it first.
 */
export async function diff(current: string, baseline?: string): Promise<DiffReport> {
  const cur = await parseSource(current);
  const curJson = cur.diagnostics.map((d) => langiumDiagnosticToJson(d, cur.doc));
  if (!cur.model || hasErrors(cur.diagnostics)) {
    return {
      ok: false,
      hasBaseline: false,
      migrations: [],
      wireChanges: [],
      breaking: false,
      diagnostics: curJson,
    };
  }
  const curLoom = lowerEnriched(cur.model);
  if (!curLoom) {
    return {
      ok: false,
      hasBaseline: false,
      migrations: [],
      wireChanges: [],
      breaking: false,
      diagnostics: [...curJson, loweringDiag(diagMessage("loom.ir-internal#evolve-lowering"))],
    };
  }
  if (curLoom.systems.length === 0) {
    return {
      ok: true,
      hasBaseline: false,
      migrations: [],
      wireChanges: [],
      breaking: false,
      diagnostics: [
        {
          code: "loom.no-system",
          severity: "warning",
          phase: "ir-validate",
          message: diagMessage("loom.no-system"),
        },
      ],
    };
  }

  // Load the baseline if given; a baseline that no longer loads is absent.
  let baseSystemsByName = new Map<string, EnrichedSystemIR>();
  if (baseline && baseline.trim().length > 0) {
    const base = await parseSource(baseline);
    if (base.model && !hasErrors(base.diagnostics)) {
      const baseLoom = lowerEnriched(base.model);
      if (baseLoom) baseSystemsByName = new Map(baseLoom.systems.map((s) => [s.name, s]));
    }
  }
  const hasBaseline = baseSystemsByName.size > 0;

  const migrations: MigrationView[] = [];
  const wireChanges: WireChangeView[] = [];
  let breaking = false;
  try {
    for (const curSys of curLoom.systems) {
      const r = diffSystems(curSys, baseSystemsByName.get(curSys.name) ?? null);
      migrations.push(...r.migrations);
      wireChanges.push(...r.wireChanges);
      if (r.breaking) breaking = true;
    }
  } catch (err) {
    return {
      ok: false,
      hasBaseline,
      migrations: [],
      wireChanges: [],
      breaking: false,
      diagnostics: [
        ...curJson,
        loweringDiag(
          diagMessage("loom.ir-internal#migration-derivation", {
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
      ],
    };
  }

  return { ok: true, hasBaseline, migrations, wireChanges, breaking, diagnostics: curJson };
}
