// -------------------------------------------------------------------------
// Derived-need ⊆ sourceType capability check (RFC §5.3), typed remote-call
// backend support, in-system typed api bindings (M-T4.8), and generic
// `config` map validation (RFC §8).  Split out of system-checks.ts by
// packet 2.6 (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { descriptorFor } from "../../../platform/metadata.js";
import {
  capabilitiesFor,
  configSchemaFor,
  supportsSurfaceKind,
} from "../../../util/source-types.js";
import type {
  ConfigEntryIR,
  ConfigValueIR,
  EnrichedSystemIR,
  Platform,
  SystemIR,
} from "../../types/loom-ir.js";
import { walkWorkflowStmtExprsDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** Returns a human-readable reason a dataSource of `kind` covers
 *  nothing in `ctx`, or undefined when the binding is exercised by
 *  at least one aggregate.  Encodes the dataSource-kind → aggregate-
 *  predicate matrix:
 *    - state    → needs at least one stateBased aggregate
 *    - eventLog → needs at least one eventSourced aggregate
 *    - snapshot → needs at least one eventSourced aggregate
 *      (snapshot policy applies to ES streams)
 *    - cache    → needs at least one aggregate of any strategy
 *    - replica  → needs at least one aggregate of any strategy
 */
// ---------------------------------------------------------------------------
// Need ⊆ sourceType capability check (RFC §5.3).  For each derived need
// bound to a resource, the resource's sourceType must offer every
// capability the need requires.  This is the IR-level invariant the
// implicit need layer enables; the AST validator already owns the
// coarser "kind supported by sourceType" check (with editor squiggles),
// so this only reports a *capability* gap on a kind the sourceType DOES
// support — avoiding a duplicate diagnostic for a plain kind/type
// mismatch.  Every supported kind currently offers all its capabilities, so
// this is silent for valid models; it becomes load-bearing once kinds carry
// capabilities a sourceType may partially support.
// ---------------------------------------------------------------------------

export function validateNeedCapabilities(sys: EnrichedSystemIR, diags: LoomDiagnostic[]): void {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const need of sys.needs) {
    const resource = sys.dataSources.find(
      (d) => d.contextName === need.contextName && d.kind === need.kind,
    );
    if (!resource) continue; // coverage gaps are reported elsewhere
    const sourceType = storageType.get(resource.storageName);
    if (!sourceType) continue; // unresolved `use:` reported elsewhere
    // Defer to the AST validator for the kind/type mismatch itself.
    if (!supportsSurfaceKind(sourceType, need.kind)) continue;
    const offered = capabilitiesFor(sourceType, need.kind);
    const missing = need.capabilities.filter((c) => !offered.has(c));
    if (missing.length > 0) {
      diags.push({
        severity: "error",
        code: "loom.resource-missing-capability",
        message: diagMessage("loom.resource-missing-capability", {
          name: resource.name,
          sourceType,
          missing: missing.map((c) => `'${c}'`).join(", "),
          contextName: need.contextName,
          kind: need.kind,
        }),
        source: `${sys.name}/${resource.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Typed remote-call backend support.  `orders.getOrderById(id)` resolves
// against the callee's derived operation set and types its result; a backend
// with no typed client would reach the renderer and die on a stack trace.  This
// gate is the repo's HONEST-gap stance: a `loom.*` code the user can read, not
// a silent mis-emit.
//
// The set is EMPTY — every backend (node, python, dotnet, java, elixir) emits a
// typed client.  The check is deliberately KEPT rather than deleted with the
// last entry.  It costs one `.some()` early-exit on models with no api binding,
// and it is the
// honest-gap net for the NEXT backend: a sixth platform added without a client
// would otherwise reach a `render-expr.ts` arm that has no idea what to emit.
// Adding the new platform key here turns that into a readable `loom.*` error at
// validation time, which is the whole stance this check exists to hold.
// ---------------------------------------------------------------------------

/** Backends with no typed in-system api client.  Currently empty — add a key
 *  here when introducing a backend before its client exists. */

export const REMOTE_API_OP_UNSUPPORTED: ReadonlySet<Platform> = new Set<Platform>([]);

export function validateRemoteApiOpSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Cheap exit: no api-bound resource ⇒ no typed call can exist.
  if (!sys.dataSources.some((r) => r.apiName)) return;
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const dep of sys.deployables) {
    if (!REMOTE_API_OP_UNSUPPORTED.has(dep.platform)) continue;
    for (const cn of dep.contextNames) {
      const ctx = ctxByName.get(cn);
      if (!ctx) continue;
      for (const wf of ctx.workflows) {
        for (const st of wf.statements) {
          walkWorkflowStmtExprsDeep(st, (e) => {
            if (e.kind !== "call" || e.callKind !== "remote-api-op") return;
            const op = e.remoteApiOp;
            if (!op) return;
            diags.push({
              severity: "error",
              code: "loom.remote-api-op-unsupported",
              message: diagMessage("loom.remote-api-op-unsupported", {
                name: wf.name,
                resourceName: op.resourceName,
                operationId: op.operationId,
                apiName: op.apiName,
                depName: dep.name,
                platform: dep.platform,
              }),
              source: `${sys.name}/${ctx.name}/${wf.name}`,
            });
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-system typed api bindings (M-T4.8).  `resource { kind: api, use: <Api> }`
// derives its address from the deployable that `serves:` that api — so the
// binding is only well-formed when exactly ONE backend deployable serves it.
// These are IR-level (not AST) checks because they need the whole system's
// deployable set, which the AST validator does not have resolved.
// ---------------------------------------------------------------------------

export function validateApiResourceBindings(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const apiBound = sys.dataSources.filter((r) => r.apiName);
  if (apiBound.length === 0) return;
  for (const r of apiBound) {
    const apiName = r.apiName as string;
    // Frontends `consumes:` an api; they never serve its routes, so a
    // frontend in `serves:` can't supply an address for a backend caller.
    const servers = sys.deployables.filter(
      (d) => d.serves.includes(apiName) && !descriptorFor(d.platform).isFrontend,
    );
    if (servers.length === 0) {
      diags.push({
        severity: "error",
        code: "loom.resource-api-unserved",
        message: diagMessage("loom.resource-api-unserved", { name: r.name, apiName }),
        source: `${sys.name}/${r.name}`,
      });
      continue;
    }
    if (servers.length > 1) {
      diags.push({
        severity: "error",
        code: "loom.resource-api-ambiguous-server",
        message: diagMessage("loom.resource-api-ambiguous-server", {
          name: r.name,
          apiName,
          length: servers.length,
          servers: servers.map((d) => `'${d.name}'`).join(", "),
        }),
        source: `${sys.name}/${r.name}`,
      });
      continue;
    }
    // Self-call: the deployable wiring this resource is the one serving the
    // api.  That is always a mistake — the context is already in-process, so
    // the call would leave the process only to re-enter it, paying a network
    // hop and losing the ambient transaction.
    const server = servers[0] as (typeof servers)[number];
    for (const dep of sys.deployables) {
      if (!dep.dataSourceNames.includes(r.name)) continue;
      if (dep.name !== server.name) continue;
      diags.push({
        severity: "error",
        code: "loom.resource-api-self-call",
        message: diagMessage("loom.resource-api-self-call", {
          name: dep.name,
          rName: r.name,
          apiName,
        }),
        source: `${sys.name}/${r.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Generic `config` map validation (RFC §8).  Keys are checked against
// the sourceType's registry config schema: unknown keys warn (forward-
// compatible), wrong-typed values error, and required keys missing from
// a physical `storage` error.  Resource-level config is supplemental, so
// the required-key check applies only to the storage declaration.
// ---------------------------------------------------------------------------

export function validateResourceConfig(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const s of sys.storages) {
    checkConfigBlock(s.config, s.type, `storage '${s.name}'`, true, sys.name, diags);
  }
  for (const r of sys.dataSources) {
    const sourceType = storageType.get(r.storageName);
    if (sourceType) {
      checkConfigBlock(r.config, sourceType, `resource '${r.name}'`, false, sys.name, diags);
    }
    validateManualIndexes(r, sys, diags);
  }
}

/** `resource index: [...]` checks (uniqueness-and-indexes.md §3.2): a manual
 *  index needs a relational table to sit on (so it is gated to `kind: state`),
 *  and each column must resolve to a field on some aggregate in the binding's
 *  `for:` context. */

function validateManualIndexes(
  r: SystemIR["dataSources"][number],
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  if (!r.manualIndexes || r.manualIndexes.length === 0) return;
  const label = `resource '${r.name}'`;
  if (r.kind !== "state") {
    diags.push({
      severity: "error",
      code: "loom.resource-index-non-state",
      message: diagMessage("loom.resource-index-non-state", { label, kind: r.kind }),
      source: `${sys.name}/${label}`,
    });
    return;
  }
  // Entity (aggregate or contained part) → its field names, for every entity in
  // the binding's context.  `index: Project.name` names the entity explicitly,
  // so the column resolves against THAT entity, not any table that has the name.
  const fieldsByEntity = new Map<string, Set<string>>();
  for (const sub of sys.subdomains) {
    for (const ctx of sub.contexts) {
      if (ctx.name !== r.contextName) continue;
      for (const agg of ctx.aggregates) {
        fieldsByEntity.set(agg.name, new Set(agg.fields.map((f) => f.name)));
        for (const part of agg.parts) {
          fieldsByEntity.set(part.name, new Set(part.fields.map((f) => f.name)));
        }
      }
    }
  }
  for (const spec of r.manualIndexes) {
    const fields = fieldsByEntity.get(spec.entity);
    if (!fields) {
      diags.push({
        severity: "error",
        code: "loom.resource-index-unknown-entity",
        message: diagMessage("loom.resource-index-unknown-entity", {
          label,
          entity: spec.entity,
          contextName: r.contextName,
        }),
        source: `${sys.name}/${label}`,
      });
      continue;
    }
    for (const col of spec.columns) {
      if (!fields.has(col)) {
        diags.push({
          severity: "error",
          code: "loom.resource-index-unknown-column",
          message: diagMessage("loom.resource-index-unknown-column", {
            label,
            entity: spec.entity,
            col,
          }),
          source: `${sys.name}/${label}`,
        });
      }
    }
  }
}

function checkConfigBlock(
  config: readonly ConfigEntryIR[] | undefined,
  sourceType: string,
  label: string,
  checkRequired: boolean,
  sysName: string,
  diags: LoomDiagnostic[],
): void {
  const schema = configSchemaFor(sourceType);
  const byName = new Map(schema.map((k) => [k.name, k] as const));
  const present = new Set<string>();
  for (const entry of config ?? []) {
    present.add(entry.key);
    const spec = byName.get(entry.key);
    if (!spec) {
      diags.push({
        severity: "warning",
        code: "loom.config-key-unknown",
        message: diagMessage("loom.config-key-unknown", { label, key: entry.key, sourceType }),
        source: `${sysName}/${label}`,
      });
      continue;
    }
    if (!configValueMatchesType(entry.value, spec)) {
      const expected =
        spec.type === "enum" && spec.values ? `one of ${spec.values.join(", ")}` : spec.type;
      diags.push({
        severity: "error",
        code: "loom.config-key-type",
        message: diagMessage("loom.config-key-type", { label, key: entry.key, expected }),
        source: `${sysName}/${label}`,
      });
    }
  }
  if (checkRequired) {
    for (const spec of schema) {
      if (spec.required && !present.has(spec.name)) {
        diags.push({
          severity: "error",
          code: "loom.config-key-required",
          message: diagMessage("loom.config-key-required", { label, name: spec.name, sourceType }),
          source: `${sysName}/${label}`,
        });
      }
    }
  }
}

function configValueMatchesType(
  value: ConfigValueIR,
  spec: { type: string; values?: readonly string[] },
): boolean {
  switch (spec.type) {
    case "number":
      return value.kind === "int";
    case "boolean":
      return value.kind === "bool";
    case "enum":
      return value.kind === "string" && (spec.values?.includes(value.value) ?? false);
    default: // string | secret
      return value.kind === "string";
  }
}
