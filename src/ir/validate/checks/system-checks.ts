// -------------------------------------------------------------------------
// System-level checks — datasource coverage / saving-shape / capability
// wiring, per-backend support gates (Dapper, MikroORM), resource config,
// auth + permission registration, inheritance + event-sourced storage.
// -------------------------------------------------------------------------

import {
  platformFamily,
  platformOwnsBackend,
  platformSavingShapes,
} from "../../../language/validators/data/platform-rules.js";
import { descriptorFor } from "../../../platform/metadata.js";
import { lowerFirst } from "../../../util/naming.js";
import {
  capabilitiesFor,
  configSchemaFor,
  supportsSurfaceKind,
} from "../../../util/source-types.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ConfigEntryIR,
  ConfigValueIR,
  DataSourceIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedLoomModel,
  EnrichedSystemIR,
  SubdomainIR,
  SystemIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import { exprUsesCurrentUser } from "../../types/loom-ir.js";
import {
  dataSourceKindForAggregate,
  effectiveSavingShape,
  resolveDataSourceConfig,
} from "../../util/resolve-datasource.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { validateE2ETest } from "./test-checks.js";

// ---------------------------------------------------------------------------
// `X id` validation for React deployables.
//
// The React form generator renders an `X id` form field as a `<Select>`
// populated by `useAll<X>()` with the target aggregate's `display`-marked
// field as the option label.  Two preconditions must hold for the form
// to be usable:
//
//   1. The target aggregate has a `display` field (otherwise no option
//      label can be derived; the generator falls back to a `<TextInput>`
//      with a placeholder explaining the gap, but the user only sees
//      that at render time).
//   2. The target aggregate is mounted by this deployable's targeted
//      backend (otherwise `useAll<X>()` is not importable and the API
//      can't fetch the list).
//
// We check both up-front per react deployable.  Backends-only
// deployables don't trigger these checks — `X id` on the wire is
// just a string/uuid and doesn't depend on a display label.
// ---------------------------------------------------------------------------

// `auth: ui` (the frontend OIDC guard) is emitted by the React, Vue, and
// Svelte generators.  A deployable whose resolved UI framework is none of
// those (phoenixLiveView) would silently emit no guard — reject it loudly
// so the limitation is visible rather than a no-op.
const AUTH_UI_FRAMEWORKS = new Set(["react", "vue", "svelte"]);

export function validateAuthUiFramework(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    if (!d.auth?.ui) continue;
    if (!AUTH_UI_FRAMEWORKS.has(d.uiFramework ?? "")) {
      diags.push({
        severity: "error",
        code: "loom.auth-ui-unsupported-framework",
        message: `Deployable '${d.name}': 'auth: ui' is currently only supported on react, vue, and svelte frontends; framework '${d.uiFramework ?? "unknown"}' isn't supported yet.`,
        source: d.name,
      });
    }
  }
}

// Page/component `derived name: T = expr` bindings hoist as a reactive
// computed before the body — `useMemo` (React), `computed` (Vue/Angular),
// `$derived` (Svelte).  The JS frontends all emit the hoist; only
// Phoenix/HEEx stays gated (LiveView's render topology has no equivalent
// hoist site yet), so a `derived` there would resolve the body ref to a
// binding that's never declared (broken output) — reject it loudly.
const DERIVED_FRAMEWORKS = new Set(["react", "vue", "svelte", "angular"]);

export function validateDerivedFramework(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const uiByName = new Map(sys.uis.map((u) => [u.name, u]));
  for (const d of sys.deployables) {
    if (!d.uiName || DERIVED_FRAMEWORKS.has(d.uiFramework ?? "")) continue;
    const ui = uiByName.get(d.uiName);
    if (!ui) continue;
    const offenders = [
      ...ui.pages.filter((p) => p.derived.length > 0).map((p) => `page ${p.name}`),
      ...ui.components.filter((c) => c.derived.length > 0).map((c) => `component ${c.name}`),
    ];
    if (offenders.length > 0) {
      diags.push({
        severity: "error",
        code: "loom.derived-unsupported-framework",
        message: `Deployable '${d.name}': page/component 'derived' bindings (${offenders.join(", ")}) are currently only supported on the react, vue, svelte, and angular frontends; framework '${d.uiFramework ?? "unknown"}' isn't supported yet.`,
        source: d.name,
      });
    }
  }
}

// Default-deny enforcement (auth.md / quickstart §4.3).  When the system's
// `auth { enforcement: denyByDefault }` is set, every reachable *command* on
// an `auth: required` backend must declare a `requires` gate — otherwise it
// serves ungated.  `enforcement: opt` (the default) preserves the existing
// per-`requires` opt-in.  Escape hatch: `requires true` marks a command
// intentionally public.
//
// Scope: every client-reachable command (mutation) endpoint —
//   - public aggregate actions: operations, **creates**, destroys (each
//     carries `requires` in its body);
//   - **workflows**: every command-triggered starter (`create … {}`) and named
//     `handle …(){}` continuation command (POST endpoints; their bodies carry
//     `requires`).  Event-triggered creates / `on(...)` reactors are not
//     client-reachable, so they are excluded.
//
// Out of scope: finds and views.  These are *reads*, and the grammar gives them
// no `requires` surface at all (only a `where` filter) — so flagging them would
// leave the author no escape hatch.  Gating reads needs a `requires`-on-query
// language addition first; tracked as a separate follow-up.
export function validateDefaultDeny(sys: SystemIR, diags: LoomDiagnostic[]): void {
  if (sys.auth?.enforcement !== "denyByDefault") return;
  // Contexts hosted by any `auth: required` backend deployable.  A frontend
  // (auth: ui) has `auth.required === false`, so it's excluded here.
  const guarded = new Set<string>();
  for (const d of sys.deployables) {
    if (!d.auth?.required) continue;
    for (const cn of d.contextNames) guarded.add(cn);
  }
  if (guarded.size === 0) return;
  const isGated = (statements: { kind: string }[]): boolean =>
    statements.some((s) => s.kind === "requires");
  for (const sd of sys.subdomains) {
    for (const c of sd.contexts) {
      if (!guarded.has(c.name)) continue;
      // Aggregate command actions: operations + creates + destroys (all
      // OperationIR with a `requires`-bearing body).
      for (const a of c.aggregates) {
        for (const op of [...a.operations, ...(a.creates ?? []), ...(a.destroys ?? [])]) {
          if (op.visibility !== "public") continue;
          if (!isGated(op.statements)) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: `denyByDefault: '${a.name}.${op.name}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
              source: `${a.name}/${op.name}`,
            });
          }
        }
      }
      // Workflow command endpoints: command-triggered starters + named
      // handlers.  Each is a POST route a client can reach.
      for (const wf of c.workflows) {
        for (const entry of workflowCommandEntries(wf)) {
          if (!isGated(entry.statements)) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: `denyByDefault: workflow '${entry.label}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
              source: `${wf.name}/${entry.key}`,
            });
          }
        }
      }
    }
  }
}

/** The client-reachable command endpoints of a workflow: each command-triggered
 *  `create` starter and each named `handle` continuation.  Event-triggered
 *  creates and `on(...)` reactors fire on internal events, never a client POST,
 *  so they are excluded — the validate-layer analogue of the generator's
 *  `emitsCommandRoute`. */
function workflowCommandEntries(
  wf: WorkflowIR,
): { label: string; key: string; statements: WorkflowStmtIR[] }[] {
  const entries: { label: string; key: string; statements: WorkflowStmtIR[] }[] = [];
  for (const cr of wf.creates) {
    if (cr.triggerKind !== "command") continue;
    entries.push({
      label: cr.name ? `${wf.name}.${cr.name}` : wf.name,
      key: cr.name ?? "create",
      statements: cr.statements,
    });
  }
  for (const h of wf.handlers ?? []) {
    entries.push({ label: `${wf.name}.${h.name}`, key: h.name, statements: h.statements });
  }
  return entries;
}

export function validateReactIdReferences(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Build an aggregate registry across the whole system so we can
  // look up display fields regardless of which module declares the
  // target aggregate.
  const allAggregates = new Map<string, AggregateIR>();
  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) allAggregates.set(a.name, a);
    }
  }

  for (const d of sys.deployables) {
    // UI-mounting deployables emit per-aggregate forms whose `X id`
    // inputs need the target aggregate to be reachable from the
    // deployable's mounted set.  Backend-only deployables (hono)
    // skip — no UI.  `dotnet` is dual-mode now (`mountsUi: true` to
    // admit the fullstack `ui:` branch); when no `ui:` is declared
    // it stays backend-only and skips too — without this guard a
    // backend-only dotnet deployable would trigger spurious
    // Id-reachability errors against the (then irrelevant) UI.
    if (!descriptorFor(d.platform).mountsUi) continue;
    // Dual-mode platforms (dotnet) with no `ui:` are backend-only —
    // skip the UI-reachability walk.  `mountsUi && !isFrontend` is the
    // dual-mode shape today (frontend-only platforms always declare ui).
    if (!d.uiName && !descriptorFor(d.platform).isFrontend) continue;
    // Aggregates mounted by this deployable's `contextNames` set —
    // UI generators only emit per-aggregate hooks/queries for
    // these; anything outside is unreachable.
    const mounted = new Set<string>();
    const wantedContexts = new Set(d.contextNames);
    for (const sd of sys.subdomains) {
      for (const c of sd.contexts) {
        if (wantedContexts.has(c.name)) {
          for (const a of c.aggregates) mounted.add(a.name);
        }
      }
    }

    // Walk every operation param + every aggregate field that lowers to
    // an `X id` and check both invariants against the system-wide
    // registry + this deployable's mounted set.
    for (const aggName of mounted) {
      const agg = allAggregates.get(aggName);
      if (!agg) continue;
      // Aggregate root fields.
      for (const f of agg.fields) {
        checkIdReference(f.type, `${aggName}.${f.name}`, d.name, allAggregates, mounted, diags);
      }
      // Operation parameters.
      for (const op of agg.operations) {
        for (const p of op.params) {
          checkIdReference(
            p.type,
            `${aggName}.${op.name}(${p.name})`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
      // Part fields too — entity-parts on the wire surface as nested
      // shapes, but their `X id` properties show up as foreign
      // references in the part's row.  Forms for parts go through
      // the same Select picker pattern.
      for (const part of agg.parts) {
        for (const f of part.fields) {
          checkIdReference(
            f.type,
            `${aggName}.${part.name}.${f.name}`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
    }
  }
}

function checkIdReference(
  t: TypeIR,
  source: string,
  deployableName: string,
  allAggregates: Map<string, AggregateIR>,
  mounted: Set<string>,
  diags: LoomDiagnostic[],
): void {
  const inner = unwrap(t);
  if (inner.kind !== "id") {
    if (inner.kind === "array") {
      checkIdReference(inner.element, source, deployableName, allAggregates, mounted, diags);
    }
    return;
  }
  const target = inner.targetName;
  // 1. Target aggregate must exist somewhere in the system.
  const agg = allAggregates.get(target);
  if (!agg) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unknown-aggregate",
      message: `UI-mounting deployable '${deployableName}': '${source}' references ${target} id, but no aggregate '${target}' is declared in the system.`,
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 2. Target aggregate must be mounted by this deployable's modules
  //    so `useAll<Target>()` is importable + the backend can serve
  //    the list.
  if (!mounted.has(target)) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unmounted",
      message:
        `UI-mounting deployable '${deployableName}': '${source}' references ${target} id, but '${target}' is not mounted on this deployable's modules.  ` +
        `Mount the module containing '${target}' on the deployable's targeted backend, or remove the reference.`,
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 3. Target aggregate must declare a `derived display: string` (so the
  //    Select picker has a sensible option label).
  if (!agg.displayDerived) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-no-display",
      message:
        `UI-mounting deployable '${deployableName}': '${source}' references ${target} id, but '${target}' has no 'derived display' clause.  ` +
        `Add 'derived display: string = <field>' to '${target}' so the form's <Select> picker can label options.`,
      source: `${deployableName}/${source}`,
    });
  }
}

function unwrap(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

export function validateSystem(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const modulesByName = new Map<string, SubdomainIR>();
  for (const m of sys.subdomains) modulesByName.set(m.name, m);
  for (const t of sys.e2eTests) {
    validateE2ETest(t, sys, modulesByName, diags);
  }
}

// ---------------------------------------------------------------------------
// DataSource coverage — every backend deployable must declare a
// matching `dataSource` for every (context, persistence-kind) pair it
// hosts.  A stateBased aggregate needs `kind: state`; an eventSourced
// aggregate needs `kind: eventLog`.  Without a binding, the emitter
// has no schema / connection routing config to emit — so the omission
// is an authoring mistake, not a meaningful default.
//
// Only fires for backend deployables (dotnet, node, phoenix).
// Frontend-only platforms (react, static) own no database and can't
// have a dataSource to point at.
// ---------------------------------------------------------------------------
export function validateDataSourceCoverage(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const dsByName = new Map<string, DataSourceIR>();
  for (const d of sys.dataSources) dsByName.set(d.name, d);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    // Resolve the listed dataSources to their (ctx, kind) coverage set.
    const covered = new Set<string>();
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      covered.add(`${ds.contextName}:${ds.kind}`);
    }
    // For every hosted aggregate, demand a matching dataSource entry.
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const kind = dataSourceKindForAggregate(agg as EnrichedAggregateIR);
        const key = `${ctxName}:${kind}`;
        if (covered.has(key)) continue;
        diags.push({
          severity: "error",
          code: "loom.persistence-mode-unsupported",
          message:
            `Deployable '${dep.name}' hosts aggregate '${ctxName}.${agg.name}' ` +
            `(persistedAs: ${agg.persistedAs ?? "state"}, ` +
            `needs dataSource kind: ${kind}) but lists no matching dataSource. ` +
            `Declare ` +
            `\`dataSource ${lowerFirst(ctxName)}${kind === "state" ? "State" : "EventLog"} ` +
            `{ for: ${ctxName}, kind: ${kind}, use: <storage> }\` ` +
            `and add it to '${dep.name}'\`s 'dataSources:' list.`,
          source: `${sys.name}/${dep.name}`,
        });
      }
    }

    // Inverse direction: a dataSource listed on a deployable but
    // covering nothing in the hosted contexts is dead config.  An
    // `eventLog` binding against a context that has only stateBased
    // aggregates routes no data; a `state` binding when every
    // aggregate is eventSourced is similarly inert.  This catches
    // edits-in-progress (renamed a strategy and forgot to drop the
    // old binding) and copy-paste from another deployable.  Warning
    // (not error) because the user may be staging a binding for an
    // aggregate they're about to add — but we still want it on the
    // Problems panel.
    const hostedContexts = new Set(dep.contextNames);
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      if (!hostedContexts.has(ds.contextName)) continue;
      // The 'for: <ctx> not in contexts:' error is already raised by
      // the AST validator (checkDeployableDataSources); skip here so
      // the user gets one diagnostic per mistake, not two.
      const ctx = ctxByName.get(ds.contextName);
      if (!ctx) continue;
      const reason = coverageGapReason(ds.kind, ctx);
      if (!reason) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-unused",
        message:
          `Deployable '${dep.name}' lists resource '${ds.name}' (kind: ${ds.kind}) for ` +
          `context '${ds.contextName}', but ${reason}.  This binding routes no data — ` +
          `remove it, or add an aggregate whose persistedAs needs kind: ${ds.kind}.`,
        source: `${sys.name}/${dep.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Saving-shape capability (D-DOCUMENT-AXIS).  An aggregate's effective
// `shape(…)` must be one the hosting backend can actually emit.  Today
// the matrix is partial — .NET / Hono emit all three (relational /
// embedded / document); Phoenix emits only relational — so a
// `shape(document)` aggregate on a Phoenix deployable would otherwise
// emit *relationally*, silently mismatching the per-shape migration.
// This turns that footgun into a clear error (the capability tier).
//
// Per-projection: the effective shape is resolved binding-aware (a
// `resource { shape: … }` override wins over the aggregate header), the
// same way the migration + backend emitters resolve it, so the check
// matches what would actually be produced.  Frontend platforms own no
// persistence (platformSavingShapes → undefined) and are skipped.
// ---------------------------------------------------------------------------
export function validateSavingShapeSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const supported = platformSavingShapes(dep.platform);
    if (!supported) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        if (supported.includes(shape)) continue;
        diags.push({
          severity: "error",
          code: "loom.saving-shape-unsupported",
          message:
            `Deployable '${dep.name}' (platform ${dep.platform}) hosts aggregate ` +
            `'${ctxName}.${agg.name}' with shape(${shape}), but that backend can only ` +
            `emit: ${supported.join(", ")}.  Use a supported shape, or host this ` +
            `aggregate on a deployable whose platform emits shape(${shape}).`,
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capability-filter support on the Hono and Phoenix backends (partial
// today).  A `filter <expr>` capability installs at the query layer on
// every read.  On .NET it rides EF Core's `HasQueryFilter` (global,
// DI-resolved) — no restriction.  Hono AND-s the predicate into each
// Drizzle read site; Phoenix emits an Ash `base_filter`.  Two cases are
// not yet wired on either and would otherwise emit silently-wrong query
// behaviour (a soft-delete / tenancy-isolation footgun), so reject them
// with a clear error instead:
//
//   1. Principal-referencing filters (`this.tenantId ==
//      currentUser.tenantId`).  Binding the request principal into the
//      always-on read path is deferred (Hono: thread through findById +
//      callers; Phoenix: an actor-bound base_filter) — see
//      docs/proposals/criterion-everywhere.md.
//   2. Non-relational shapes (`shape(document)` / `shape(embedded)`).
//      Fields live inside a jsonb column, so `this.isDeleted` is not a
//      top-level column the predicate can reference without JSON-path
//      lowering — deferred.  (Phoenix only emits relational anyway, so
//      the saving-shape validator usually blocks this upstream.)
//
// Non-principal capability filters on a relational aggregate
// (`filter !this.isDeleted`) ARE emitted on both backends.
// ---------------------------------------------------------------------------
// Java/JPA gate: a SINGLE (non-collection) containment has no clean
// unidirectional JPA mapping with the FK on the part table (the shared
// schema's shape) — @OneToOne + @JoinColumn puts the FK on the owner,
// and mappedBy needs an entity-typed back-reference the domain model
// doesn't carry.  Fail fast (the parity contract: never silently
// downgrade) until the shadow-parent mapping lands.  Collection
// containments (the overwhelmingly common case) are fully supported via
// unidirectional @OneToMany.
// ---------------------------------------------------------------------------
// Java gate: the fullstack `ui:` mount (embedded React SPA from Spring
// static resources, the dotnet wwwroot analog).  `hosts:` (hosting a
// separately-declared react deployable's bundle) is still gated — only
// the `ui:` embedded-SPA mount is implemented, mirroring dotnet.
export function validateJavaFullstackSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "java") continue;
    if ((dep.hostedUiNames ?? []).length === 0) continue;
    diags.push({
      severity: "error",
      message:
        `Deployable '${dep.name}' (platform java) declares a 'hosts:' binding, but hosting a ` +
        `separate react deployable's bundle is not yet implemented on the java backend. ` +
        `Use the embedded-SPA mount ('ui:' on this deployable), serve the UI from a separate ` +
        `'platform: react' deployable targeting '${dep.name}', or host it on a dotnet deployable.`,
      source: `${sys.name}/${dep.name}`,
      code: "loom.java-fullstack-unsupported",
    });
  }
}

// Lifecycle stamps (`stamp onCreate`/`onUpdate`, audit / softDelete) on
// the java backend.  Stamps are emitted as `_stampOnCreate` /
// `_stampOnUpdate` entity methods the service calls before save;
// non-principal values render directly, and a `currentUser` value
// resolves to the principal id (a guid — the service threads
// `currentUser` into the stamp method, the entity assigns
// `currentUser.id()`).  Two cases stay fail-fast (never a silent drop):
// a principal-referencing stamp on a deployable WITHOUT auth (no
// request-scoped principal accessor to thread), and stamps on an
// event-sourced aggregate (state is folded from events, not
// field-stamped).
export function validateJavaStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "java") continue;
    const authed = !!(dep.auth?.required && sys.user);
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const stamps = enriched.contextStamps ?? [];
        if (stamps.length === 0) continue;
        const usesPrincipal = stamps.some((r) =>
          r.assignments.some((a) => exprUsesCurrentUser(a.value)),
        );
        if (usesPrincipal && !authed) {
          diags.push({
            severity: "error",
            message:
              `Deployable '${dep.name}' (platform java) hosts aggregate '${ctxName}.${agg.name}' ` +
              `with a lifecycle stamp that references currentUser (e.g. \`createdBy := currentUser\` ` +
              `from \`with audit\`), but the deployable has no auth — there is no request-scoped ` +
              `principal to stamp from. Add 'auth: required' (and a system 'user {}' block), or use ` +
              `non-principal stamps (e.g. \`stamp onCreate { createdAt := now() }\`).`,
            source: `${sys.name}/${dep.name}`,
            code: "loom.java-stamp-unsupported",
          });
        }
        if (enriched.persistedAs === "eventLog") {
          diags.push({
            severity: "error",
            message:
              `Deployable '${dep.name}' (platform java) hosts event-sourced aggregate ` +
              `'${ctxName}.${agg.name}' with a lifecycle stamp — stamps mutate state fields, but an ` +
              `event-sourced aggregate's state is folded from its event stream. ` +
              `Record the timestamp in an event instead, or drop persistedAs(eventLog).`,
            source: `${sys.name}/${dep.name}`,
            code: "loom.java-stamp-unsupported",
          });
        }
      }
    }
  }
}

export function validateJavaContainmentSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "java") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      // `shape(embedded)` reference collections: the jsonb id-array
      // column would route through Hibernate's structured-JSON path for
      // registered @Embeddable ids (not the Jackson FormatMapper), which
      // mis-serialises the typed-id list.  Gate until a converter-based
      // mapping lands; containments-as-json are supported.
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        if (shape !== "embedded" || enriched.persistedAs === "eventLog") continue;
        for (const f of agg.fields) {
          const t = f.type.kind === "optional" ? f.type.inner : f.type;
          if (t.kind === "array" && t.element.kind === "id") {
            diags.push({
              severity: "error",
              message:
                `Deployable '${dep.name}' (platform java) hosts shape(embedded) aggregate ` +
                `'${ctxName}.${agg.name}' with reference collection '${f.name}' — jsonb id-array ` +
                `columns are not yet mapped on the java backend (Hibernate's structured-JSON ` +
                `path bypasses the Jackson FormatMapper for @Embeddable ids). ` +
                `Use shape(document), the relational shape, or host on a node / dotnet deployable.`,
              source: `${sys.name}/${dep.name}`,
              code: "loom.java-embedded-refcoll-unsupported",
            });
          }
        }
      }
      for (const agg of ctx.aggregates) {
        // Root-level single containments are mapped (the part carries a
        // hidden owning `_parent` @OneToOne); only *part-declared* single
        // containments stay gated — their parent is another part, and the
        // part factory / renderNew seam only threads the root entity.
        for (const owner of agg.parts) {
          for (const c of owner.contains) {
            if (c.collection) continue;
            diags.push({
              severity: "error",
              message:
                `Deployable '${dep.name}' (platform java) hosts aggregate '${ctxName}.${agg.name}' ` +
                `whose nested part '${owner.name}' declares a single containment 'contains ${c.name}: ${c.partName}' — ` +
                `part-declared single (non-collection) containments are not yet mapped on the java backend. ` +
                `Use a collection containment ('contains ${c.name}: ${c.partName}[]'), fold the part's ` +
                `fields into a value object, or host the context on a node / dotnet deployable.`,
              source: `${sys.name}/${dep.name}`,
              code: "loom.java-single-containment-unsupported",
            });
          }
        }
      }
    }
  }
}

export function validateContextFilterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  // Backends that gate one or both of the deferred capability-filter cases.
  // .NET (EF `HasQueryFilter`) supports BOTH, so it's deliberately absent.
  // Canonical families (D-NODE-PLATFORM / D-ELIXIR-PLATFORM): `node` (was
  // `hono`), `elixir` (was `phoenix` / `phoenixLiveView`).
  const LIMITED_FAMILIES = new Set(["node", "elixir", "java"]);
  // Backends that now wire PRINCIPAL-referencing filters (`currentUser.x`) on
  // relational aggregates — every limited family does.  node renders the
  // predicate against the ambient `requireCurrentUser()` accessor inside every
  // root read (the Drizzle analogue of .NET's `HasQueryFilter`).  elixir wires
  // it on BOTH foundations: **Ash** (`base_filter expr(... == ^actor(:field))` +
  // `actor: current_user`) and **vanilla** Ecto (the predicate AND-ed into each
  // read as `^(current_user && current_user.f)`).  **java** AND-s a SpEL-
  // principal JPQL clause (`:#{@currentUserAccessor.user()?.f()}`) into every
  // find/retrieval/view + the scoped `findAll`/`findById` overrides (the static
  // `@SQLRestriction` still carries the non-principal filters).
  const supportsPrincipalFilter = (family: string, _foundation: string | undefined): boolean => {
    if (family === "node") return true;
    if (family === "elixir") return true;
    if (family === "java") return true;
    return false;
  };

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    if (!fam || !LIMITED_FAMILIES.has(fam)) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const filters = enriched.contextFilters ?? [];
        if (filters.length === 0) continue;
        const usesPrincipal = filters.some((p) => exprUsesCurrentUser(p));
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        const nonRelational = shape !== "relational";
        const principalUnsupported = usesPrincipal && !supportsPrincipalFilter(fam, dep.foundation);
        // A principal filter on a backend that DOES wire it (node) still needs
        // a request principal to scope by — so the deployable must enforce auth
        // (and the system must declare a `user {}` block).  Without it the
        // ambient `requireCurrentUser()` accessor isn't even emitted.  Mirror
        // the `validateJavaStampSupport` precedent with a clear, actionable error.
        if (
          usesPrincipal &&
          !principalUnsupported &&
          !nonRelational &&
          !(dep.auth?.required && sys.user)
        ) {
          diags.push({
            severity: "error",
            code: "loom.context-filter-unsupported",
            message:
              `Deployable '${dep.name}' (platform ${dep.platform}) hosts aggregate ` +
              `'${ctxName}.${agg.name}' with a 'filter' capability predicate that references ` +
              `currentUser (e.g. a tenancy filter), but the deployable has no auth — there is no ` +
              `request-scoped principal to scope reads by. Add 'auth: required' (and a system ` +
              `'user {}' block), or remove the principal-referencing filter.`,
            source: `${sys.name}/${dep.name}`,
          });
          continue;
        }
        // A non-relational shape gates on EVERY limited family (DEBT-02);
        // a principal filter gates everywhere except the families above.
        if (!principalUnsupported && !nonRelational) continue;
        // Non-relational is the harder limitation — report it first when both
        // apply (e.g. a principal filter on a document-shaped aggregate).
        const reason = nonRelational
          ? `is persisted as shape(${shape}); capability filters are only wired for ` +
            `relational aggregates on the ${fam} backend today`
          : `references currentUser (e.g. a tenancy filter); principal-referencing capability ` +
            `filters are not yet wired on the ${fam} backend`;
        diags.push({
          severity: "error",
          message:
            `Deployable '${dep.name}' (platform ${dep.platform}) hosts aggregate ` +
            `'${ctxName}.${agg.name}' with a 'filter' capability predicate that ${reason}. ` +
            `Host this aggregate on a .NET deployable${
              nonRelational
                ? ""
                : " (or a node / elixir-Ash deployable, which wire tenancy filters)"
            }, or remove the unsupported capability filter. ` +
            `Non-principal filters on relational aggregates (e.g. 'filter !this.isDeleted') are emitted.`,
          source: `${sys.name}/${dep.name}`,
          code: "loom.context-filter-unsupported",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: dapper` capability gate (D-REALIZATION-AXES Phase 5c).
//
// The .NET Dapper adapter is a MINIMAL-v1 alternate persistence: relational,
// state-based, flat aggregates whose fields are scalar / enum / value-object /
// single id-ref.  This rejects — with a clear, actionable error — any model
// feature dapper v1 doesn't emit, so a selection either works end-to-end or
// fails fast at validate time (rather than producing a non-compiling project).
// efcore (the default) supports the full surface, so this only fires for an
// explicit `persistence: dapper`.
// ---------------------------------------------------------------------------
export function validateDapperSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "dapper") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message:
          `Deployable '${dep.name}' selects 'persistence: dapper', but ${subject} ${reason}. ` +
          `The Dapper adapter is minimal in v1 (relational, state-based, flat aggregates with ` +
          `scalar / enum / value-object / id-ref fields). Use 'persistence: efcore' for this model, ` +
          `or remove the unsupported feature.`,
        source: `${sys.name}/${dep.name}`,
        code: "loom.dapper-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      // `retrieval` bundles are now supported on Dapper — `Run<Name>Async`
      // renders as parameterised SQL (where + sort + offset/limit paging); a
      // predicate outside the Dapper subset stubs (NotImplementedException),
      // mirroring the find path.  No gate.
      if ((ctx.seeds ?? []).length > 0)
        reject(`context '${ctxName}'`, "declares 'seed' data (the Dapper seed path is not wired)");
      // Workflow event subscriptions (and therefore channels/outbox): the
      // saga handlers + outbox dispatcher/relay inject the EF AppDbContext,
      // which a Dapper deployable does not emit — the project would not
      // compile.  Reject loudly instead (dispatch-delivery-semantics.md's
      // Dapper outbox is a follow-up slice).
      if (((ctx as EnrichedBoundedContextIR).eventSubscriptions ?? []).length > 0)
        reject(
          `context '${ctxName}'`,
          "declares workflow event subscriptions (the Dapper dispatch/outbox path is not wired)",
        );
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // Event sourcing IS supported on this adapter (appliers): the
        // `<agg>_events` stream + fold reuse the persistence-agnostic
        // domain/CQRS layer.  An event-sourced aggregate has no state table,
        // so the `shape(...)` axis is moot — skip that check for it.
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        if (a.persistedAs !== "eventLog" && shape !== "relational")
          reject(where, `is persisted as shape(${shape})`);
        if (a.isAbstract || a.extendsAggregate)
          reject(where, "participates in aggregate inheritance");
        // Reference-collection associations (`X id[]`) are supported: one
        // ordinal-ordered join table each (DbSchema), bulk-loaded on every
        // read and full-list-replaced on save by the Dapper repository.
        if ((a.parts ?? []).length > 0 || (a.contains ?? []).length > 0)
          reject(where, "contains nested entity parts");
        // Lifecycle stamping is supported (onUpdate mutates the aggregate
        // pre-save; onCreate binds INSERT-only parameters excluded from the
        // upsert SET).  Principal-referencing stamp values stay rejected —
        // no request-scoped principal accessor on the Dapper repository.
        if (
          (a.contextStamps ?? []).some((r) =>
            r.assignments.some((asg) => exprUsesCurrentUser(asg.value)),
          )
        )
          reject(where, "uses a principal-referencing stamp value");
        // Non-principal capability filters are supported (spliced into every
        // SELECT's WHERE by the Dapper emitter); principal-referencing ones
        // (tenancy: currentUser.<field>) stay rejected — there is no
        // request-scoped principal accessor on the Dapper repository.
        if ((a.contextFilters ?? []).some((p) => exprUsesCurrentUser(p)))
          reject(where, "uses a principal-referencing 'filter' capability predicate");
        for (const f of a.fields) {
          // Access modifiers (`managed` / `token` / `internal` / `secret`)
          // are wire-projection concerns handled by the shared Domain/CQRS
          // layers (create-input shaping, `forApiRead` response stripping) —
          // the Dapper column round-trips like any other field, so no gate.
          if (f.provenanced) reject(`field '${agg.name}.${f.name}'`, "is provenanced");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: mikroorm` capability gate (D-REALIZATION-AXES Phase 5d).
//
// The node/hono MikroORM adapter is the SECOND node persistence backend
// (alongside the default `drizzle`), minimal in v1: relational, state-based,
// flat aggregates with scalar / enum / value-object / id-ref fields.  Mirrors
// the dapper gate — reject any feature mikroorm v1 doesn't emit so a selection
// either works end-to-end or fails fast at validate time.  drizzle supports the
// full surface, so this only fires for an explicit `persistence: mikroorm`.
// ---------------------------------------------------------------------------
export function validateMikroOrmSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const MANAGED_ACCESS = new Set(["managed", "token", "internal", "secret"]);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "mikroorm") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message:
          `Deployable '${dep.name}' selects 'persistence: mikroorm', but ${subject} ${reason}. ` +
          `The MikroORM adapter is minimal in v1 (relational, state-based, flat aggregates with ` +
          `scalar / enum / value-object / id-ref fields). Use 'persistence: drizzle' for this model, ` +
          `or remove the unsupported feature.`,
        source: `${sys.name}/${dep.name}`,
        code: "loom.mikroorm-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      if ((ctx.retrievals ?? []).length > 0)
        reject(`context '${ctxName}'`, "declares 'retrieval' query bundles (not yet on MikroORM)");
      if ((ctx.seeds ?? []).length > 0)
        reject(
          `context '${ctxName}'`,
          "declares 'seed' data (the MikroORM seed path is not wired)",
        );
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // Event sourcing IS supported on this adapter (appliers): the
        // `<agg>_events` stream + fold reuse the persistence-agnostic
        // domain/CQRS layer.  An event-sourced aggregate has no state table,
        // so the `shape(...)` axis is moot — skip that check for it.
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        if (a.persistedAs !== "eventLog" && shape !== "relational")
          reject(where, `is persisted as shape(${shape})`);
        if (a.isAbstract || a.extendsAggregate)
          reject(where, "participates in aggregate inheritance");
        if ((a.associations ?? []).length > 0)
          reject(where, "has reference-collection associations (Id[] join tables)");
        if ((a.parts ?? []).length > 0 || (a.contains ?? []).length > 0)
          reject(where, "contains nested entity parts");
        if ((a.contextStamps ?? []).length > 0) reject(where, "uses audit stamping");
        if ((a.contextFilters ?? []).length > 0)
          reject(where, "uses a 'filter' capability predicate");
        for (const f of a.fields) {
          if (f.provenanced) reject(`field '${agg.name}.${f.name}'`, "is provenanced");
          else if (f.access && MANAGED_ACCESS.has(f.access))
            reject(`field '${agg.name}.${f.name}'`, `has server-managed access '${f.access}'`);
        }
      }
    }
  }
}

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
// mismatch.  In Phase 1 every supported kind offers all its
// capabilities, so this is silent for valid models; it becomes load-
// bearing once kinds carry capabilities a sourceType may partially
// support.
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
        message:
          `resource '${resource.name}' (sourceType '${sourceType}') does not offer ` +
          `${missing.map((c) => `'${c}'`).join(", ")} required by context ` +
          `'${need.contextName}' for kind '${need.kind}'.`,
        source: `${sys.name}/${resource.name}`,
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
    if (!sourceType) continue;
    checkConfigBlock(r.config, sourceType, `resource '${r.name}'`, false, sys.name, diags);
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
        message: `${label}: config key '${entry.key}' is not recognised by sourceType '${sourceType}' — it will be ignored.`,
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
        message: `${label}: config key '${entry.key}' expects ${expected}.`,
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
          message: `${label}: required config key '${spec.name}' (sourceType '${sourceType}') is missing.`,
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

function coverageGapReason(kind: string, ctx: BoundedContextIR): string | undefined {
  const aggs = ctx.aggregates;
  if (aggs.length === 0) return "the context declares no aggregates";
  const hasState = aggs.some((a) => (a.persistedAs ?? "state") === "state");
  const hasES = aggs.some((a) => a.persistedAs === "eventLog");
  if (kind === "state" && !hasState) {
    return "every aggregate is persistedAs(eventLog) (none need kind: state persistence)";
  }
  if ((kind === "eventLog" || kind === "snapshot") && !hasES) {
    return "no aggregate is persistedAs(eventLog) (kind: " + kind + " has no event stream to back)";
  }
  // cache / replica only require at least one aggregate, already
  // checked above.
  return undefined;
}

// ---------------------------------------------------------------------------
// Honest-note pass: warn on dataSource knobs the AST validator accepts
// but no current emitter consumes.
//
// At time of writing, three knobs route through to generated code:
//   - `schema`       — EF Core ToTable, Drizzle pgSchema, AshPostgres
//                      `postgres.schema`
//   - `tablePrefix`  — same three emitters (table-name prefix)
//
// The other six knobs validate against the kind/storage compatibility
// matrix in `src/language/validators/datasource.ts` but no emitter
// reads them.  Setting one is a no-op at runtime:
//
//   - `ttl`            — would gate a Redis-backed cache adapter that
//                        doesn't exist yet
//   - `every` / `retain` — would gate snapshot policy on an event-
//                        sourced persister (Marten / hono-ES adapter)
//                        that doesn't exist yet
//   - `readonly`       — would gate a replica-aware DbContext that
//                        doesn't exist yet
//   - `keyPrefix`      — would gate the same Redis cache adapter
//                        gated by `ttl`
//
// `isolationLevel` used to be on this list; it now flows through
// `resolveWorkflowIsolation` into the .NET BeginTransactionAsync and
// Phoenix `Ash.transaction` opts when a workflow in the context is
// transactional and doesn't carry its own per-workflow isolation.
//
// We surface this as a warning at IR-validate time so the author sees
// "validation accepts this but it's a no-op" instead of believing the
// knob has effect.  When an adapter lands that consumes one of these,
// the corresponding entry comes off the list — the truth-telling is
// in code, not in a doc that goes stale.
// ---------------------------------------------------------------------------

interface UnwiredKnob {
  property: keyof DataSourceIR;
  description: string;
}

const UNWIRED_KNOBS: readonly UnwiredKnob[] = [
  { property: "ttl", description: "no Redis-backed cache adapter is implemented yet" },
  {
    property: "every",
    description: "no event-sourced persister with snapshot policy is implemented yet",
  },
  {
    property: "retain",
    description: "no event-sourced persister with snapshot policy is implemented yet",
  },
  { property: "readonly", description: "no replica-aware persister is implemented yet" },
  { property: "keyPrefix", description: "no Redis-backed cache adapter is implemented yet" },
  // Note: the `shape:` knob (D-DOCUMENT-AXIS) is NOT listed here — it is
  // consumed by the backend emitters (relational / embedded / document),
  // and an unsupported shape for a given backend is rejected by the
  // per-backend `supportedShapes` capability check, not warned as inert.
];

// Aggregate-inheritance storage gate (aggregate-inheritance.md, I2/I3).
//
// `ownTable` (TPC) emission is wired on every backend: the abstract base is
// dropped from the generation view (system/index.ts `collectContextsFor`) and
// each concrete emits as a standalone table carrying the merged base + own
// fields (the `wireShape` merge in enrichContext).
//
// `sharedTable` (TPH) is implemented on all three DB backends: Hono/Drizzle
// (hand-rolled shared table + `kind` discriminator, per-concrete columns
// nullable, repos filter/stamp `kind`), .NET/EF Core (native
// `HasDiscriminator`), and Phoenix/Ash (shared-table multi-resource +
// `base_filter` on `kind`). So a TPH hierarchy is allowed iff its context is
// hosted by at least one of those backends; otherwise it's an error (not a
// warning) — there is no implemented emission target.
// `sharedTable` is the omitted-modifier
// default, so an inheritance hierarchy with no `inheritanceUsing(…)` is TPH
// too. Polymorphic `Party id` refs and `find all Party` remain deferred (the
// language validator rejects the former); document / TPT shapes are later.
const DEFAULT_INHERITANCE_LAYOUT = "sharedTable" as const;

/** Map each context name to the set of backend (needsDb) platforms that host
 *  it — a context is TPH-capable iff that set intersects TPH_CAPABLE. */
export function backendPlatformsHostingEachContext(
  loom: EnrichedLoomModel,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sys of loom.systems) {
    for (const d of sys.deployables) {
      if (!descriptorFor(d.platform).needsDb) continue;
      for (const cn of d.contextNames) {
        const set = out.get(cn) ?? new Set<string>();
        set.add(d.platform);
        out.set(cn, set);
      }
    }
  }
  return out;
}

export function validateInheritanceStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const byName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  // TPH storage emission ships on Hono (Drizzle shared table + `kind`), .NET
  // (EF Core native `HasDiscriminator`), and Phoenix (Ash shared-table
  // multi-resource + `base_filter` on `kind`).
  const TPH_CAPABLE = new Set(["node", "dotnet", "elixir", "python", "java"]);
  const hostedByCapable = [...backendPlatforms].some((p) => TPH_CAPABLE.has(p));
  for (const agg of ctx.aggregates) {
    if (!agg.isAbstract && !agg.extendsAggregate) continue;
    // A concrete's layout defaults to its base's (resolved within the
    // context); a per-concrete `inheritanceUsing(…)` override wins. The
    // abstract base uses its own declared layout. Either way an omitted
    // modifier means `sharedTable` (TPH), the documented default.
    const base = agg.extendsAggregate ? byName.get(agg.extendsAggregate) : undefined;
    const effective = agg.inheritanceUsing ?? base?.inheritanceUsing ?? DEFAULT_INHERITANCE_LAYOUT;
    if (effective !== "sharedTable") continue;
    // Implemented when a TPH-capable backend (Hono / .NET / Phoenix) hosts the context.
    if (hostedByCapable) continue;
    const role = agg.isAbstract ? "abstract base" : `extends ${agg.extendsAggregate}`;
    const how = agg.inheritanceUsing
      ? "inheritanceUsing(sharedTable)"
      : "the omitted-modifier default (sharedTable)";
    const others = [...backendPlatforms].filter((p) => !TPH_CAPABLE.has(p));
    const hostNote =
      others.length > 0
        ? `it is hosted by ${others.join(", ")}, where TPH is not implemented`
        : "no Hono, .NET, or Phoenix backend deployable hosts this context";
    diags.push({
      severity: "error",
      code: "loom.tph-backend-unsupported",
      message:
        `aggregate '${agg.name}' (${role}) resolves to sharedTable (TPH) inheritance via ` +
        `${how}, but TPH storage emission is implemented for the Hono, .NET, Phoenix, Python, and Java backends only — ` +
        `${hostNote}. Host the context on a Hono, .NET, or Phoenix deployable, or declare ` +
        `'inheritanceUsing(ownTable)' to use the per-concrete (TPC) layout (all backends). ` +
        `Tracked in aggregate-inheritance.md I2/I3.`,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced storage emission (`persistedAs(eventLog)`, appliers A2) is
// implemented for the Hono (`node`) and .NET (`dotnet`, EF Core) backends:
// the `<agg>_events` stream table + fold-on-load repository. So an
// event-sourced aggregate is allowed iff every backend deployable hosting
// its context implements it. On a backend that doesn't (Phoenix today) the
// aggregate would silently fall back to state persistence, losing the event
// log — an error, not a silent downgrade. Mirrors the TPH storage gate.
//
// For Phoenix specifically the gap is foundation-shaped, not platform-shaped:
// Phoenix itself is domain-layer-agnostic, but `foundation: ash` (today's
// only Phoenix foundation) doesn't have a pure-ES fit (AshEvents is hybrid,
// AshCommanded is heavy, custom Ash.DataLayer is ~months). The planned
// `foundation: vanilla` (D-VANILLA-PHOENIX-FOUNDATION + D-VANILLA-ES-HOME)
// will host pure ES on Phoenix; until it ships the diagnostic names the Ash
// foundation as the constraint and points at the proposal.
const EVENT_SOURCING_BACKENDS = new Set(["node", "dotnet", "python", "java"]);

/** Per-context set of foundations of the elixir deployables hosting it
 *  (`"ash"` / `"vanilla"`).  Event sourcing on elixir is foundation-shaped,
 *  not platform-shaped (D-VANILLA-ES-HOME): the `vanilla` foundation hosts a
 *  pure-ES data layer (per-aggregate stream + fold-on-load), while `ash` has
 *  no pure-ES fit and stays gated.  `validateEventSourcedStorage` consumes
 *  this to tell `elixir+vanilla` (supported) from `elixir+ash` (rejected). */
export function elixirFoundationsHostingEachContext(
  loom: EnrichedLoomModel,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sys of loom.systems) {
    for (const d of sys.deployables) {
      if (d.platform !== "elixir") continue;
      const foundation = d.foundation ?? "ash";
      for (const cn of d.contextNames) {
        const set = out.get(cn) ?? new Set<string>();
        set.add(foundation);
        out.set(cn, set);
      }
    }
  }
  return out;
}

export function validateEventSourcedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
  elixirFoundations: Set<string> = new Set(),
): void {
  // elixir hosts ES only on the vanilla foundation (D-VANILLA-ES-HOME); the
  // Ash foundation has no pure-ES fit, so an `elixir` host counts as ES-capable
  // for this context iff every elixir deployable hosting it uses `vanilla`.
  const elixirEsCapable =
    elixirFoundations.size > 0 && [...elixirFoundations].every((f) => f === "vanilla");
  const isEsCapable = (p: string): boolean =>
    EVENT_SOURCING_BACKENDS.has(p) || (p === "elixir" && elixirEsCapable);
  // Every hosting backend must implement event sourcing; flag the ones that
  // don't (e.g. an Ash-foundation Phoenix deployable hosting the context).
  const unsupported = [...backendPlatforms].filter((p) => !isEsCapable(p));
  const anyBackend = backendPlatforms.size > 0;
  const includesPhoenix = unsupported.includes("elixir");
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    if (anyBackend && unsupported.length === 0) continue;
    const message = includesPhoenix
      ? // Phoenix-specific: name the Ash-foundation constraint, point at the
        // planned vanilla foundation (D-VANILLA-ES-HOME) and the cross-backend
        // escape (host the context on node / dotnet).
        `aggregate '${agg.name}' is persistedAs(eventLog), which requires a pure-ES data ` +
        `layer (per-aggregate stream, fold-on-load, no state table). This is an ` +
        `Ash-foundation limitation, not a Phoenix-platform limitation — Phoenix itself ` +
        `is domain-layer-agnostic, but foundation: ash (today's only Phoenix foundation) ` +
        `has no pure-ES fit: AshEvents is hybrid (keeps the state table), AshCommanded ` +
        `couples to Commanded's infrastructure, and a custom Ash.DataLayer over event ` +
        `streams effectively re-implements AshCommanded. Three escapes: ` +
        `(1) host event-sourced aggregates on a node / dotnet deployable (same .ddd ` +
        `source — they share the cross-backend ES contract); ` +
        `(2) drop persistedAs(eventLog) to use state persistence on Phoenix; ` +
        `(3) switch this deployable to foundation: vanilla on Phoenix, which ` +
        `hosts pure ES (per-aggregate stream + fold-on-load) — see ` +
        `proposals/vanilla-phoenix-foundation.md (D-VANILLA-PHOENIX-FOUNDATION + ` +
        `D-VANILLA-ES-HOME). Tracked in workflow-and-applier.md (appliers A2).`
      : // Generic non-Phoenix unsupported backend (or no backend at all).
        (() => {
          const hostNote =
            unsupported.length > 0
              ? `it is hosted by ${unsupported.join(", ")}, where event-sourced persistence is not implemented`
              : "no event-sourcing-capable (node / dotnet) backend deployable hosts this context";
          return (
            `aggregate '${agg.name}' is persistedAs(eventLog), but event-sourced storage emission ` +
            `is implemented for the Hono (node) and .NET (dotnet) backends only — ${hostNote}. ` +
            `Host the context on a node / dotnet deployable, or drop persistedAs(eventLog) to use ` +
            `state persistence (all backends). Tracked in workflow-and-applier.md (appliers A2).`
          );
        })();
    diags.push({
      severity: "error",
      code: "loom.event-sourcing-backend-unsupported",
      message,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced *workflow* storage gate (workflow-and-applier.md A2-S5b).  A
// `workflow X eventSourced { … apply(…) }` folds its own emitted events into
// state via appliers — the saga analogue of a `persistedAs(eventLog)`
// aggregate (emit-only handlers + pure `apply` folds, no mutable state table).
// The surface (grammar → `WorkflowIR.eventSourced` / `.appliers`) and the
// emit-only / pure-fold discipline (A1) have landed; the **Hono (node) backend
// now emits the event-sourced workflow runtime** (per-correlation `<wf>_events`
// stream, fold-on-load, emit→append-own-event dispatch).  The other backends
// don't yet, so an `eventSourced` workflow hosted by them stays gated —
// otherwise it silently misgenerates as a state-based saga (the saga emitters
// key off `correlationField` alone, emit a mutable `<Wf>State` row + dispatcher,
// and drop the appliers entirely).  A parsed-but-unemitted feature is a footgun,
// so it fails fast — exactly like the event-sourced *aggregate* storage gate,
// and the supported set grows per backend (mirroring `EVENT_SOURCING_BACKENDS`).
const EVENT_SOURCING_WORKFLOW_BACKENDS = new Set(["node", "dotnet", "python", "java"]);
export function validateEventSourcedWorkflowStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
  elixirFoundations: Set<string> = new Set(),
): void {
  // elixir hosts event-sourced workflows only on the vanilla foundation
  // (D-VANILLA-ES-HOME) — the Ash foundation has no pure-ES fit, exactly like
  // event-sourced aggregates (`validateEventSourcedStorage`).
  const elixirEsCapable =
    elixirFoundations.size > 0 && [...elixirFoundations].every((f) => f === "vanilla");
  const isEsCapable = (p: string): boolean =>
    EVENT_SOURCING_WORKFLOW_BACKENDS.has(p) || (p === "elixir" && elixirEsCapable);
  const unsupported = [...backendPlatforms].filter((p) => !isEsCapable(p));
  if (unsupported.length === 0) return;
  const hosts = unsupported.sort().join(", ");
  const includesPhoenix = unsupported.includes("elixir");
  for (const wf of ctx.workflows) {
    if (!wf.eventSourced) continue;
    diags.push({
      severity: "error",
      code: "loom.event-sourced-workflow-unsupported",
      message:
        `workflow '${wf.name}' is eventSourced, but event-sourced workflow storage ` +
        `(a per-correlation event stream folded through its apply(...) blocks) is ` +
        `implemented on the Hono (node), .NET (dotnet), Python (FastAPI), Java (Spring) ` +
        `and elixir-vanilla backends — this context is also hosted by ${hosts}. ` +
        (includesPhoenix
          ? `On Phoenix this is a foundation constraint: the Ash foundation has no pure-ES ` +
            `fit, so switch the deployable to foundation: vanilla (D-VANILLA-ES-HOME). Otherwise host `
          : `Host `) +
        `the context on a supported deployable, drop the eventSourced modifier ` +
        `to use a state-based saga (a persisted correlation-state row, supported on ` +
        `node / dotnet / java / python / elixir-vanilla), or move the event-fold logic ` +
        `into an event-sourced aggregate (persistedAs(eventLog)). ` +
        `Tracked in workflow-and-applier.md (A2-S5b).`,
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// the Hono (`node`) and .NET (`dotnet`) backends — the lineage SDK + co-located
// `<field>_provenance` column + the `provenance_records` flush.  On a backend
// that doesn't (phoenix today) a `provenanced` field silently behaves like a
// plain field, dropping the audit trail it promises — an error, not a silent
// no-op.  Mirrors the event-sourcing storage gate (a parsed-but-unemitted
// feature is a footgun, so it fails fast).
const PROVENANCE_BACKENDS = new Set(["node", "dotnet"]);
export function validateProvenancedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !PROVENANCE_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    const provFields = agg.fields.filter((f) => f.provenanced);
    if (provFields.length === 0) continue;
    if (anyBackend && unsupported.length === 0) continue;
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where the provenance runtime is not emitted`
        : "no provenance-capable (node / dotnet) backend deployable hosts this context";
    const names = provFields.map((f) => f.name).join(", ");
    diags.push({
      severity: "error",
      code: "loom.provenanced-backend-unsupported",
      message:
        `aggregate '${agg.name}' has provenanced field(s) ${names}, but the provenance runtime ` +
        `(trace capture + history) is emitted for the Hono (node) and .NET (dotnet) backends only — ${hostNote}. ` +
        `Host the context on a node or dotnet deployable, or drop the 'provenanced' modifier to use a plain ` +
        `field (all backends). Tracked in provenance.md / type-system-feature-migration.md (DBT-1).`,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Per-operation audit-record emission (`operation … audited`) is implemented for
// the Hono (`node`) and .NET (`dotnet`) backends — an audited public route /
// command handler appends a who/what/when + before/after snapshot to the audit
// sink in the operation's save transaction.  Audited LIFECYCLE actions (`audited
// create` / `destroy`) stay node-only — the .NET create/destroy handlers are
// not yet instrumented, so hosting one on dotnet would silently record nothing.
// Either mismatch is an error, not a silent no-op.  (This gates the per-operation
// `audited` flag only; the `with audit` capability macro emits stamping rules via
// `contextStamps`, a separate concern.)
const AUDIT_OP_BACKENDS = new Set(["node", "dotnet"]);
const AUDIT_LIFECYCLE_BACKENDS = new Set(["node"]);
export function validateAuditedOperationSupport(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const anyBackend = backendPlatforms.size > 0;
  const opUnsupported = [...backendPlatforms].filter((p) => !AUDIT_OP_BACKENDS.has(p));
  const lifecycleUnsupported = [...backendPlatforms].filter(
    (p) => !AUDIT_LIFECYCLE_BACKENDS.has(p),
  );
  const push = (
    agg: BoundedContextIR["aggregates"][number],
    kind: "operation" | "lifecycle action",
    names: string[],
    unsupported: string[],
    capable: string,
  ): void => {
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where audit-record emission is not implemented`
        : `no audit-capable (${capable}) backend deployable hosts this context`;
    diags.push({
      severity: "error",
      code: "loom.audited-backend-unsupported",
      message:
        `aggregate '${agg.name}' has 'audited' ${kind}(s) ${names.join(", ")}, but per-operation ` +
        `audit-record emission for ${kind}s is implemented for the ${capable} backend(s) only — ${hostNote}. ` +
        `Host the context on a capable deployable, or drop the 'audited' modifier (all backends). ` +
        `Tracked in audit-and-logging.md.`,
      source: `${ctx.name}/${agg.name}`,
    });
  };
  for (const agg of ctx.aggregates) {
    const auditedOps = agg.operations.filter((o) => o.audited);
    if (auditedOps.length > 0 && (!anyBackend || opUnsupported.length > 0)) {
      push(
        agg,
        "operation",
        auditedOps.map((o) => o.name),
        opUnsupported,
        "Hono (node) / .NET (dotnet)",
      );
    }
    const auditedLifecycle = [...(agg.creates ?? []), ...(agg.destroys ?? [])].filter(
      (o) => o.audited,
    );
    if (auditedLifecycle.length > 0 && (!anyBackend || lifecycleUnsupported.length > 0)) {
      push(
        agg,
        "lifecycle action",
        auditedLifecycle.map((o) => o.name || "<create>"),
        lifecycleUnsupported,
        "Hono (node)",
      );
    }
  }
}

export function validateDataSourceUnwiredKnobs(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const ds of sys.dataSources) {
    for (const knob of UNWIRED_KNOBS) {
      const value = ds[knob.property];
      if (value === undefined) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-knob-unwired",
        message:
          `resource '${ds.name}' sets '${knob.property}', but ${knob.description}.  ` +
          `The value is accepted by validation and persisted in the IR but no current ` +
          `emitter consumes it — this is a no-op at runtime.`,
        source: `${sys.name}/${ds.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Auth validation.
//
// Two responsibilities:
//
//   1. System-wide shape: a deployable opting in via `auth: required`
//      needs the system to declare a `user { ... }` block (otherwise
//      there's no shape for the verifier hook to decode tokens into).
//      Duplicate user-field names rejected here too, defensively —
//      the parser doesn't structurally enforce uniqueness.
//
//   2. `currentUser` scope: the magic identifier resolves to a typed
//      ref via `lower-expr.ts:resolveNameRef` whenever the system
//      declares a user block.  Bodies may USE `currentUser` in
//      operations / workflows / view binds / aggregate test bodies,
//      plus repository find / view where filters; everywhere else
//      (invariants, derived properties, function bodies) the reference
//      is rejected with a friendly message pointing at where it is
//      allowed.
// ---------------------------------------------------------------------------

export function validateAuth(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // (1) Duplicate user-field names — Property doesn't structurally
  // enforce uniqueness, so a hand-rolled `user { id: string, id: int }`
  // would silently lower to two fields with the same name.
  if (sys.user) {
    const seen = new Set<string>();
    for (const f of sys.user.fields) {
      if (seen.has(f.name)) {
        diags.push({
          severity: "error",
          code: "loom.user-duplicate-field",
          message: `system '${sys.name}': user block declares field '${f.name}' more than once.`,
          source: `${sys.name}/user`,
        });
      }
      seen.add(f.name);
    }
  }
  // (2) `auth: required` deployables MUST have a user block.  Without
  // one, the verifier hook has no shape to populate, and `currentUser`
  // references in any body would resolve to an unknown ref.
  for (const d of sys.deployables) {
    if (d.auth?.required && !sys.user) {
      diags.push({
        severity: "error",
        code: "loom.auth-no-user-block",
        message:
          `deployable '${d.name}' has 'auth: required' but system '${sys.name}' declares no 'user { ... }' block. ` +
          `Add a system-level user block describing the JWT claim shape (e.g. 'user { id: string, role: string }').`,
        source: `${sys.name}/${d.name}`,
      });
    }
  }
}

// `validateScaffoldDoubles` deleted.  Cross-directive
// double-scaffold detection now happens at the AST level: two
// scaffold directives producing the same generated page name surface
// either as a duplicate-symbol error from Langium's linker (when both
// pages reach the AST) or as a no-op in the expander (the second
// synthesis is suppressed by the per-ui name set).  Keeping the IR-
// level fallback would either duplicate the error or produce a
// confusing second diagnostic; better to let the AST layer own it.

export function validatePermissions(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const mod of sys.subdomains) {
    if (mod.permissions.length === 0) continue;
    const seen = new Set<string>();
    for (const p of mod.permissions) {
      if (seen.has(p.name)) {
        diags.push({
          severity: "error",
          code: "loom.duplicate-permission",
          message: `subdomain '${mod.name}': permission '${p.name}' is declared more than once.`,
          source: `${sys.name}/${mod.name}/permissions.${p.name}`,
        });
      }
      seen.add(p.name);
    }
  }
}
