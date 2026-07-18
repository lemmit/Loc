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
import { lowerFirst, snake } from "../../../util/naming.js";
import {
  capabilitiesFor,
  configSchemaFor,
  supportsSurfaceKind,
} from "../../../util/source-types.js";
import { pagedReturn } from "../../stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ConfigEntryIR,
  ConfigValueIR,
  DataSourceIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedLoomModel,
  EnrichedSystemIR,
  EntityPartIR,
  ExprIR,
  FunctionIR,
  OperationIR,
  SavingShape,
  StmtIR,
  SubdomainIR,
  SystemIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import { exprUsesCurrentUser } from "../../types/loom-ir.js";
import { aggregateFileField } from "../../util/file-field.js";
import {
  firstUnlowerableForAdapter,
  isFindPredicateAdapter,
} from "../../util/find-predicate-capability.js";
import { opHasProvSite } from "../../util/prov-id.js";
import {
  dataSourceKindForAggregate,
  effectiveSavingShape,
  isDocumentShaped,
  resolveDataSourceConfig,
} from "../../util/resolve-datasource.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";
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

// `auth: ui` (the frontend OIDC guard) is emitted by the React, Vue, Svelte,
// and Angular generators.  A deployable whose resolved UI framework is none of
// those (phoenixLiveView) would silently emit no guard — reject it loudly
// so the limitation is visible rather than a no-op.
const AUTH_UI_FRAMEWORKS = new Set(["react", "vue", "svelte", "angular"]);

// paged-run (paged-queryHandler): a `queryHandler H(...): <Agg> paged` is
// emitted by each backend whose explicit-handler emitter has grown the paged
// branch (mirroring Hono's `emitPagedRunHandler`).  A backend NOT in
// `PAGED_QH_SUPPORTED` would crash on the `paged` generic carrier at its
// return-type render, so gate a paged queryHandler hosted on such a deployable
// with an honest diagnostic until its emitter fans out — a reviewed gap rather
// than a silent codegen crash.
const PAGED_QH_SUPPORTED = new Set(["node", "python", "java", "dotnet", "elixir"]);

export function validatePagedQueryHandlerBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    // Only backend platforms emit application-layer handlers; the ones in
    // `PAGED_QH_SUPPORTED` render the paged branch.  Frontends / non-backend
    // platforms are skipped (they host no handlers).
    if (!platformOwnsBackend(d.platform) || PAGED_QH_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const h of c.queryHandlers ?? []) {
        if (!pagedReturn(h.returnType)) continue;
        diags.push({
          severity: "error",
          code: "loom.paged-query-handler-unsupported-backend",
          message: `queryHandler '${h.name}' returns a \`paged\` envelope, which is currently only emitted on the node (Hono) backend; deployable '${d.name}' (platform '${d.platform}') can't generate it yet.`,
          source: `${c.name}/${h.name}`,
        });
      }
    }
  }
}

export function validateAuthUiFramework(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    if (!d.auth?.ui) continue;
    if (!AUTH_UI_FRAMEWORKS.has(d.uiFramework ?? "")) {
      diags.push({
        severity: "error",
        code: "loom.auth-ui-unsupported-framework",
        message: `Deployable '${d.name}': 'auth: ui' is currently only supported on react, vue, svelte, and angular frontends; framework '${d.uiFramework ?? "unknown"}' isn't supported yet.`,
        source: d.name,
      });
    }
  }
}

// Page/component `derived name: T = expr` bindings are supported on every
// frontend now — React/Vue/Svelte/Angular hoist a reactive computed
// (`useMemo` / `computed` / `$derived` / `computed`); Phoenix/HEEx
// inline-recomputes the expr at each use.  No framework gate is needed.

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
// Read endpoints — **views** and repository **finds** — are in scope too: each
// is a GET endpoint, and both now carry an optional `requires <expr>` gate (the
// read-side twin of an operation's in-handler 403).  An ungated read under
// denyByDefault serves to any caller; `requires true` is the explicit
// intentionally-public escape.
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
      // Views: each is a GET endpoint.  A `view … requires <expr>` gate is the
      // read-side analogue of an operation's `requires` (in-handler 403); an
      // ungated view under denyByDefault serves to any caller.  `requires true`
      // (a literal gate) is the explicit intentionally-public escape.
      for (const view of c.views) {
        if (!view.requires) {
          diags.push({
            severity: "error",
            code: "loom.default-deny-ungated",
            message: `denyByDefault: view '${view.name}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
            source: `view/${view.name}`,
          });
        }
      }
      // Repository finds: each author-declared named find is its own GET route
      // and now carries the same optional `requires <expr>` gate.  The aggregate
      // list-all endpoint (the auto-injected `find all`) is out of scope — it is
      // compiler-synthesized and has no author source line to attach a gate to;
      // gating it needs an aggregate-level default-read surface (follow-up).
      // Internal synthesized finds (paged-run helpers) are never their own route.
      for (const repo of c.repositories) {
        for (const find of repo.finds) {
          if (find.synthesized || find.name === "all") continue;
          if (!find.requires) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: `denyByDefault: find '${repo.name}.${find.name}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
              source: `find/${repo.name}.${find.name}`,
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
// Compose uniqueness — the generated `docker-compose.yml` publishes each
// deployable's `port` on the host and keys every service by its
// `serviceSlug(name)` (= `naming.snake`).  Two deployables sharing a host
// port (e.g. both defaulted to 3000) make
// `docker compose up` abort with a port-in-use error; two deployables whose
// names slug to the same key (`SalesApi2` / `salesApi2` → `sales_api2`)
// silently merge into one output directory + one compose service.  Both are
// deploy-time breakage the IR can catch here (finding 20 / B24).
// ---------------------------------------------------------------------------

export function validateComposeUniqueness(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Host-port collisions across deployables (plus the bundled Keycloak port).
  const ownersByPort = new Map<number, string[]>();
  const addOwner = (port: number, owner: string): void => {
    const list = ownersByPort.get(port);
    if (list) list.push(owner);
    else ownersByPort.set(port, [owner]);
  };
  for (const d of sys.deployables) addOwner(d.port, `deployable '${d.name}'`);
  // The bundled Keycloak never collides: the emitter (`keycloakHostPort` in
  // src/system/index.ts) publishes it on the first free port >= 8081,
  // stepping past any port a deployable claims.
  for (const [port, owners] of ownersByPort) {
    if (owners.length < 2) continue;
    diags.push({
      severity: "error",
      code: "loom.duplicate-host-port",
      message:
        `Host port ${port} is published by more than one service (${owners.join(", ")}); ` +
        `\`docker compose up\` would abort with a port-in-use error. Give each deployable a ` +
        `distinct \`port:\`.`,
      source: sys.name,
    });
  }

  // Service-slug collisions across deployables (case-variant names merge dirs).
  const namesBySlug = new Map<string, string[]>();
  for (const d of sys.deployables) {
    const slug = snake(d.name);
    const list = namesBySlug.get(slug);
    if (list) list.push(d.name);
    else namesBySlug.set(slug, [d.name]);
  }
  for (const [slug, names] of namesBySlug) {
    if (names.length < 2) continue;
    diags.push({
      severity: "error",
      code: "loom.duplicate-service-slug",
      message:
        `Deployables ${names.map((n) => `'${n}'`).join(", ")} all resolve to the same ` +
        `docker-compose service slug '${slug}', so they would silently merge into one output ` +
        `directory and one compose service. Rename them to distinct slugs (names must differ by ` +
        `more than case / punctuation).`,
      source: sys.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Channel wiring (channels.md §"Surface — transport binding", M-T4.4 slice 1).
// Cross-file/system-level twins of the AST-level channelSource matrix checks:
//
//   - `loom.channelsource-unbound` (warning) — a channelSource no deployable
//     lists in `channels:`.  Declared but inert: no broker is provisioned and
//     no client emitted for it.  Only fires when the system declares
//     deployables at all (legacy single-project generation has nowhere to
//     wire a binding).
//   - `loom.deployable-channel-unrelated` (warning) — a deployable lists a
//     channelSource but neither hosts the channel's owning context (producer
//     side) nor consumes any carried event via a reactor / event-triggered
//     create / projection fold in a hosted context.  Dead wiring.
//   - `loom.channel-consumer-unwired` (error) — a deployable consumes a
//     channel's events, some deployable binds that channel to a broker, but
//     this consumer doesn't list the binding: once the channel's traffic
//     rides the broker, this consumer would silently never receive it.
//     (The producer side stays a local re-entry fallback, so only the
//     consumer gap is a delivery hole — M-T4.4 design §5.)
// ---------------------------------------------------------------------------
export function validateChannelWiring(sys: SystemIR, diags: LoomDiagnostic[]): void {
  if ((sys.channelSources ?? []).length === 0) return;
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  // channel name -> owning context (channels are context members; bare names
  // are system-unique per the channelSource resolution rule).
  const channelOwner = new Map<string, { ctxName: string; carries: string[] }>();
  for (const m of sys.subdomains)
    for (const c of m.contexts)
      for (const ch of c.channels ?? [])
        channelOwner.set(ch.name, { ctxName: c.name, carries: ch.carries });
  const csByName = new Map(sys.channelSources.map((cs) => [cs.name, cs]));

  // The event names a deployable's hosted contexts consume (reactor `on`,
  // event-triggered `create … by`, projection folds) — the same trigger set
  // `deriveEventSubscriptions` wires for in-process dispatch.
  const consumedEventsOf = (dep: DeployableIR): Set<string> => {
    const consumed = new Set<string>();
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const wf of ctx.workflows ?? []) {
        for (const on of wf.subscriptions ?? []) consumed.add(on.event);
        for (const create of wf.creates ?? []) {
          if (create.triggerKind === "event" && create.eventRef) consumed.add(create.eventRef);
        }
      }
      for (const proj of ctx.projections ?? [])
        for (const on of proj.handlers) consumed.add(on.event);
    }
    return consumed;
  };

  // 1. Unbound channelSource.
  if (sys.deployables.length > 0) {
    const wired = new Set(sys.deployables.flatMap((d) => d.channelSourceNames ?? []));
    for (const cs of sys.channelSources) {
      if (wired.has(cs.name)) continue;
      diags.push({
        severity: "warning",
        code: "loom.channelsource-unbound",
        message:
          `channelSource '${cs.name}' (channel '${cs.channelName}') is listed by no ` +
          `deployable's 'channels:' clause — the binding is declared but inert: no broker ` +
          `is provisioned and events stay on in-process dispatch. Add it to a deployable ` +
          `that produces or consumes '${cs.channelName}', or remove it.`,
        source: `${sys.name}/${cs.name}`,
      });
    }
  }

  // channel name -> the channelSource names some deployable actually wires.
  const activeBindings = new Map<string, string[]>();
  for (const dep of sys.deployables) {
    for (const csName of dep.channelSourceNames ?? []) {
      const cs = csByName.get(csName);
      if (!cs) continue;
      const list = activeBindings.get(cs.channelName) ?? [];
      if (!list.includes(cs.name)) list.push(cs.name);
      activeBindings.set(cs.channelName, list);
    }
  }

  for (const dep of sys.deployables) {
    const consumed = consumedEventsOf(dep);
    const hosted = new Set(dep.contextNames);
    const listed = new Set(dep.channelSourceNames ?? []);

    // 2. Unrelated listing.
    for (const csName of dep.channelSourceNames ?? []) {
      const cs = csByName.get(csName);
      if (!cs) continue;
      const owner = channelOwner.get(cs.channelName);
      if (!owner) continue; // unresolved channel name — AST/linker reports it
      const produces = hosted.has(owner.ctxName);
      const consumes = owner.carries.some((e) => consumed.has(e));
      if (!produces && !consumes) {
        diags.push({
          severity: "warning",
          code: "loom.deployable-channel-unrelated",
          message:
            `Deployable '${dep.name}' lists channelSource '${cs.name}', but it neither ` +
            `hosts channel '${cs.channelName}'\`s owning context ('${owner.ctxName}') nor ` +
            `consumes any event it carries (${owner.carries.join(", ") || "none"}). ` +
            `This wiring routes nothing — remove it, or host a producing/consuming context.`,
          source: `${sys.name}/${dep.name}`,
        });
      }
    }

    // 3. Consumer unwired while the channel is broker-bound elsewhere.
    if (!platformOwnsBackend(dep.platform)) continue; // frontends consume via M-T1.10 realtime
    for (const [chName, csNames] of activeBindings) {
      const owner = channelOwner.get(chName);
      if (!owner) continue;
      if (!owner.carries.some((e) => consumed.has(e))) continue;
      if (csNames.some((n) => listed.has(n))) continue;
      diags.push({
        severity: "error",
        code: "loom.channel-consumer-unwired",
        message:
          `Deployable '${dep.name}' consumes events of channel '${chName}' ` +
          `(${owner.carries.filter((e) => consumed.has(e)).join(", ")}), which is bound to a ` +
          `broker via channelSource '${csNames[0]}' on another deployable — but '${dep.name}' ` +
          `doesn't list the binding. Once traffic rides the broker this consumer would ` +
          `silently receive nothing. Add \`channels: [${csNames[0]}]\` to '${dep.name}'.`,
        source: `${sys.name}/${dep.name}`,
      });
    }
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
// File-field object-storage coverage.  A `File` primitive is passive/
// wire-only: it stores a `FileRef` reference in the row (JSONB), while the
// bytes live in an object store.  A backend deployable that hosts a
// File-bearing aggregate must therefore bind at least one `objectStore`
// dataSource (an `s3` / `localDisk` storage), or the upload/download
// endpoints have nowhere to put the bytes.  Frontend-only platforms own no
// storage and can't bind one, so they're skipped (a react frontend serves
// the wire shape, not the object).
// ---------------------------------------------------------------------------
export function validateFileFieldObjectStorage(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const dsByName = new Map<string, DataSourceIR>();
  for (const d of sys.dataSources) dsByName.set(d.name, d);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const hasObjectStore = (dep.dataSourceNames ?? []).some(
      (n) => dsByName.get(n)?.kind === "objectStore",
    );
    if (hasObjectStore) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const fileField = aggregateFileField(agg as AggregateIR);
        if (!fileField) continue;
        diags.push({
          severity: "error",
          code: "loom.file-field-needs-object-storage",
          message:
            `Deployable '${dep.name}' hosts aggregate '${ctxName}.${agg.name}' ` +
            `which has a \`File\` field ('${fileField}'), but binds no object-store ` +
            `dataSource.  A \`File\` stores its bytes in an object store — declare a ` +
            `\`storage <s> { type: localDisk }\` (or \`s3\`), a ` +
            `\`dataSource <ds> { for: ${ctxName}, kind: objectStore, use: <s> }\`, and ` +
            `add '<ds>' to '${dep.name}'\`s 'dataSources:' list.`,
          source: `${sys.name}/${dep.name}`,
        });
      }
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
    const base = platformSavingShapes(dep.platform);
    if (!base) continue;
    // elixir (plain Ecto) emits the opaque `(id, data, version)` document table
    // + a schemaless-changeset validated fold, so it supports `document` on top
    // of the platform's relational / embedded set.
    const supported =
      dep.platform === "elixir" ? ([...base, "document"] as readonly SavingShape[]) : base;
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
// Vanilla `shape(document)` scope (DEBT-07).  The vanilla document path emits the
// CRUD surface (list / get / create / update / delete) over the `(id, data,
// version)` jsonb row, PLUS — since DEBT-07 — SCALAR custom finds (in-memory
// filter over the loaded rows) and SCALAR named operations (the body runs over
// the normalised `data` map, then persists through the document repository's
// `update/2`).  A document blob has no flattened struct columns, so a handful of
// op/find shapes still need machinery the document path deliberately omits, and
// those stay gated (an honest error rather than a mis-emit):
//
//   - a RETURNING op (`: A or B`), an AUDITED op, a PROVENANCED op — all persist
//     a pre-built changeset over struct columns inside a forced transaction;
//   - COLLECTION mutation (`items += …`) — a document's contained parts are gated
//     separately (`loom.vanilla-containment-unsupported`) anyway;
//   - a body/filter that reads a VALUE-OBJECT sub-field, a DERIVED, or calls a
//     `function` / value-object constructor — these need the loaded struct / list
//     the jsonb map can't reconstruct in-place;
//   - a PAGED or UNION-returning custom find (the wire-envelope / tagged-result
//     shapes the document find path doesn't build).
//
// Everything else — scalar `assign` / `+=` / `-=` / `precondition` / `requires`
// / `let` / `emit`, and scalar/convention/`where`-clause finds — is emitted.
// ---------------------------------------------------------------------------
const VANILLA_DOC_CRUD_OPS = new Set(["create", "update", "delete", "destroy", "list", "get"]);

/** Does an expression reach a shape the vanilla document scalar path can't emit?
 *  A derived read, a *dereferenced-entity* member (cross-aggregate `X id` join),
 *  a collection METHOD (`.sum`/`.filter`/`.contains` — lambdas over jsonb maps),
 *  a constructor / match / lambda — anything beyond scalar arithmetic,
 *  whole-field / value-object-subfield / `.count` reads over the `data` map, and
 *  (when `allowFnCall`) calls to the aggregate's own pure `function`s.
 *
 *  `allowFnCall` is true when the aggregate's `function` members are all
 *  themselves doc-safe (verified once per aggregate) — then a `callKind:
 *  "function"` is emittable (the function is rendered in the same `docMap` mode).
 *  It is also passed `true` while verifying each function body, so a function
 *  that calls a sibling function stays admissible (the sibling is verified too —
 *  the whole call graph is checked, no recursion needed here). */
function docExprUnsupported(e: ExprIR, allowFnCall: boolean): boolean {
  const bad = (x: ExprIR): boolean => docExprUnsupported(x, allowFnCall);
  switch (e.kind) {
    case "ref":
      // A `this-derived` read has no stored `data` key (derived aren't
      // persisted); every other ref (this-prop / this-vo-prop whole read / param
      // / let / enum-value / current-user) is a plain scalar/map read.
      return e.refKind === "this-derived";
    case "member":
      // Supported: `this.<scalar>` (receiver `this`, entity type → `data[k]`), a
      // value-object SUB-field (`this.money.amount` → `data["money"]["amount"]`),
      // an array `.count`/`.length` (→ `Enum.count`).  NOT supported: a member off
      // a *dereferenced* entity (a cross-aggregate ref → needs a join the document
      // path can't do) — an entity receiver that isn't the aggregate's own `this`.
      if (e.receiverType.kind === "entity" && e.receiver.kind !== "this") return true;
      return bad(e.receiver);
    case "method-call":
      // A collection op (`.sum`/`.filter`/`.contains`) runs a lambda over the
      // jsonb list of string-keyed maps — the loaded-struct machinery the scalar
      // path lacks; a value-object method is the same story.  A scalar-receiver
      // method (string/number) is fine.
      return (
        e.isCollectionOp ||
        e.receiverType.kind === "valueobject" ||
        e.receiverType.kind === "array" ||
        bad(e.receiver) ||
        e.args.some(bad)
      );
    case "call":
      // A pure aggregate `function` call is emittable when the aggregate's
      // functions are doc-safe; every other call kind (value-object ctor, private
      // operation, domain service, resource op) still needs machinery the scalar
      // path omits.
      if (e.callKind === "function" && allowFnCall) return e.args.some(bad);
      return true;
    case "object":
      // A bare object literal — the data map a returning op's error-variant
      // `return TooMany { … }` ships — is a plain map on the document path.
      return e.fields.some((f) => bad(f.value));
    case "binary":
      return bad(e.left) || bad(e.right);
    case "unary":
      return bad(e.operand);
    case "paren":
      return bad(e.inner);
    case "ternary":
      return bad(e.cond) || bad(e.then) || bad(e.otherwise);
    case "convert":
      return bad(e.value);
    case "literal":
    case "id":
    case "this":
      return false;
    default:
      // new / object / match / lambda / list / *-call — all need the struct /
      // list / tuple machinery the document scalar path omits.
      return true;
  }
}

/** Does a pure `function` body reach a non-doc-safe shape?  Sibling-function
 *  calls are admitted (`allowFnCall` true) because every function is checked, so
 *  the whole graph is verified without recursing here. */
function docFunctionUnsupported(fn: FunctionIR): boolean {
  const body = fn.body;
  const exprs: ExprIR[] = "expr" in body ? [body.expr] : [];
  if ("stmts" in body) {
    for (const s of body.stmts) {
      switch (s.kind) {
        case "precondition":
        case "requires":
        case "let":
        case "expression":
          exprs.push(s.expr);
          break;
        case "return":
          exprs.push(s.value);
          break;
        case "call":
          exprs.push(...s.args);
          break;
      }
    }
  }
  return exprs.some((e) => docExprUnsupported(e, /* allowFnCall */ true));
}

/** Is the value of a containment `+=`/`-=` a doc-safe part constructor?  Route A:
 *  `lines += OrderLine { sku: …, qty: … }` appends a part struct to the embed's
 *  `embeds_many` list, so the value must be a part ctor (`new`/`object`) whose
 *  field values are themselves doc-safe scalars/VOs. */
function docContainmentValueUnsupported(e: ExprIR, allowFnCall: boolean): boolean {
  if (e.kind === "new" || e.kind === "object") {
    return e.fields.some((f) => docExprUnsupported(f.value, allowFnCall));
  }
  // A `-=` may pass a bare element/predicate — fall back to the scalar check.
  return docExprUnsupported(e, allowFnCall);
}

/** Does an operation statement fall outside the vanilla document op surface?
 *  `allowFnCall` mirrors {@link docExprUnsupported}; `agg` distinguishes a
 *  CONTAINMENT collection (embeds_many — mutable on document, Route A) from a
 *  reference/value collection (still gated). */
function docStmtUnsupported(s: StmtIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  const bad = (e: ExprIR): boolean => docExprUnsupported(e, allowFnCall);
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return bad(s.expr);
    case "assign":
      // A nested write target (`money.amount := …`, `segments.length > 1`) has no
      // single field to struct-update — the path only writes top-level fields.  A
      // whole-field write (incl. replacing a value object) is fine.
      return s.target.segments.length > 1 || bad(s.value);
    case "add":
    case "remove": {
      // Scalar compound arithmetic (`total += n`) is fine.  A COLLECTION mutation
      // is supported ONLY for a CONTAINMENT (`lines += Item{…}`): the relational
      // add/remove arm appends/removes a part struct and the op re-embeds the
      // mutated list via `put_embed` (Route A slice 4b — boot-verified).  A
      // reference collection (`X id[]` → many_to_many) and a scalar value
      // collection stay gated (no join table / not-yet-wired on a document blob).
      if (s.collection) {
        const field = snake(s.target.segments[0] ?? "");
        const isContainment = agg.contains.some((c) => snake(c.name) === field);
        if (!isContainment) return true;
        return s.target.segments.length > 1 || docContainmentValueUnsupported(s.value, allowFnCall);
      }
      return s.target.segments.length > 1 || bad(s.value);
    }
    case "emit":
      return s.fields.some((f) => bad(f.value));
    case "return":
      // A returning op's `return <value>` — an error-variant object literal is a
      // plain response map.  A private-operation self-call in tail position stays
      // gated (`docExprUnsupported` rejects the non-function call).
      return bad(s.value);
    default:
      // call / variant-match — need the self-call / frontend machinery the
      // document op path doesn't carry.
      return true;
  }
}

/** A user-defined document operation the path can't emit.  `allowFnCall` is set
 *  once per aggregate from whether its `function`s are all doc-safe.  A RETURNING
 *  op is admitted (persisting tagged tuple, #1774) and CONTAINMENT mutation is
 *  admitted (Route A); an AUDITED op — named (slice 4e) or returning (slice 4f) —
 *  is admitted (the persist tail records an audit row in a `Repo.transaction`).  A
 *  PROVENANCED op stays gated (a jsonb blob has no co-located `<field>_provenance`
 *  columns to drain a history buffer into). */
function docOpUnsupported(op: OperationIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  return opHasProvSite(op) || op.statements.some((s) => docStmtUnsupported(s, allowFnCall, agg));
}

export function validateVanillaDocumentScope(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.platform !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        if (!isDocumentShaped(enriched, resolveDataSourceConfig(enriched, ctx, sys))) continue;
        // A pure `function` call is emittable only when every function on the
        // aggregate is itself doc-safe (they render in the same `docMap` mode —
        // reading the jsonb `data` map); if any is not, a body that calls one is
        // gated.  Computed once here and threaded into the op/find checks.
        const allowFnCall = (agg.functions ?? []).every((fn) => !docFunctionUnsupported(fn));
        // A custom find is unsupported only when its predicate reads a non-scalar
        // shape.  PAGED finds (Route A slice 4c) and UNION finds (Route A slice 4d)
        // are now supported: `renderDocFindFn` returns the single-get `{:ok, nil}`/
        // `{:ok, record}` tuple the shared find controller translates to the tagged
        // union wire (found → 200 body, absent → 404 / RFC-7807 via `problem_variant`).
        const badFinds = (
          (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name)?.finds ?? []
        )
          .filter((f) => f.name !== "all")
          .filter((f) => f.filter != null && docExprUnsupported(f.filter, allowFnCall));
        const badOps = agg.operations
          .filter((op) => !VANILLA_DOC_CRUD_OPS.has(op.name))
          .filter((op) => docOpUnsupported(op, allowFnCall, agg));
        if (badFinds.length === 0 && badOps.length === 0) continue;
        const bits: string[] = [];
        if (badOps.length > 0)
          bits.push(`named operation(s) ${badOps.map((o) => o.name).join(", ")}`);
        if (badFinds.length > 0)
          bits.push(`custom find(s) ${badFinds.map((f) => f.name).join(", ")}`);
        diags.push({
          severity: "error",
          code: "loom.vanilla-document-unsupported",
          message:
            `aggregate '${ctxName}.${agg.name}' is shape(document) on elixir, which emits ` +
            `scalar custom finds + named operations but not ${bits.join(" and ")} ` +
            `(audited returning / provenanced ops, collection mutation, value-object/derived/` +
            `function reads, or non-scalar find predicates). Simplify them to scalar form, host this ` +
            `aggregate on a backend with full document support (node / dotnet / python / java), ` +
            `or use shape(relational) / shape(embedded).`,
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-class operation→operation self-call position on elixir (vanilla).
//
// An aggregate operation compiles to a context function `<op>_<agg>(record,
// params)` that returns a tagged `{:ok,_} | {:error,_}` tuple (exception-less.md
// — the same carrier the controller `case`s on).  A sibling-operation self-call
// can therefore only be PASSED THROUGH as the whole `return` value (the enclosing
// op returns the same tagged shape) — it cannot be composed into a larger
// expression or bound with `let`, because a tuple has no implicit unwrap in
// Elixir.  The other backends model an operation as a plain method returning its
// value directly, so they compose freely; on vanilla the non-tail case would
// silently emit a tuple into arithmetic / a struct field, so reject it up front.
// (A `function` self-call is unrestricted — functions are pure, arity-1, and
// return their value directly.)  Mirrors `loom.vanilla-document-unsupported`.
// ---------------------------------------------------------------------------

/** Is this expression a sibling-operation self-call (vs a pure `function` /
 *  value-object ctor / repo read)?  Operations — public and private — lower to
 *  the `private-operation` callKind. */
function isOperationSelfCall(e: ExprIR): e is ExprIR & { kind: "call" } {
  return e.kind === "call" && e.callKind === "private-operation";
}

/** Visit every expression a statement roots — the value-bearing arms only
 *  (mirrors the lowering's statement shapes); a bare `call` statement is itself
 *  a no-op op-call on vanilla and is handled there, so its receiver is not an
 *  expression to flag. */
function eachStmtExpr(s: StmtIR, visit: (e: ExprIR) => void): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      walkExpr(s.expr, visit);
      break;
    case "return":
    case "assign":
    case "add":
    case "remove":
      walkExpr(s.value, visit);
      break;
    case "emit":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
  }
}

export function validateElixirOpSelfCallPosition(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.platform !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        for (const op of agg.operations as OperationIR[]) {
          for (const s of op.statements) {
            // The single allowed site: an op-call that IS the whole value of a
            // `return` (tail passthrough).  Every other occurrence is rejected.
            const allowed =
              s.kind === "return" && isOperationSelfCall(s.value) ? s.value : undefined;
            eachStmtExpr(s, (e) => {
              if (e === allowed || !isOperationSelfCall(e)) return;
              diags.push({
                severity: "error",
                code: "loom.vanilla-op-call-position",
                message:
                  `operation '${ctxName}.${agg.name}.${op.name}' calls sibling operation ` +
                  `'${e.name}' outside 'return' tail position, which the elixir backend can't ` +
                  `lower — an operation compiles to a context function returning a tagged ` +
                  `{:ok,_}|{:error,_} tuple, so its result can only be passed through as the ` +
                  `whole 'return' value, not composed into a larger expression or bound with ` +
                  `'let'. Use a bare 'return ${e.name}(...)', or host this context on a backend ` +
                  `with full support (node / dotnet / python / java).`,
                source: `${sys.name}/${dep.name}`,
              });
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capability-filter support on the Hono and Phoenix backends (partial
// today).  A `filter <expr>` capability installs at the query layer on
// every read.  On .NET it rides EF Core's `HasQueryFilter` (global,
// DI-resolved) — no restriction.  Hono AND-s the predicate into each
// Drizzle read site; Phoenix AND-s it into each Ecto read.  Two cases are
// not yet wired on either and would otherwise emit silently-wrong query
// behaviour (a soft-delete / tenancy-isolation footgun), so reject them
// with a clear error instead:
//
//   1. Principal-referencing filters (`this.tenantId ==
//      currentUser.tenantId`).  Binding the request principal into the
//      always-on read path is deferred (Hono: thread through findById +
//      callers; Phoenix: an actor-bound Ecto `where:`) — see
//      docs/old/proposals/criterion-everywhere.md.
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

interface StampBackend {
  /** The `platformFamily` value this validator gates, and the literal used in
   *  the `(platform <x>)` diagnostic label. */
  family: string;
  /** The `loom.<x>-stamp-unsupported` diagnostic code. */
  code: string;
  /** The noun for the missing request principal.  Elixir says
   *  "principal (request actor)"; every other backend says "principal". */
  principalNoun: string;
}

// The per-backend stamp mechanisms differ (Java `_stampOnCreate` entity
// methods; .NET EF `AuditableInterceptor`; node Hono `_stampOnCreate`; python
// pre-persist; Elixir Ecto `put_change`), but the two UNSUPPORTED shapes are
// backend-independent facts about the model: a principal-referencing stamp on a
// deployable without auth (no request-scoped principal to thread), and a stamp
// on an event-sourced aggregate (state is folded from events, not
// field-stamped).  So the check is one shared body over a per-backend table —
// the diagnostics stay byte-identical, only the family label, code, and (for
// Elixir) the principal noun vary.
const STAMP_BACKENDS: readonly StampBackend[] = [
  { family: "java", code: "loom.java-stamp-unsupported", principalNoun: "principal" },
  { family: "dotnet", code: "loom.dotnet-stamp-unsupported", principalNoun: "principal" },
  { family: "node", code: "loom.node-stamp-unsupported", principalNoun: "principal" },
  { family: "python", code: "loom.python-stamp-unsupported", principalNoun: "principal" },
  {
    family: "elixir",
    code: "loom.elixir-stamp-unsupported",
    principalNoun: "principal (request actor)",
  },
];

function validateStampSupport(sys: SystemIR, diags: LoomDiagnostic[], backend: StampBackend): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== backend.family) continue;
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
              `Deployable '${dep.name}' (platform ${backend.family}) hosts aggregate '${ctxName}.${agg.name}' ` +
              `with a lifecycle stamp that references currentUser (e.g. \`createdBy := currentUser\` ` +
              `from \`with audit\`), but the deployable has no auth — there is no request-scoped ` +
              `${backend.principalNoun} to stamp from. Add 'auth: required' (and a system 'user {}' block), or use ` +
              `non-principal stamps (e.g. \`stamp onCreate { createdAt := now() }\`).`,
            source: `${sys.name}/${dep.name}`,
            code: backend.code,
          });
        }
        if (enriched.persistedAs === "eventLog") {
          diags.push({
            severity: "error",
            message:
              `Deployable '${dep.name}' (platform ${backend.family}) hosts event-sourced aggregate ` +
              `'${ctxName}.${agg.name}' with a lifecycle stamp — stamps mutate state fields, but an ` +
              `event-sourced aggregate's state is folded from its event stream. ` +
              `Record the timestamp in an event instead, or drop persistedAs(eventLog).`,
            source: `${sys.name}/${dep.name}`,
            code: backend.code,
          });
        }
      }
    }
  }
}

// Thin per-backend wrappers preserve the public surface + validate.ts call
// sites; each just picks its row from STAMP_BACKENDS.
export function validateJavaStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  validateStampSupport(sys, diags, STAMP_BACKENDS[0]);
}

export function validateDotnetStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  validateStampSupport(sys, diags, STAMP_BACKENDS[1]);
}

export function validateNodeStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  validateStampSupport(sys, diags, STAMP_BACKENDS[2]);
}

export function validatePythonStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  validateStampSupport(sys, diags, STAMP_BACKENDS[3]);
}

export function validateElixirStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  validateStampSupport(sys, diags, STAMP_BACKENDS[4]);
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
      // Nested part-in-part containments (single AND collection) now map on
      // java: a part FKs to its DIRECT parent (`directParentOf`, shared with
      // migrations-builder), so the `@OneToOne`/`@OneToMany` join column matches
      // the Flyway DDL and a collection nested below the root keeps its
      // hierarchy.  (Was: `loom.java-single-containment-unsupported`.)
    }
  }
}

// ---------------------------------------------------------------------------
// Java read-model backstop gates.  Cross-aggregate view `follows` and VO-typed
// read-model fields (workflow-instance / projection / view) are now emitted
// (java/emit/view.ts + the read-model VO records in java/emit/dto.ts).  What
// remains here is a defensive gate for an ENTITY (containment-part) read-model
// field: it would need a `<Part>Response` DTO the emitter doesn't build, but a
// part type never resolves in workflow / projection scope, so the gate is an
// unreachable backstop mirroring the emitters' `guardInstanceField` /
// `guardProjectionField` throws — kept so the shape fails honestly rather than
// crashing if that scope rule ever changes.
// ---------------------------------------------------------------------------

/** Peel optional / array wrappers to the leaf type kind — the emitters' own
 *  guard shape: `T?` → `T`, `T[]` → element, `T?[]` element-optional → `T`. */
function wireLeafKind(t: TypeIR): TypeIR["kind"] {
  const inner = t.kind === "optional" ? t.inner : t;
  const leaf =
    inner.kind === "array"
      ? inner.element.kind === "optional"
        ? inner.element.inner
        : inner.element
      : inner;
  return leaf.kind;
}

export function validateJavaReadModelShapes(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "java") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;

      // (1) Entity-typed saga instance-view field.  VO-typed fields now emit
      // (their `<Vo>Response` is co-located in application.workflows); an entity
      // (containment part) field would need a `<Part>Response` DTO — but a part
      // type never resolves in workflow scope, so this is a defensive backstop
      // for a shape the grammar/scope already forbids.  Only observable
      // workflows (those with an `instanceWireShape`) reach the instance emitter.
      for (const wf of ctx.workflows) {
        for (const f of wf.instanceWireShape ?? []) {
          if (wireLeafKind(f.type) !== "entity") continue;
          diags.push({
            severity: "error",
            message:
              `Deployable '${dep.name}' (platform java) hosts workflow '${ctxName}.${wf.name}' with ` +
              `instance-view field '${f.name}' of entity type — workflow-instance read models on the ` +
              `java backend do not yet emit a '<Part>Response' DTO. Drop the field from the observable ` +
              `state, or host it on a node / dotnet / python deployable.`,
            source: `${sys.name}/${dep.name}`,
            code: "loom.java-workflow-instance-field-unsupported",
          });
        }
      }

      // (2) Entity-typed projection row field — same defensive backstop as (1).
      for (const proj of ctx.projections) {
        for (const f of proj.wireShape ?? []) {
          if (wireLeafKind(f.type) !== "entity") continue;
          diags.push({
            severity: "error",
            message:
              `Deployable '${dep.name}' (platform java) hosts projection '${ctxName}.${proj.name}' with ` +
              `row field '${f.name}' of entity type — projection read models on the java backend do not ` +
              `yet emit a '<Part>Response' DTO. Drop the field, or host it on a node / dotnet / python ` +
              `deployable.`,
            source: `${sys.name}/${dep.name}`,
            code: "loom.java-projection-field-unsupported",
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Nested entity parts on an elixir aggregate.
//
// On a `shape(embedded)` aggregate, `contains <part>: <Part>[]` persists inline:
// the part becomes an Ecto `embedded_schema` module the root `embeds_many`s (one
// jsonb column — the same column the shared migration emits for the embedded
// shape), and a containment-mutating op (`items += Item{…}`) appends the struct
// + `put_embed`s it (DEBT-32).
//
// On a RELATIONAL aggregate the part is persisted as a child TABLE (§11c): the
// part schema is table-backed with a `belongs_to` to its owner, the root
// `has_many`s + `cast_assoc`s it, and reads `Repo.preload` it — matching the
// child-table the shared migration already emits.  In-operation mutation
// (`pipelines += Pipeline{…}` / `-=`) is now wired too: the persist tail
// `put_assoc`s the mutated part-struct list (the schema's `on_replace: :delete`
// rewrites the child rows) — see `persistPutBodies` (operation-returns-emit).
// ONE case still lacks an emit and stays gated:
//
//   - A part that itself declares `contains` (part-in-part nesting) — the
//     shared migration emits no child table for a part's own containments on a
//     relational owner, so there is no backing storage.
//
// Mirrors `validateJavaContainmentSupport` / `validateDapperSupport`.
// ---------------------------------------------------------------------------

export function validateVanillaContainmentSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        // A containment usage OR an entity-part declaration both signal nested
        // parts.  (Value objects are plain fields, not `contains`, so they're
        // unaffected.)
        if ((agg.contains ?? []).length === 0 && (agg.parts ?? []).length === 0) continue;
        const enriched = agg as EnrichedAggregateIR;
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        // `shape(embedded)` AND `shape(document)` (Route A) both fold containments
        // inline: the `<Agg>.Data` embedded schema `embeds_many`/`embeds_one`s each
        // part, the changeset `cast_embed`s them, and the wireShape serializer
        // projects them through the shared `serialize_<part>/1` camelCase helpers.
        // Both wired — allowed.
        if (shape === "embedded" || shape === "document") continue;
        // Relational (§11c): persisted as child tables — allowed, INCLUDING
        // in-operation mutation (`pipelines += Pipeline{…}` / `-=`).  The persist
        // tail `put_assoc`s the mutated part-struct list (the schema's
        // `on_replace: :delete` rewrites the child rows); see
        // `persistPutBodies` (operation-returns-emit) and `renderReturningStmt`'s
        // add/remove arms.  The ONE remaining not-yet-wired case is below.
        const nestedPart = (agg.parts ?? []).find((p) => (p.contains ?? []).length > 0);
        if (nestedPart) {
          diags.push({
            severity: "error",
            message:
              `Deployable '${dep.name}' (platform ${dep.platform}) hosts ` +
              `aggregate '${ctxName}.${agg.name}' whose entity part '${nestedPart.name}' itself ` +
              `declares 'contains' (part-in-part nesting) on a relational shape — the shared ` +
              `migration emits no child table for a part's own containments, so there is no backing ` +
              `storage. Add 'shape(embedded)' to the aggregate (the whole part graph folds into one ` +
              `jsonb column), flatten the nesting, or host this context on another backend.`,
            source: `${sys.name}/${dep.name}`,
            code: "loom.vanilla-containment-unsupported",
          });
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
  // `python` is included because it now emits the non-principal relational case
  // (W1a), the PRINCIPAL relational case (DEBT-02), AND both `embedded` cases
  // (DEBT-02 tail): `contextFilterPredicate` in
  // `src/generator/python/find-predicate.ts` AND-s them into every root read
  // (principal predicates render `current_user.<claim>` against the ambient
  // `require_current_user()` accessor).  Only the `document` shape stays gated —
  // `supportsNonRelationalFilter`/`supportsPrincipalNonRelationalFilter` admit
  // python for `embedded` but not `document` — so it must be in this set for the
  // per-case logic below to reject that one shape (and accept the relational +
  // embedded cases, principal or not).
  // .NET is included NOT because it has an unwired shape (EF `HasQueryFilter`
  // supports every case — the `supports*` predicates below all return true for
  // it) but so the PRINCIPAL-filter-needs-auth gate reaches it: a `currentUser`
  // filter compiles to `HasQueryFilter(... RequestContext.Current!.CurrentUser!
  // ...)`, which NREs on every read when the deployable has no auth.  Excluding
  // .NET here skipped that gate entirely (finding 20 / B16).
  const LIMITED_FAMILIES = new Set(["node", "elixir", "java", "python", "dotnet"]);
  // Backends that now wire PRINCIPAL-referencing filters (`currentUser.x`) on
  // relational aggregates — node/elixir/java/python all do.  python renders the
  // predicate against the ambient `require_current_user()` accessor (a
  // module-level `ContextVar[User | None]` set in the auth middleware) inside
  // every root read (the SQLAlchemy analogue of node's `requireCurrentUser()`).
  // node renders the
  // predicate against the ambient `requireCurrentUser()` accessor inside every
  // root read (the Drizzle analogue of .NET's `HasQueryFilter`).  elixir (plain
  // Ecto) AND-s the predicate into each read as `^(current_user &&
  // current_user.f)`.  **java** AND-s a SpEL-principal JPQL clause
  // (`:#{@currentUserAccessor.user()?.f()}`) into every find/retrieval/view +
  // the scoped `findAll`/`findById` overrides (the static `@SQLRestriction`
  // still carries the non-principal filters).
  const supportsPrincipalFilter = (family: string): boolean => {
    if (family === "node") return true;
    if (family === "elixir") return true;
    if (family === "java") return true;
    // .NET wires a principal relational filter via EF `HasQueryFilter`
    // (`RequestContext.Current!.CurrentUser!.<claim>`); it's in LIMITED_FAMILIES
    // only for the auth gate, so it must report as fully supported here.
    if (family === "dotnet") return true;
    // python (DEBT-02 last-backend parity): a principal capability filter on a
    // RELATIONAL aggregate renders `current_user.<claim>` against an ambient
    // ContextVar accessor (`require_current_user()`) AND-ed into every root read
    // — the SQLAlchemy analogue of node's `requireCurrentUser()` weave / .NET's
    // `HasQueryFilter`.  Non-relational (document/embedded) principal stays gated
    // (`supportsPrincipalNonRelationalFilter` omits python).
    if (family === "python") return true;
    return false;
  };
  // Backends that wire a NON-principal capability filter into a NON-relational
  // (document/embedded) aggregate.  node handles both shapes: a `document`
  // aggregate filters in-app over the rehydrated doc; an `embedded` aggregate's
  // root scalars are real columns, so the predicate AND-s into the SQL read like
  // the relational path.  java handles BOTH too: a `document` aggregate's store
  // filters every read in-app via `findAll().stream()`; an `embedded`
  // aggregate's root entity is a real JPA table whose root scalars are columns,
  // so the static non-principal predicate rides Hibernate's `@SQLRestriction`
  // exactly like the relational path (`emit/entity.ts`).  elixir handles
  // `embedded` (its only non-relational shape — `document` is unsupported there,
  // gated by `validateSavingShapeSupport`): an embedded aggregate's root
  // scalars are real columns, so the predicate AND-s into the Ecto read exactly
  // like the relational path.  **python** handles `embedded` too (DEBT-02 tail):
  // an embedded aggregate's root scalars are real columns, so
  // `contextFilterPredicate` AND-s into the embedded SQL reads exactly like the
  // relational path (`repository-embedded-builder.ts`).  **python also handles
  // `document`** now (DEBT-02 tail complete): the blob is one JSONB column, not
  // per-field queryable, so the predicate is evaluated IN-APP over the rehydrated
  // instance (`documentCapabilityBody` → a list-comprehension filter in
  // `repository-document-builder.ts`), mirroring node.  .NET handles all shapes
  // (it's not in LIMITED_FAMILIES).  A PRINCIPAL filter on a `document` shape is
  // wired on node/Java **and now python** (DEBT-02 Slice B — the actor binds into
  // the in-app predicate; see `supportsPrincipalNonRelationalFilter` below and the
  // `document-tenancy.ddd` ts-/java-/python-build fixtures); it stays gated only
  // for elixir (no `document` shape).
  const supportsNonRelationalFilter = (family: string, shp: string): boolean =>
    (family === "node" && (shp === "document" || shp === "embedded")) ||
    (family === "java" && (shp === "document" || shp === "embedded")) ||
    (family === "elixir" && shp === "embedded") ||
    (family === "python" && (shp === "document" || shp === "embedded")) ||
    // .NET (EF) filters every shape; in LIMITED_FAMILIES only for the auth gate.
    (family === "dotnet" && (shp === "document" || shp === "embedded"));
  // PRINCIPAL (`currentUser.x`) filter on a NON-relational shape (DEBT-02, the
  // actor + non-relational intersection).  An `embedded` aggregate's root
  // scalars are real columns, so node/elixir/java reuse their relational
  // principal path (node weaves `requireCurrentUser()` into the embedded SQL
  // read; elixir AND-s the `current_user` predicate into the embedded Ecto
  // read; java AND-s the SpEL-principal clause into the embedded scoped reads).
  // A `document` aggregate filters IN-APP over the rehydrated
  // doc, so a principal predicate there evaluates the actor in-app (Slice B):
  // node binds `requireCurrentUser()` into the in-app predicate; java injects
  // the `CurrentUserAccessor` bean and binds it before the `.stream().filter`;
  // **python** binds `current_user = require_current_user()` before its
  // list-comprehension filter (DEBT-02 tail complete).
  // **python** also wires the embedded principal case: the embedded
  // root scalars are real columns, so the `currentUser.<claim>` predicate renders
  // against the ambient `require_current_user()` accessor and AND-s into the
  // embedded SQL read like the relational principal path.  `document` stays off
  // only for elixir (no `document` shape).
  const supportsPrincipalNonRelationalFilter = (family: string, shp: string): boolean =>
    (shp === "embedded" &&
      (family === "node" ||
        family === "elixir" ||
        family === "java" ||
        family === "python" ||
        family === "dotnet")) ||
    (shp === "document" &&
      (family === "node" || family === "java" || family === "python" || family === "dotnet"));

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
        // Does THIS family wire a principal filter on THIS shape?  Relational →
        // `supportsPrincipalFilter`; non-relational → the `embedded`-only
        // `supportsPrincipalNonRelationalFilter`.
        const principalSupportedHere = nonRelational
          ? supportsPrincipalNonRelationalFilter(fam, shape)
          : supportsPrincipalFilter(fam);
        // The shape itself must be wired (any filter); then, if the filter is
        // principal-referencing, that intersection must be wired too.
        const nonRelationalUnsupported = nonRelational && !supportsNonRelationalFilter(fam, shape);
        const principalUnsupported = usesPrincipal && !principalSupportedHere;
        // A principal filter on a backend that DOES wire it (incl. embedded on
        // node/elixir/java) still needs a request principal to scope by — so the
        // deployable must enforce auth (and the system must declare a `user {}`
        // block).  Without it the ambient `requireCurrentUser()` accessor isn't
        // even emitted.  Mirror the `validateJavaStampSupport` precedent with a
        // clear, actionable error.
        if (
          usesPrincipal &&
          principalSupportedHere &&
          !nonRelationalUnsupported &&
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
        // A non-relational shape gates on the families that don't yet wire it
        // (DEBT-02); a principal filter gates where the actor intersection isn't
        // wired (relational: python; non-relational: document everywhere).
        if (!principalUnsupported && !nonRelationalUnsupported) continue;
        // The unwired shape is the harder limitation — report it first when both
        // apply.  Otherwise it's a principal filter on a shape whose actor
        // intersection isn't wired (a `document` aggregate filters in-app, so a
        // principal predicate there needs in-app actor evaluation — Slice B).
        const reason = nonRelationalUnsupported
          ? `is persisted as shape(${shape}); capability filters are only wired for ` +
            `relational aggregates on the ${fam} backend today`
          : nonRelational
            ? `references currentUser (e.g. a tenancy filter) on a shape(${shape}) aggregate; ` +
              `principal-referencing filters on ${shape} aggregates are not yet wired on the ` +
              `${fam} backend (they evaluate in-app, not as a column predicate)`
            : `references currentUser (e.g. a tenancy filter); principal-referencing capability ` +
              `filters are not yet wired on the ${fam} backend`;
        diags.push({
          severity: "error",
          message:
            `Deployable '${dep.name}' (platform ${dep.platform}) hosts aggregate ` +
            `'${ctxName}.${agg.name}' with a 'filter' capability predicate that ${reason}. ` +
            `Host this aggregate on a .NET deployable${
              nonRelationalUnsupported
                ? ""
                : " (or a node / elixir deployable, which wire tenancy filters)"
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
// `ignoring` filter-bypass support gate (named-filter-bypass.md §11).
//
// A read (repository `find`, `view`, or inline `Repo.findAll(...)`/`Repo.run`)
// may carry an `ignoring *` / `ignoring <Cap>, …` clause that bypasses a
// capability's query-filter(s).  Three fail-fast gates run over the FULLY-
// RESOLVED IR (the capability provenance lives on `agg.contextFilterOrigins`,
// Slice 0):
//
//   loom.filter-bypass-unknown-capability — `ignoring X` where the target
//       aggregate does NOT implement capability X (X ∉ agg.capabilities).
//   loom.filter-bypass-no-filter — X is implemented but contributes NO filter
//       (X ∉ agg.contextFilterOrigins), e.g. `ignoring auditable` (stamps-only).
//       `ignoring *` is a harmless no-op when the aggregate has zero capability
//       filters (only an EXPLICIT named cap errors) — bypassing "all of nothing"
//       is intent-neutral, whereas naming a specific cap that contributes no
//       filter is a likely authoring mistake.
//   loom.filter-bypass-unsupported — the read is served by a deployable whose
//       backend family is NOT in the supported set.  Honored by dotnet (EF
//       `IgnoreQueryFilters`), node (Drizzle), elixir (plain Ecto omits the
//       bypassed `where:`), java (§11.6 @SQLRestriction→bypassable @Filter triage,
//       disabled per-read via the Hibernate Session), and python (SQLAlchemy
//       has no global filter, so each read AND-s its predicates explicitly —
//       a bypassing find/view/inline-run simply OMITS the named conjunct).
//       Every honoring family is now in the set; the diagnostic only fires for
//       a backend with no DB read path (which never carries `ignoring`).
// ---------------------------------------------------------------------------

/** Backend families that honor an `ignoring` filter-bypass clause.  `dotnet`
 *  (EF `IgnoreQueryFilters`, Slice 1), `node` (Drizzle — omits the bypassed
 *  conjunct from the `and(...)` chain, Slice 2), `elixir` (plain Ecto omits the
 *  bypassed `where:`), and `java` (§11.6 hybrid — a bypassed capability leaves the
 *  always-on `@SQLRestriction` for a bypassable Hibernate named `@Filter`, which
 *  a bypassing read disables via `session.disableFilter`/`enableFilter`;
 *  principal filters omit the JPQL conjunct; document repos re-apply promoted
 *  caps per-find), and `python` (SQLAlchemy has no global filter, so each read
 *  AND-s its capability predicates explicitly via `contextFilterPredicate`; a
 *  bypassing find/view omits the named conjunct statically, and a shared
 *  `run_<retrieval>` omits the union of its inline call-sites' bypasses) all
 *  honor it. */
const FILTER_BYPASS_FAMILIES = new Set(["dotnet", "node", "elixir", "java", "python"]);

/** Whether `dep`'s backend honors `ignoring` filter-bypass.  A backend must
 *  not pass this gate while still silently filtering — a family is supported
 *  only once its emitter actually OMITS the bypassed predicate.  Elixir (plain
 *  Ecto) omits the bypassed `where:` on the reads that `ignoring` it. */
function bypassSupported(dep: { platform: string }): boolean {
  const fam = platformFamily(dep.platform);
  if (!fam) return false;
  return FILTER_BYPASS_FAMILIES.has(fam);
}

/** A read carrying an `ignoring` clause, plus the aggregate it targets and a
 *  human-readable site label for diagnostics. */
interface BypassRead {
  bypassAll?: boolean;
  bypassCaps?: string[];
  aggName: string;
  site: string;
}

/** Recursively collect inline `Repo.findAll(...)`/`Repo.run(...)` reads that
 *  carry an `ignoring` clause from a workflow-statement body (descends into
 *  `for-each` + `if-let` bodies). */
function collectBypassRepoRuns(
  stmts: readonly WorkflowStmtIR[],
  wfName: string,
  out: BypassRead[],
): void {
  for (const s of stmts) {
    if (s.kind === "repo-run" && (s.bypassAll || (s.bypassCaps?.length ?? 0) > 0)) {
      out.push({
        bypassAll: s.bypassAll,
        bypassCaps: s.bypassCaps,
        aggName: s.aggName,
        site: `workflow '${wfName}' inline read '${s.name}'`,
      });
    }
    if (s.kind === "for-each") collectBypassRepoRuns(s.body, wfName, out);
    if (s.kind === "if-let") {
      collectBypassRepoRuns(s.thenBody, wfName, out);
      collectBypassRepoRuns(s.elseBody ?? [], wfName, out);
    }
  }
}

/** Every `ignoring`-bearing read in a context, paired with its target
 *  aggregate: repository finds, views over an aggregate source, and inline
 *  repo-runs in workflow bodies. */
function bypassReadsInContext(ctx: BoundedContextIR): BypassRead[] {
  const out: BypassRead[] = [];
  for (const repo of ctx.repositories) {
    for (const f of repo.finds) {
      if (f.bypassAll || (f.bypassCaps?.length ?? 0) > 0) {
        out.push({
          bypassAll: f.bypassAll,
          bypassCaps: f.bypassCaps,
          aggName: repo.aggregateName,
          site: `find '${repo.name}.${f.name}'`,
        });
      }
    }
  }
  for (const v of ctx.views) {
    if ((v.bypassAll || (v.bypassCaps?.length ?? 0) > 0) && v.source.kind === "aggregate") {
      out.push({
        bypassAll: v.bypassAll,
        bypassCaps: v.bypassCaps,
        aggName: v.source.name,
        site: `view '${v.name}'`,
      });
    }
  }
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) collectBypassRepoRuns(c.statements, wf.name, out);
    for (const h of wf.handlers ?? []) collectBypassRepoRuns(h.statements, wf.name, out);
    for (const on of wf.subscriptions ?? []) collectBypassRepoRuns(on.statements, wf.name, out);
  }
  return out;
}

/** Capitalize the first letter of a diagnostic site label (sentence-start). */
function capitalizeSite(s: string): string {
  return s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

export function validateFilterBypassSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    // Only backend deployables serve reads; a frontend (react/static/vue/…)
    // owns no repository/view read path, so it can't bypass a filter.
    if (!fam || !platformOwnsBackend(dep.platform)) continue;
    const supported = bypassSupported(dep);
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      const aggByName = new Map<string, AggregateIR>();
      for (const a of ctx.aggregates) aggByName.set(a.name, a);
      for (const read of bypassReadsInContext(ctx)) {
        const agg = aggByName.get(read.aggName);
        const caps = new Set(agg?.capabilities ?? []);
        const filterOrigins = new Set(
          (agg?.contextFilterOrigins ?? []).filter((o): o is string => o != null),
        );
        // 1. Unsupported backend — gate FIRST so an `ignoring` read on a
        //    non-dotnet backend always fails (regardless of cap validity).
        if (!supported) {
          diags.push({
            severity: "error",
            code: "loom.filter-bypass-unsupported",
            message:
              `Deployable '${dep.name}' (platform ${dep.platform}) serves ${read.site} on ` +
              `aggregate '${ctxName}.${read.aggName}' with an 'ignoring' filter-bypass clause, but ` +
              `this backend does not honor capability-filter bypass yet — the honoring backends are ` +
              `dotnet (EF 'IgnoreQueryFilters'), node (Drizzle), and elixir (Ecto). Host this read ` +
              `on a supported backend, or remove the 'ignoring' clause.`,
            source: `${sys.name}/${dep.name}`,
          });
          continue;
        }
        // 2. Per named capability: must be implemented AND contribute a filter.
        //    `ignoring *` skips both checks (it's keyed on nothing specific).
        for (const cap of read.bypassCaps ?? []) {
          if (!caps.has(cap)) {
            diags.push({
              severity: "error",
              code: "loom.filter-bypass-unknown-capability",
              message:
                `${capitalizeSite(read.site)} on aggregate '${ctxName}.${read.aggName}' ignores ` +
                `capability '${cap}', but that aggregate does not implement '${cap}'. Implement it ` +
                `(with ${cap} / implements ${cap}) or correct the capability name in the 'ignoring' clause.`,
              source: `${sys.name}/${dep.name}`,
            });
            continue;
          }
          if (!filterOrigins.has(cap)) {
            diags.push({
              severity: "error",
              code: "loom.filter-bypass-no-filter",
              message:
                `${capitalizeSite(read.site)} on aggregate '${ctxName}.${read.aggName}' ignores ` +
                `capability '${cap}', but '${cap}' contributes no query-filter to bypass (it is a ` +
                `stamps-only / fields-only capability). Remove '${cap}' from the 'ignoring' clause.`,
              source: `${sys.name}/${dep.name}`,
            });
          }
        }
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
      // `seed` data is now supported — the Dapper seeder (Seed.cs) frames the
      // marker table / raw inserts on Npgsql+Dapper while reusing the
      // persistence-agnostic domain-`Create` path (I<Agg>Repository.SaveAsync).
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
        //
        // Nested entity parts (`contains lineItems: LineItem[]`) are supported
        // for STATE aggregates whose parts are FLAT: one child table per
        // containment (`id` PK + `<agg>_id` FK + the part's scalar/enum/vo/id
        // columns), bulk-loaded on every read and hydrated through the root's
        // `_Create(State)` seam, full-list-replaced on save, and cascade-deleted.
        // Still gated (v1 scope): a part-in-part (a part with its OWN
        // containments), a reference-collection field on a part, and any
        // containment on an EVENT-SOURCED aggregate (its stream folds children
        // in-memory — no child table).
        const contains = a.contains ?? [];
        if (contains.length > 0) {
          if (a.persistedAs === "eventLog") {
            reject(where, "has nested entity parts on an event-sourced aggregate");
          } else if ((a.associations ?? []).length > 0) {
            // The Dapper repository's containment hydration reconstructs each
            // root through `_Create(State)`; the reference-collection load
            // post-sets a writable list.  v1 keeps these two hydrate paths
            // mutually exclusive (combining them is a follow-up slice).
            reject(where, "combines nested entity parts with reference-collection associations");
          } else {
            for (const part of a.parts ?? []) {
              if ((part.contains ?? []).length > 0)
                reject(where, `contains a nested part-in-part ('${part.name}' has its own parts)`);
              for (const pf of part.fields) {
                const pt = pf.type.kind === "optional" ? pf.type.inner : pf.type;
                if (pt.kind === "array")
                  reject(where, `contains a part ('${part.name}') with a collection field`);
              }
            }
          }
        }
        // Lifecycle stamping is supported (onUpdate mutates the aggregate
        // pre-save; onCreate binds INSERT-only parameters excluded from the
        // upsert SET), INCLUDING principal-referencing stamp values — the
        // Dapper repository reaches the request principal through the ambient
        // `RequestContext.Current!.CurrentUser!` accessor (a bare `currentUser`
        // → the principal id, `currentUser.<claim>` → the claim), exactly as
        // the EF AuditableInterceptor.  A principal stamp on a no-auth
        // deployable stays rejected by the category-A loom.dotnet-stamp-unsupported.
        // Capability filters are supported too (spliced into every SELECT's
        // WHERE); a principal-referencing one lowers `currentUser.<claim>` to a
        // `@__cu_<claim>` Dapper param bound from the same ambient principal.
        // Access modifiers (`managed` / `token` / `internal` / `secret`) are
        // wire-projection concerns handled by the shared Domain/CQRS layers
        // (create-input shaping, `forApiRead` response stripping) — the Dapper
        // column round-trips like any other field, so no gate.  Provenanced
        // fields are supported too: the co-located `<field>_provenance` jsonb
        // column round-trips the ProvLineage (ProvJson.Options) and the Dapper
        // SaveAsync flushes the drained lineage into the `provenance_records`
        // history table (DbSchema owns its DDL) — the raw-Npgsql mirror of the
        // EF value-converter + ProvenanceRecord flush.
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
//
// Persist-time audit stamping IS supported (node-persist-time-auditing): the
// MikroORM `save()` injects the audit columns into `em.upsert(...)` from the
// ambient request principal (`stampInsert`, db/audit-stamp.ts), keeping
// createdAt/createdBy immutable on conflict via `onConflictExcludeFields`.
//
// Server-managed access (`managed` / `token` / `internal` / `secret`) is NO
// LONGER gated either: the data-mapper stores such a field as an ordinary
// column that round-trips through the shared save/hydrate seams (the access
// modifier shapes only the API wire surface).  Provenanced fields stay gated.
// ---------------------------------------------------------------------------
export function validateMikroOrmSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

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
      // Context `retrieval` query bundles ARE supported (DEBT-17): emitted as
      // `run<Name>` methods, the MikroORM analogue of the drizzle `runMethod`.
      // A retrieval whose `where` falls outside the MikroORM FilterQuery subset
      // emits a runtime-throwing stub at codegen (same as a find predicate), so
      // there's no validate-time gate here — mirrors the .NET Dapper v1 path.
      // `seed` data IS supported: `emitMikroSeeds` threads the same dataset
      // functions (domain `create` → `<Agg>Repository.save`) through the
      // EntityManager, with raw INSERTs + the `__loom_seed` marker via
      // `em.getConnection().execute`.  The mikro seed CLI inits the ORM +
      // `updateSchema()` before running; the boot path runs it after schema
      // update — so no gate here.
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // Event sourcing IS supported on this adapter (appliers): the
        // `<agg>_events` stream + fold reuse the persistence-agnostic
        // domain/CQRS layer.  An event-sourced aggregate has no state table,
        // so the `shape(...)` axis is moot — skip that check for it.
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        // `shape(embedded)` IS supported (wave 2): the root stays queryable
        // columns and each containment folds into a jsonb column, (de)serialised
        // through the shared `<part>ToDoc`/`<part>FromDoc` helpers (the MikroORM
        // analogue of the drizzle embedded repository).  Bounded to aggregates
        // with no `Id[]` reference collections.  `shape(document)` (the whole
        // aggregate as one opaque blob) stays gated.
        if (a.persistedAs !== "eventLog" && shape !== "relational") {
          if (shape === "embedded") {
            if ((a.associations ?? []).length > 0)
              reject(where, "is shape(embedded) with `Id[]` reference collections");
          } else {
            reject(where, `is persisted as shape(${shape})`);
          }
        }
        // Aggregate inheritance IS supported (aggregate-inheritance.md): TPH
        // (`sharedTable`) maps the hierarchy to one shared Row discriminated by
        // `kind` — concrete repos read/write it scoped to their `kind`, a
        // polymorphic `<Base>Repository` dispatches on it; TPC (`ownTable`)
        // gives each concrete its own table with a delegating base reader.
        // Both mirror the drizzle inheritance slice.
        // `Id[]` reference-collection associations ARE supported on a state
        // aggregate: each persists as a composite-PK pivot Row entity, bulk-
        // loaded on read and full-list-replaced on save (the MikroORM analogue
        // of the drizzle join table).  Event-sourced aggregates reconstruct
        // from their event stream (no pivot sync), so associations there stay
        // gated until that path is wired.
        if ((a.associations ?? []).length > 0 && a.persistedAs === "eventLog")
          reject(where, "has reference-collection associations on an event-sourced aggregate");
        // Contained entity parts ARE supported (relational child tables, wave 2):
        // each part persists as a parent-scoped `<Part>Row` child table, bulk-
        // loaded on read and diff-synced on save (the MikroORM analogue of the
        // drizzle containment path).  Bounded to single-level FLAT parts (no
        // part-of-a-part, no collection field inside a part) on a plain state
        // aggregate — deeper nesting / inheritance / event-sourcing stay gated.
        // Contained parts (relational child tables OR embedded jsonb) are v1-
        // bounded to single-level FLAT parts (no part-of-a-part, no collection
        // field inside a part), on a non-inheritance / non-event-sourced state
        // aggregate.  Both shapes share the bound.
        if ((a.parts ?? []).length > 0 || (a.contains ?? []).length > 0) {
          const flatType = (t: TypeIR): boolean =>
            (t.kind === "optional" ? t.inner : t).kind !== "array";
          const partFlat = (p: EntityPartIR): boolean =>
            (p.contains ?? []).length === 0 && p.fields.every((f) => flatType(f.type));
          if (a.persistedAs === "eventLog")
            reject(where, "contains nested entity parts on an event-sourced aggregate");
          else if (a.isAbstract || a.extendsAggregate)
            reject(where, "contains nested entity parts on an aggregate-inheritance participant");
          else if (!(a.parts ?? []).every(partFlat))
            reject(
              where,
              "contains a nested or collection-bearing entity part (v1 supports single-level flat parts)",
            );
        }
        // `filter` capability predicates ARE supported: the repository ANDs each
        // non-principal predicate (a MikroORM FilterQuery) into every root read
        // via `$and`, honoring a read's `ignoring` bypass (the FilterQuery
        // analogue of drizzle's per-read predicate).  A predicate outside the
        // FilterQuery subset is caught by `validateFindPredicateAdapterSupport`
        // (which already iterates contextFilters), and principal-referencing
        // filters are rejected on Hono by `validatePrincipalContextFilterSupport`
        // — so only closed, lowerable predicates reach codegen.
        // Server-managed access (`managed` / `token` / `internal` / `secret`)
        // is NO LONGER gated: like drizzle, the MikroORM data-mapper stores such
        // a field as an ordinary column that round-trips through the shared
        // save-projection / hydrate seams (the access modifier only shapes the
        // API wire surface, not persistence).  Audit-stamp targets are filled by
        // the persist-time stamp (`stampInsert` in `em.upsert`) and the default-
        // on `version` token by the guarded version-CAS `nativeUpdate` — both
        // already supported.
        for (const f of a.fields) {
          if (f.provenanced) reject(`field '${agg.name}.${f.name}'`, "is provenanced");
        }
        // Per-operation / lifecycle `audited` writes a `provenance_records`-style
        // history row inside the route's save transaction via the SHARED
        // (drizzle-shaped) routes-builder — `db.transaction(...tx.insert(
        // schema.auditRecords)...)`.  On mikroorm `db` is the EntityManager (no
        // drizzle `.transaction`, no `schema` module), so that handler doesn't
        // compile.  Porting the transactional flush to the EntityManager API is
        // the same seam that gates provenanced fields (provenance-flush port,
        // deferred wave-2 follow-up); until then, fail fast rather than emit a
        // non-compiling handler.  NOTE: persist-time audit STAMPING (`auditable`
        // / `with audit` → `stampInsert` in `em.upsert`) is unaffected and stays
        // supported — this only gates the per-op/lifecycle `audited` FLAG.
        const auditedOps = a.operations.filter((o) => o.audited).map((o) => o.name);
        if (auditedOps.length > 0)
          reject(where, `has 'audited' operation(s) ${auditedOps.join(", ")}`);
        const auditedLifecycle = [...(a.creates ?? []), ...(a.destroys ?? [])].some(
          (o) => o.audited,
        );
        if (auditedLifecycle) reject(where, "has an 'audited' create/destroy lifecycle action");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-persistence-adapter find-predicate capability gate (Bucket V / P0).
//
// Every relational adapter lowers a `find` / `filter` / retrieval / view
// predicate to SQL, but each lowers a DIFFERENT subset of the queryable
// expression sublanguage.  A predicate that passes the general queryable
// check (`firstNonQueryableNode`) can still fall outside the SELECTED
// adapter's narrower subset, and the generator then throws at codegen
// (MikroORM `whereToMikroFilter`, Dapper `whereToSql`) or emits a runtime-
// broken TODO stub (Drizzle's null fallback).  This gate fails fast instead,
// keyed off the deployable's explicit `persistence:` selector.
//
// EF Core / Drizzle lower the full queryable subset, so only an explicit
// `persistence: dapper` / `persistence: mikroorm` narrows anything — the
// gate is silent for the (full-subset) defaults, matching the Dapper /
// MikroORM capability gates above.  The per-adapter narrowing lives in the
// platform-neutral descriptor `src/ir/util/find-predicate-capability.ts`
// (ir/validate may not import generator/, so the subset table lives here).
// ---------------------------------------------------------------------------
export function validateFindPredicateAdapterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    const adapter = dep.persistence;
    if (!adapter || !isFindPredicateAdapter(adapter)) continue;
    const report = (subject: string, label: string): void => {
      diags.push({
        severity: "error",
        message:
          `Deployable '${dep.name}' selects 'persistence: ${adapter}', but ${subject} uses ` +
          `a predicate the ${adapter} adapter cannot lower to SQL: ${label}. ` +
          `The ${adapter} find-predicate subset is narrower than EF Core's — ` +
          `use 'persistence: efcore'/'drizzle', or restructure the predicate.`,
        source: `${sys.name}/${dep.name}`,
        code: "loom.find-predicate-unsupported",
      });
    };
    const check = (predicate: ExprIR | undefined, subject: string): void => {
      if (!predicate) return;
      const label = firstUnlowerableForAdapter(predicate, adapter);
      if (label) report(subject, label);
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const repo of ctx.repositories) {
        for (const find of repo.finds) {
          check(find.filter, `repository '${repo.name}' find '${find.name}'`);
        }
      }
      for (const r of ctx.retrievals) {
        check(r.where, `retrieval '${r.name}'`);
      }
      for (const v of ctx.views) {
        check(v.filter, `view '${v.name}'`);
      }
      // Capability `filter` predicates also lower into every SELECT.  The
      // Dapper / MikroORM capability gates already handle principal-
      // referencing ones (and MikroORM rejects ALL capability filters), so
      // only the non-principal predicates can reach a relational SELECT here.
      for (const agg of ctx.aggregates) {
        const filters = (agg as EnrichedAggregateIR).contextFilters ?? [];
        for (const predicate of filters) {
          if (exprUsesCurrentUser(predicate)) continue;
          check(predicate, `a 'filter' capability predicate on aggregate '${agg.name}'`);
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
      message: `${label}: \`index:\` needs a relational table to sit on, so it is only valid on a \`kind: state\` binding (this is \`kind: ${r.kind}\`).`,
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
        message: `${label}: \`index:\` targets '${spec.entity}', which is not an aggregate or contained part in context '${r.contextName}'.`,
        source: `${sys.name}/${label}`,
      });
      continue;
    }
    for (const col of spec.columns) {
      if (!fields.has(col)) {
        diags.push({
          severity: "error",
          code: "loom.resource-index-unknown-column",
          message: `${label}: \`index:\` references '${spec.entity}.${col}', but '${col}' is not a field on '${spec.entity}'.`,
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
//   - `schema`       — EF Core ToTable, Drizzle pgSchema, Ecto schema prefix
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
// Phoenix `Repo.transaction` opts when a workflow in the context is
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
// `HasDiscriminator`), and Phoenix (plain Ecto shared table + a `kind`
// discriminator column). So a TPH hierarchy is allowed iff its context is
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
  // (EF Core native `HasDiscriminator`), Phoenix (plain Ecto shared table + a
  // `kind` discriminator column), Python (SQLAlchemy) and Java (Hibernate).
  const TPH_CAPABLE = new Set(["node", "dotnet", "elixir", "python", "java"]);
  const tphList = [...TPH_CAPABLE].sort().join(", ");
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
        : `no TPH-capable (${tphList}) backend deployable hosts this context`;
    diags.push({
      severity: "error",
      code: "loom.tph-backend-unsupported",
      message:
        `aggregate '${agg.name}' (${role}) resolves to sharedTable (TPH) inheritance via ` +
        `${how}, but TPH storage emission is implemented for the ${tphList} backends only — ` +
        `${hostNote}. Host the context on one of those deployables, or declare ` +
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
// Phoenix (plain Ecto/Phoenix) hosts pure ES via the per-aggregate stream +
// fold-on-load data layer (D-VANILLA-ES-HOME), so elixir is ES-capable.
const EVENT_SOURCING_BACKENDS = new Set(["node", "dotnet", "python", "java", "elixir"]);

export function validateEventSourcedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Every hosting backend must implement event sourcing; flag any that don't.
  const unsupported = [...backendPlatforms].filter((p) => !EVENT_SOURCING_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    if (anyBackend && unsupported.length === 0) continue;
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where event-sourced persistence is not implemented`
        : "no event-sourcing-capable (node / dotnet / java / python / elixir) backend deployable hosts this context";
    diags.push({
      severity: "error",
      code: "loom.event-sourcing-backend-unsupported",
      message:
        `aggregate '${agg.name}' is persistedAs(eventLog), but event-sourced storage emission ` +
        `is implemented for the Hono (node), .NET (dotnet), Java (java), Python (python) and elixir ` +
        `backends — ${hostNote}. Host the context on a supported deployable, or drop ` +
        `persistedAs(eventLog) to use state persistence (all backends). ` +
        `Tracked in workflow-and-applier.md (appliers A2).`,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced *workflow* storage gate (workflow-and-applier.md A2-S5b).  A
// `workflow X eventSourced { … apply(…) }` folds its own emitted events into
// state via appliers — the saga analogue of a `persistedAs(eventLog)`
// aggregate (emit-only handlers + pure `apply` folds, no mutable state table).
// The surface (grammar → `WorkflowIR.eventSourced` / `.appliers`) and the
// emit-only / pure-fold discipline (A1) have landed, and the **node, .NET,
// Python, Java, and elixir backends all emit the event-sourced workflow
// runtime** (per-correlation `<wf>_events` stream, fold-on-load,
// emit→append-own-event dispatch).  A backend that doesn't keeps an
// `eventSourced` workflow gated — otherwise it silently misgenerates as a
// state-based saga (the saga emitters key off `correlationField` alone, emit a
// mutable `<Wf>State` row + dispatcher, and drop the appliers entirely).  A
// parsed-but-unemitted feature is a footgun, so it fails fast — exactly like the
// event-sourced *aggregate* storage gate.
const EVENT_SOURCING_WORKFLOW_BACKENDS = new Set(["node", "dotnet", "python", "java", "elixir"]);
export function validateEventSourcedWorkflowStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !EVENT_SOURCING_WORKFLOW_BACKENDS.has(p));
  if (unsupported.length === 0) return;
  const hosts = unsupported.sort().join(", ");
  for (const wf of ctx.workflows) {
    if (!wf.eventSourced) continue;
    diags.push({
      severity: "error",
      code: "loom.event-sourced-workflow-unsupported",
      message:
        `workflow '${wf.name}' is eventSourced, but event-sourced workflow storage ` +
        `(a per-correlation event stream folded through its apply(...) blocks) is ` +
        `implemented on the Hono (node), .NET (dotnet), Python (FastAPI), Java (Spring) ` +
        `and elixir backends — this context is also hosted by ${hosts}. Host ` +
        `the context on a supported deployable, drop the eventSourced modifier ` +
        `to use a state-based saga (a persisted correlation-state row, supported on ` +
        `node / dotnet / java / python / elixir), or move the event-fold logic ` +
        `into an event-sourced aggregate (persistedAs(eventLog)). ` +
        `Tracked in workflow-and-applier.md (A2-S5b).`,
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// the Hono (`node`), .NET (`dotnet`), Java (`java`), Python (`python`) and
// elixir backends — the lineage SDK + co-located `<field>_provenance` column +
// the `provenance_records` flush.  On a backend that doesn't (e.g. react) a
// `provenanced` field silently behaves like a plain field, dropping the audit
// trail it promises — an error, not a silent no-op.  Mirrors the event-sourcing
// storage gate (a parsed-but-unemitted feature is a footgun, so it fails fast).
const PROVENANCE_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);
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
        : "no provenance-capable (node / dotnet / java / python / elixir) backend deployable hosts this context";
    const names = provFields.map((f) => f.name).join(", ");
    diags.push({
      severity: "error",
      code: "loom.provenanced-backend-unsupported",
      message:
        `aggregate '${agg.name}' has provenanced field(s) ${names}, but the provenance runtime ` +
        `(trace capture + history) is emitted for the Hono (node), .NET (dotnet), Java (java), ` +
        `Python (python) and elixir backends only — ${hostNote}. Host ` +
        `the context on a node / dotnet / java / python / elixir deployable, or drop the 'provenanced' ` +
        `modifier to use a plain field (all backends). Tracked in provenance.md / ` +
        `type-system-feature-migration.md (DBT-1).`,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Per-operation audit-record emission (`operation … audited`) is implemented for
// the Hono (`node`), .NET (`dotnet`), Java (`java`), Python (`python`) and
// elixir-VANILLA backends — an audited public route / command handler / service
// method appends a who/what/when + before/after snapshot to the audit sink in
// the operation's save transaction.  Audited LIFECYCLE actions
// (`audited create` / `destroy`) ship on the same set — the create/destroy
// handlers stage the audit row (before:null/after=wire on create;
// before=wire/after:null on destroy) in the lifecycle transaction.  Hosting an
// `audited` action on a backend that doesn't emit the runtime would silently
// record nothing — that mismatch is an error, not a silent no-op.  (This gates
// the per-operation `audited` flag only; the `with audit` capability macro emits
// stamping rules via `contextStamps`, a separate concern.)
const AUDIT_OP_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);
const AUDIT_LIFECYCLE_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);
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
  const capableLabel = "Hono (node) / .NET (dotnet) / Java (java) / Python (python) / elixir";
  for (const agg of ctx.aggregates) {
    const auditedOps = agg.operations.filter((o) => o.audited);
    if (auditedOps.length > 0 && (!anyBackend || opUnsupported.length > 0)) {
      push(
        agg,
        "operation",
        auditedOps.map((o) => o.name),
        opUnsupported,
        capableLabel,
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
        capableLabel,
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
