// AUTHORIZATION-GATE CENSUS (M-T9.28 slice 2) — every emitted gate has a
// caller that must be REFUSED, or a reasoned pin.
//
// Slice 1 (#2515) gave the behavioural tier a SECOND identity
// (`DEV_CLAIMS_UNAUTHORIZED` / `oidc.unauthorizedToken`), because until then the
// tier held exactly one, and the only authorization statement one identity can
// make is "the satisfying principal gets through" — which a `requires` emitted
// as a NO-OP passes identically.  That is not hypothetical: #2446 shipped a
// guarded `create` on an OPEN route with every gate green, because every gate
// was blind in the same direction.
//
// Slice 2 is the census the negative direction demands.  `api-caller-census`
// asks "is every derived route ever CALLED"; this asks the strictly harder
// question one layer in: **for every authorization gate the pipeline emits, is
// there a caller anywhere that must be DENIED?**  An authz test that only ever
// asserts the allowed case cannot distinguish an enforced gate from an absent
// one, so a census over the ALLOWED side alone is exactly the instrument that
// cannot fail.
//
// ── WHAT COUNTS AS A GATE ───────────────────────────────────────────────────
// The four authorization surfaces `docs/auth.md` defines, read off the enriched
// IR (never re-derived, never grepped from source):
//
//   requires  — the in-handler / read-header 403 gate.  Per surface:
//               `operationGates` for an operation, `lifecycleGates` for the
//               canonical create/destroy, `FindIR.requires`, a projection
//               header's `query.requires`, `RepositoryIR.historyFind.requires`,
//               `WorkflowIR.instanceReadGate`, and a `requires` statement in a
//               workflow command entry or a route-bound explicit handler.
//   policy    — an `authz-filter` sentinel (`policy { allow deep|global / deny
//               [write] }`) in the aggregate's read `contextFilters` or its
//               `writeScopeFilter`.
//   mask      — a `maskUnless` predicate on a field the surface RETURNS.
//   tenancy   — a PRINCIPAL-referencing capability filter (the `tenantOwned`
//               tenant floor, a registry self-scope) on the read or write seam.
//
// ── HOW THE POPULATION IS ENUMERATED ────────────────────────────────────────
// By UNIONING `deriveContextOperations` with the six route classes
// `apiSurfaceCoverage.notLifted` names (`prepare`, `workflow`,
// `workflowInstances`, `explicitHandler`, `projectionQuery`, `history`).  The
// union is the REQUIREMENT, not an optimisation: a census built on the
// derivation alone under-counts exactly the surfaces #2446 shipped ungated, and
// two of the gate sites `read-gates.ddd` exists for (a folded projection's
// header gate and a query-time projection's) live in the not-lifted half — the
// derivation cannot see either.  The not-lifted classes are enumerated the way
// `validateDefaultDeny` (`src/ir/validate/checks/system-checks.ts`) enumerates
// them, which is the one place in `src/` that already walks all eight.
//
// (The M-T3.15-era note that `validateDefaultDeny` misses classes is STALE on
// this head — re-checked at the source: it walks aggregate actions, workflow
// command entries, finds, history, projections, workflow instance reads and
// route-bound command/query handlers.  This file mirrors that walk rather than
// inventing a ninth answer.)
//
// ── HOW REFUSAL IS PROVEN ───────────────────────────────────────────────────
// By an `AUTHZ_LADDERS` entry (`test/behavioral/cases.mjs`) whose `gated` probe
// addresses the surface's own route and whose `unauthorized` / `anonymous` arm
// expects a REFUSAL status.  Not by a string in a `.ddd`, and not by this file
// re-deciding what "denied" means: the ladder is what the five behavioural legs
// actually DRIVE, so a refusal on record here is a refusal five booted backends
// answer.  Everything else is an explicit pin with a reason
// (`authz-gate-census-pins.ts`), and the gate compares the two sets EXACTLY, so
// it fails when
//   (1) a NEW gated surface has no refusal arm and no pin, and
//   (2) a pin goes STALE — the surface gained an arm, or was renamed/removed —
//       which forces a drain to delete its pin in the same change.
//
// Pure parse → lower → enrich.  No boot, no docker: it belongs in the fast
// suite, and it answers a question no booted gate asks of itself.
//
// Honest exemptions REUSE `E2E_LESS_CORPUS_FIXTURES` — the register M-T9.13
// already keeps of corpus fixtures with no `test e2e` block at all.  A fixture
// nothing drives at runtime cannot have a refused caller by construction, and
// minting a second exemption list beside that one is how two registers start
// disagreeing about the same fixture.
//
// Mutation-proven twice, at the foot of this file and in the behavioural tier:
//   • the LADDER proof (the one the packet requires): a no-op `requires` in the
//     canonical create — the #2446 defect, re-seeded in the Hono create-route
//     emitter — leaves `corpus/lifecycle-guard`'s `test e2e` GREEN and fails
//     the ladder arm this change added, by name.  Recorded in the pins file.
//   • the CENSUS proof: the last describe block seeds an inline `.ddd` whose
//     gated operation has no ladder, asserts the gate names it, then supplies a
//     refusing ladder and asserts it goes green — plus both stale-pin arms.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverSourcedDefaultFields } from "../../src/generator/_frontend/server-default.js";
import { createInputFields, emitsRestCreate } from "../../src/ir/enrich/wire-projection.js";
import {
  type AggregateIR,
  type BoundedContextIR,
  type ExprIR,
  exprUsesCurrentUser,
  type LoomModel,
  type ProjectionIR,
  type RepositoryIR,
  type SystemIR,
  type WorkflowIR,
} from "../../src/ir/types/loom-ir.js";
import { aggregateSegment, deriveContextOperations } from "../../src/ir/util/api-surface.js";
import { lifecycleGates, operationGates } from "../../src/ir/util/op-gates.js";
import { platformFor } from "../../src/platform/registry.js";
import { API_BASE_PATH } from "../../src/util/api-base.js";
import { snake } from "../../src/util/naming.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { corpusSource } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import { E2E_LESS_CORPUS_FIXTURES } from "./api-caller-census-pins.js";
import {
  AUTHZ_GATE_PINS,
  NON_PARSING_SOURCES,
  PIN_CLASS_CENSUS,
  R,
} from "./authz-gate-census-pins.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Parse → lower → enrich, memoised on the source text.  Four of this file's
 *  gates ask the same ~87 sources the same question, and this runs in the FAST
 *  suite: without the memo the population is lowered four times over for no
 *  extra claim.  Keyed on the source, not the case key, so a memo hit is
 *  byte-identical input by construction. */
const MODELS = new Map<string, Promise<LoomModel>>();
function modelOf(source: string): Promise<LoomModel> {
  const hit = MODELS.get(source);
  if (hit) return hit;
  const built = buildLoomModel(source);
  MODELS.set(source, built);
  return built;
}

/** The ladder map, read from the behavioural harness — the SAME object the five
 *  runners hand to `__authzLadder`, so this census cannot credit an arm no
 *  runner drives.  `cases.mjs` pulls in `esbuild`/`pg` at module scope, which
 *  the fast suite has no business loading, so the map is read as source and
 *  evaluated: it is a pure object literal. */
async function loadAuthzLadders(): Promise<Record<string, LadderSpec>> {
  const src = fs.readFileSync(path.join(REPO, "test/behavioral/cases.mjs"), "utf8");
  const marker = "export const AUTHZ_LADDERS = ";
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("AUTHZ_LADDERS not found in test/behavioral/cases.mjs");
  const body = src.slice(at + marker.length);
  // Balance braces from the opening `{` to the matching `}` — the literal
  // contains no braces inside strings, and the assertion below fails loudly if
  // that ever stops being true.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error("AUTHZ_LADDERS literal is unbalanced");
  // Evaluated, not `JSON.parse`d, because the literal is JS (unquoted keys,
  // trailing commas, comments).  The input is a committed source file in this
  // repo, never anything a test supplies — and if it stops being a plain
  // literal this throws here rather than censusing against an empty ladder set.
  return new Function(`return (${body.slice(0, end)});`)() as Record<string, LadderSpec>;
}

interface LadderArms {
  readonly anonymous?: number | null;
  readonly unauthorized?: number | null;
  readonly authorized?: number | null;
}
interface LadderSurface {
  readonly label?: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly arms?: LadderArms;
}
interface LadderSpec {
  readonly seed: unknown;
  readonly gated: LadderSurface | readonly LadderSurface[];
  readonly arms: LadderArms;
}

/** A status that REFUSES the caller: 401 (not authenticated), 403 (denied), or
 *  404 (denied by hiding existence — what a `deny` carve-out and a tenancy
 *  filter answer, since a filtered read cannot 403 a row it cannot see). */
const isRefusal = (s: number | null | undefined): boolean => s === 401 || s === 403 || s === 404;

// ---------------------------------------------------------------------------
// Population — the corpus, the shared behavioural systems, and the examples.
// ---------------------------------------------------------------------------

interface CensusCase {
  /** Stable key, also the `AUTHZ_GATE_PINS` key. */
  readonly key: string;
  /** Repo-relative `.ddd` path, quoted in the failure remedy. */
  readonly file: string;
  readonly source: string;
  /** Case name the behavioural runners key `AUTHZ_LADDERS` by — `null` when no
   *  runner boots this source, so no ladder is expressible. */
  readonly ladderKey: string | null;
  /** An HONEST EXEMPTION: a corpus fixture already on
   *  `E2E_LESS_CORPUS_FIXTURES`.  It carries no `test e2e` block at all, so it
   *  has no runtime caller of ANY kind and cannot have a refused one — that
   *  whole-fixture gap is recorded ONCE in that register (M-T9.13 / W3.3 own
   *  the drain) instead of being restated as one pin per gated surface here,
   *  which is what "reuse the honest-exemption list" means.  Its surfaces are
   *  still counted, so the census total stays honest. */
  readonly exempt: boolean;
}

const asNode = (src: string): string => src.replaceAll("__PLATFORM__", "node");

function loadPopulation(): CensusCase[] {
  const cases: CensusCase[] = [];

  for (const feature of CORPUS) {
    cases.push({
      key: `corpus/${feature.id}`,
      file: `test/fixtures/corpus/${feature.id}.ddd`,
      source: asNode(corpusSource(feature.id)),
      ladderKey: E2E_LESS_CORPUS_FIXTURES.includes(feature.id) ? null : feature.id,
      exempt: E2E_LESS_CORPUS_FIXTURES.includes(feature.id),
    });
  }

  const systemsDir = path.join(REPO, "test/behavioral/systems");
  for (const f of fs
    .readdirSync(systemsDir)
    .filter((n) => n.endsWith(".ddd"))
    .sort()) {
    const name = f.replace(/\.ddd$/, "");
    cases.push({
      key: `systems/${name}`,
      file: `test/behavioral/systems/${f}`,
      source: asNode(fs.readFileSync(path.join(systemsDir, f), "utf8")),
      ladderKey: name,
      exempt: false,
    });
  }

  // `examples/` — the packet's "and `examples/`" half.  Nothing boots these, so
  // every gate they carry is an `R.notABehaviouralCase` pin rather than a hole;
  // they are censused anyway because an ungated authorization surface in the
  // repo's own showcase is exactly what a reader copies.
  for (const f of fs
    .readdirSync(path.join(REPO, "examples"))
    .filter((n) => n.endsWith(".ddd"))
    .sort()) {
    cases.push({
      key: `examples/${f.replace(/\.ddd$/, "")}`,
      file: `examples/${f}`,
      source: asNode(fs.readFileSync(path.join(REPO, "examples", f), "utf8")),
      ladderKey: null,
      exempt: false,
    });
  }

  // The `broad/` tier — the corpus.json entries the behavioural runners BOOT,
  // which live under `web/src/examples/`.  Only these, not the whole directory:
  // it also holds multi-file FRAGMENTS (`multifile-main`, `multifile-landing`,
  // `fulfillment-newest`) that resolve only as a set and cannot be lowered
  // one file at a time, so censusing the directory wholesale would report a
  // parse failure that is not a defect.  (One real authorization surface sits
  // outside the census because of that: `web/src/examples/auth-capabilities.ddd`
  // carries two `requires` gates and no runner boots it — handed off, see the
  // pins file.)
  for (const c of (
    JSON.parse(fs.readFileSync(path.join(REPO, "test/behavioral/corpus.json"), "utf8")) as {
      cases: { name: string; ddd: string; api?: boolean; unit?: boolean }[];
    }
  ).cases) {
    if (!c.api && !c.unit) continue;
    cases.push({
      key: `broad/${c.name}`,
      file: c.ddd,
      source: asNode(fs.readFileSync(path.join(REPO, c.ddd), "utf8")),
      ladderKey: c.name,
      exempt: false,
    });
  }

  return cases;
}

const POPULATION = loadPopulation().filter((c) => !NON_PARSING_SOURCES.includes(c.key));

// ---------------------------------------------------------------------------
// The gate enumeration
// ---------------------------------------------------------------------------

/** The gate kinds `docs/auth.md` defines.  Ordered so a surface's label reads
 *  the same way every time. */
const GATE_KINDS = ["requires", "policy", "mask", "tenancy"] as const;
type GateKind = (typeof GATE_KINDS)[number];

interface GatedSurface {
  /** `<route class> <METHOD> <path>` — the `AUTHZ_GATE_PINS` key. */
  readonly key: string;
  readonly routeClass: string;
  readonly method: string;
  readonly path: string;
  readonly gates: readonly GateKind[];
}

/** Every route the case serves, gated or not — the ladder-side ratchet compares
 *  against this so a probe pointing at a renamed route fails. */
interface Surfaces {
  readonly gated: GatedSurface[];
  readonly allRoutes: Set<string>;
}

/** Is this route class a READ (its response projects the aggregate) or a WRITE
 *  (it loads-then-mutates)?  The split matters because the two policy seams are
 *  different: a read `contextFilters` gate narrows reads AND the write
 *  command-load that reuses it, while a `writeScopeFilter` narrows ONLY the
 *  write load — tagging a `deny write` onto a read surface would claim a gate
 *  the emitters do not put there. */
const READ_CLASSES = new Set(["getById", "find", "gateProbe", "prepare", "history"]);
const WRITE_CLASSES = new Set(["create", "destroy", "operation", "workflow", "explicitHandler"]);

const isAuthzFilter = (e: ExprIR | undefined): boolean => e?.kind === "authz-filter";
/** A principal-referencing capability filter that is NOT a policy sentinel —
 *  the `tenantOwned` tenant floor and the registry self-scope. */
const isTenancyFilter = (e: ExprIR): boolean => !isAuthzFilter(e) && exprUsesCurrentUser(e);

function aggregateSeamGates(agg: AggregateIR | undefined, routeClass: string): GateKind[] {
  if (!agg) return [];
  const out: GateKind[] = [];
  const read = agg.contextFilters ?? [];
  const isRead = READ_CLASSES.has(routeClass);
  const isWrite = WRITE_CLASSES.has(routeClass);
  // The read seam gates reads and — because every backend's mutation load
  // reuses the read filter (which is what makes a denied `update` 404) — writes
  // too.
  if (read.some(isAuthzFilter)) out.push("policy");
  if (read.some(isTenancyFilter)) out.push("tenancy");
  // The write seam gates writes only.
  if (isWrite && agg.writeScopeFilter) {
    out.push(isAuthzFilter(agg.writeScopeFilter) ? "policy" : "tenancy");
  }
  // A read mask redacts a field of the RETURNED projection, so it is a gate on
  // read surfaces only.  `create` answers `{ id }` and `destroy` answers 204,
  // so neither carries the masked shape.
  if (isRead && (agg.fields ?? []).some((f) => f.maskUnless)) out.push("mask");
  return out;
}

/** The contexts a BACKEND deployable serves — a context no backend ships has no
 *  HTTP surface to gate.  Same rule `api-caller-census` applies. */
function servedContexts(sys: SystemIR): Set<string> {
  const served = new Set<string>();
  for (const d of sys.deployables) {
    let frontend = false;
    try {
      frontend = platformFor(d.platform).isFrontend;
    } catch {
      frontend = false; // unknown platform → treat as backend, like e2e-render
    }
    if (!frontend) for (const n of d.contextNames) served.add(n);
  }
  return served;
}

/** `GET /api/projections/<snake>` (+ `/{key}` when the projection is keyed) —
 *  the slug every emitter and the frontend client derive with `snake(name)`. */
function projectionRoutes(proj: ProjectionIR): { method: string; path: string }[] {
  const base = `${API_BASE_PATH}/projections/${snake(proj.name)}`;
  const out = [{ method: "GET", path: base }];
  if (proj.correlationField) out.push({ method: "GET", path: `${base}/{id}` });
  return out;
}

/** `GET /api/<aggs>/{id}/history` — the audit-history read. */
const historyRoute = (repo: RepositoryIR): { method: string; path: string } => ({
  method: "GET",
  path: `${API_BASE_PATH}/${aggregateSegment(repo.aggregateName)}/{id}/history`,
});

/** `POST /api/workflows/<snake>` (the one command route per workflow) plus the
 *  two instance reads an observable workflow serves. */
const workflowRoute = (wf: WorkflowIR): { method: string; path: string } => ({
  method: "POST",
  path: `${API_BASE_PATH}/workflows/${snake(wf.name)}`,
});
const workflowInstanceRoutes = (wf: WorkflowIR): { method: string; path: string }[] => [
  { method: "GET", path: `${API_BASE_PATH}/workflows/${snake(wf.name)}/instances` },
  { method: "GET", path: `${API_BASE_PATH}/workflows/${snake(wf.name)}/instances/{id}` },
];

/** A workflow's client-reachable command entries — the same set
 *  `validateDefaultDeny`'s `workflowCommandEntries` walks (command-triggered
 *  creates + named `handle` continuations; event-triggered creates and `on(...)`
 *  reactors are never a client POST). */
function workflowCommandGated(wf: WorkflowIR): boolean {
  const gated = (statements: { kind: string }[]): boolean =>
    statements.some((s) => s.kind === "requires");
  for (const cr of wf.creates) {
    if (cr.triggerKind === "command" && gated(cr.statements)) return true;
  }
  for (const h of wf.handlers ?? []) if (gated(h.statements)) return true;
  return false;
}

function surfacesOf(model: LoomModel): Surfaces {
  const gated: GatedSurface[] = [];
  const allRoutes = new Set<string>();
  const add = (
    routeClass: string,
    method: string,
    routePath: string,
    gates: readonly GateKind[],
  ): void => {
    allRoutes.add(`${method} ${routePath}`);
    const uniq = GATE_KINDS.filter((k) => gates.includes(k));
    if (uniq.length === 0) return;
    gated.push({
      key: `${routeClass} ${method} ${routePath}`,
      routeClass,
      method,
      path: routePath,
      gates: uniq,
    });
  };

  for (const sys of model.systems) {
    const served = servedContexts(sys);
    const ctxByName = new Map<string, BoundedContextIR>();
    for (const sd of sys.subdomains) for (const c of sd.contexts) ctxByName.set(c.name, c);

    for (const ctx of ctxByName.values()) {
      if (!served.has(ctx.name)) continue;
      const aggs = new Map(ctx.aggregates.map((a) => [a.name, a]));

      // ── LIFTED: `deriveContextOperations` ────────────────────────────────
      for (const op of deriveContextOperations(ctx)) {
        const agg = aggs.get(op.aggregate);
        const gates: GateKind[] = [...aggregateSeamGates(agg, op.kind)];
        const hasRequires =
          (op.operation !== undefined && operationGates(op.operation).length > 0) ||
          op.find?.requires !== undefined ||
          (op.kind === "create" && lifecycleGates(agg?.canonicalCreate).length > 0) ||
          (op.kind === "destroy" && lifecycleGates(agg?.canonicalDestroy).length > 0);
        if (hasRequires) gates.push("requires");
        add(op.kind, op.method.toUpperCase(), op.path, gates);
      }

      // ── NOT LIFTED (`apiSurfaceCoverage.notLifted`), all six classes ─────
      // `prepare` — `GET /api/<aggs>/prepare`, the create-form seed read.
      // Enumerated through the EMITTER'S OWN predicate
      // (`honoStaticSubpathMethods`, `src/platform/hono/v4/routes-builder.ts`):
      // a REST create plus at least one server-sourced default.  Guessing "one
      // per aggregate" instead would have this census claim ~20 routes no
      // backend mounts — the same two-truths mistake `api-surface.ts` fixed
      // when it dropped its abstract-aggregate and private-operation routes.
      for (const a of ctx.aggregates) {
        if (!emitsRestCreate(a)) continue;
        if (serverSourcedDefaultFields(createInputFields(a)).length === 0) continue;
        add(
          "prepare",
          "GET",
          `${API_BASE_PATH}/${aggregateSegment(a.name)}/prepare`,
          aggregateSeamGates(a, "prepare"),
        );
      }
      for (const repo of ctx.repositories) {
        if (!repo.historyFind) continue;
        const r = historyRoute(repo);
        const gates: GateKind[] = [...aggregateSeamGates(aggs.get(repo.aggregateName), "history")];
        if (repo.historyFind.requires) gates.push("requires");
        add("history", r.method, r.path, gates);
      }
      for (const proj of ctx.projections) {
        const gates: GateKind[] = [];
        if (proj.query?.requires) gates.push("requires");
        if (exprUsesCurrentUser(proj.query?.filter)) gates.push("tenancy");
        for (const r of projectionRoutes(proj)) add("projectionQuery", r.method, r.path, gates);
      }
      for (const wf of ctx.workflows) {
        const r = workflowRoute(wf);
        add("workflow", r.method, r.path, workflowCommandGated(wf) ? ["requires"] : []);
        if (wf.instanceWireShape) {
          for (const ir of workflowInstanceRoutes(wf)) {
            add("workflowInstances", ir.method, ir.path, wf.instanceReadGate ? ["requires"] : []);
          }
        }
      }
    }

    // Explicit handlers reach HTTP only through an `api { route … }` binding —
    // the route IS the reachability proof, exactly as `visibility === "public"`
    // is for an aggregate operation.
    for (const api of sys.apis) {
      for (const route of api.routes) {
        const ctx = ctxByName.get(route.target.context);
        if (!ctx || !served.has(ctx.name)) continue;
        const handler =
          (ctx.commandHandlers ?? []).find((h) => h.name === route.target.handler) ??
          (ctx.queryHandlers ?? []).find((h) => h.name === route.target.handler);
        if (!handler) continue; // a workflow `handle` target — counted above
        const gates: GateKind[] = handler.statements.some((s) => s.kind === "requires")
          ? ["requires"]
          : [];
        add(
          "explicitHandler",
          route.method.toUpperCase(),
          `${API_BASE_PATH}${route.path.startsWith("/") ? "" : "/"}${route.path}`,
          gates,
        );
      }
    }
  }
  return { gated, allRoutes };
}

// ---------------------------------------------------------------------------
// Refusal, read off the ladder
// ---------------------------------------------------------------------------

/** The ladder's surfaces, normalised: `gated` may be one probe or a list, and a
 *  probe may override the spec-level arms. */
function ladderSurfaces(spec: LadderSpec | undefined): (LadderSurface & { arms: LadderArms })[] {
  if (!spec) return [];
  const list = Array.isArray(spec.gated) ? spec.gated : [spec.gated];
  return list.map((g) => ({ ...g, arms: g.arms ?? spec.arms }));
}

/** A probe path as the census spells a route: query string dropped (a find's
 *  `?a=b` is not part of its route), and the ladder's `{id}` placeholder is
 *  already the derivation's spelling. */
const probePath = (p: string): string => p.split("?")[0];

/** `<METHOD> <path>` keys of every route a ladder probe REFUSES someone on. */
function refusedRoutes(spec: LadderSpec | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of ladderSurfaces(spec)) {
    if (isRefusal(s.arms.unauthorized) || isRefusal(s.arms.anonymous)) {
      out.add(`${s.method.toUpperCase()} ${probePath(s.path)}`);
    }
  }
  return out;
}

/** The gate, as data: one message per gated surface that is unrefused-and-
 *  unpinned, or pinned-but-now-refused.  Shared by the real cases and by the
 *  mutation proof below, so the proof exercises the SHIPPED logic. */
function censusFailures(
  c: Pick<CensusCase, "key" | "file">,
  surfaces: readonly GatedSurface[],
  refused: ReadonlySet<string>,
  pins: Record<string, string>,
): string[] {
  const unrefused = surfaces.filter((s) => !refused.has(`${s.method} ${s.path}`));
  const unrefusedKeys = new Set(unrefused.map((s) => s.key));
  const out: string[] = [];
  for (const s of unrefused) {
    if (s.key in pins) continue;
    out.push(
      `${c.key}: gated api surface \`${s.key}\` (gates: ${s.gates.join(", ")}) has NO caller ` +
        `that must be REFUSED. An authz gate driven only from the allowed side cannot be ` +
        `told apart from an absent one. Remedy: add a \`gated\` probe for ${s.method} ` +
        `${s.path} to AUTHZ_LADDERS["${c.key.replace(/^[a-z/]*\//, "")}"] ` +
        `(test/behavioral/cases.mjs) whose \`unauthorized\` (or \`anonymous\`) arm expects ` +
        `401/403/404, or pin it in AUTHZ_GATE_PINS["${c.key}"] ` +
        `(test/ir/authz-gate-census-pins.ts) with a reason.`,
    );
  }
  for (const key of Object.keys(pins)) {
    if (unrefusedKeys.has(key)) continue;
    const exists = surfaces.some((s) => s.key === key);
    out.push(
      `${c.key}: STALE pin \`${key}\` — ` +
        (exists
          ? "this surface now HAS a refused caller. Delete the pin in the same change that " +
            "added the ladder arm."
          : `no such gated surface in ${c.file} (the gate, or the route, was renamed or ` +
            "removed). Delete the pin.") +
        ` (AUTHZ_GATE_PINS["${c.key}"], test/ir/authz-gate-census-pins.ts)`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const LADDERS = await loadAuthzLadders();

describe("authz gate census — every emitted gate has a refused caller or a pin", () => {
  it("censuses a non-trivial population", () => {
    // A silently-empty population is the classic way a census gate passes
    // without reaching anything (`experience_gathered.md` §63).
    expect(POPULATION.length).toBeGreaterThanOrEqual(60);
  });

  it("reads the ladder map the behavioural runners actually drive", () => {
    // If the literal ever stops being statically readable this fails here
    // rather than silently censusing against an empty ladder set — which would
    // turn every refusal into a pin-or-fail and read as a real finding.
    expect(Object.keys(LADDERS).length).toBeGreaterThanOrEqual(4);
    for (const [name, spec] of Object.entries(LADDERS)) {
      expect(
        ladderSurfaces(spec).length,
        `AUTHZ_LADDERS["${name}"] declares no gated probe`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the per-class pin census honest", () => {
    // Recomputed from the pins and compared BOTH ways: an added pin whose count
    // was not raised fails, and so does a drained one whose count was not
    // lowered.  Matched by the `R.*` STRING (the pins store the value, not the
    // key), so a renamed class shows up as an unknown reason rather than as a
    // silently-zero count.
    const byReason = new Map<string, string>(Object.entries(R).map(([k, v]) => [v, k]));
    const actual: Record<string, number> = {};
    for (const surfaces of Object.values(AUTHZ_GATE_PINS)) {
      for (const reason of Object.values(surfaces)) {
        const cls = byReason.get(reason);
        expect(cls, `pin reason is not one of the R.* constants: ${reason}`).toBeDefined();
        actual[cls as string] = (actual[cls as string] ?? 0) + 1;
      }
    }
    expect(
      actual,
      "PIN_CLASS_CENSUS (test/ir/authz-gate-census-pins.ts) disagrees with the pins above it. " +
        "Adding a pin raises its count; draining one lowers it; a class at zero is deleted.",
    ).toEqual(PIN_CLASS_CENSUS);
  });

  it("pins no case that left the population", () => {
    const keys = new Set(POPULATION.map((c) => c.key));
    const orphans = Object.keys(AUTHZ_GATE_PINS).filter((k) => !keys.has(k));
    expect(
      orphans,
      `AUTHZ_GATE_PINS names cases that are no longer censused (renamed/deleted .ddd): ` +
        `${orphans.join(", ")}. Delete them.`,
    ).toEqual([]);
  });

  it("lists every source in the population that does not parse", async () => {
    // The other direction of the same ratchet: a `.ddd` the toolchain cannot
    // read is a bigger finding than an ungated route, and `examples/` outside
    // `acme.ddd` is parsed by no CI gate at all.
    const broken: string[] = [];
    for (const c of loadPopulation()) {
      try {
        await modelOf(c.source);
      } catch {
        broken.push(c.key);
      }
    }
    expect(
      broken.sort(),
      "the set of non-parsing sources changed. A repaired source drops out of " +
        "NON_PARSING_SOURCES (and joins the census with its own pins); a newly-broken one is a " +
        "regression, not an entry to add.",
    ).toEqual([...NON_PARSING_SOURCES].sort());
  }, 600_000);

  it("names an exemption for every censused fixture with no `test e2e` block", () => {
    // Reuses M-T9.13's register rather than minting a second one: a fixture
    // nothing boots cannot have a refused caller by construction.  The
    // intersection is asserted, so a fixture that GAINS an e2e block loses its
    // exemption here and its gates become real holes.
    const exempt = POPULATION.filter((c) => c.ladderKey === null && c.key.startsWith("corpus/"))
      .map((c) => c.key.slice("corpus/".length))
      .sort();
    expect(
      exempt,
      "the e2e-less corpus fixtures this census exempts are no longer exactly " +
        "E2E_LESS_CORPUS_FIXTURES (test/ir/api-caller-census-pins.ts). Do not add a second " +
        "exemption list — drain or extend that one.",
    ).toEqual([...E2E_LESS_CORPUS_FIXTURES].sort());
  });

  it("points every ladder probe at a route that still exists", async () => {
    // The ladder-side ratchet.  A probe whose route was renamed keeps passing
    // as long as the backend answers the expected status for the WRONG reason
    // (a 404 on a path that no longer exists is indistinguishable from a 404
    // the gate answered) — the exact shape `experience_gathered.md` §59 keeps
    // finding.  So every probe must resolve to a route the derivation knows.
    const byLadderKey = new Map(
      POPULATION.filter((c) => c.ladderKey !== null).map((c) => [c.ladderKey as string, c]),
    );
    const problems: string[] = [];
    for (const [name, spec] of Object.entries(LADDERS)) {
      const c = byLadderKey.get(name);
      if (!c) {
        problems.push(`AUTHZ_LADDERS["${name}"] names no censused case`);
        continue;
      }
      const { allRoutes } = surfacesOf(await modelOf(c.source));
      for (const s of ladderSurfaces(spec)) {
        const route = `${s.method.toUpperCase()} ${probePath(s.path)}`;
        if (!allRoutes.has(route)) {
          problems.push(
            `AUTHZ_LADDERS["${name}"] probes \`${route}\`, which ${c.file} serves no longer`,
          );
        }
      }
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  }, 600_000);

  for (const c of POPULATION) {
    it(`${c.key}`, async () => {
      const { gated } = surfacesOf(await modelOf(c.source));
      if (c.exempt) {
        // An e2e-less fixture is exempt from the REQUIREMENT, never from the
        // count — and never from the ratchet either: a pin here would be
        // meaningless (nothing can drain it without an e2e block first), so
        // pinning one is a mistake worth failing on.
        expect(
          AUTHZ_GATE_PINS[c.key],
          `${c.key} is on E2E_LESS_CORPUS_FIXTURES, so its gated surfaces are exempt — a pin ` +
            "here cannot be drained and would go stale silently. Delete it; the whole-fixture " +
            "gap is already recorded in that register.",
        ).toBeUndefined();
        return;
      }
      const refused =
        c.ladderKey === null ? new Set<string>() : refusedRoutes(LADDERS[c.ladderKey]);
      const failures = censusFailures(c, gated, refused, AUTHZ_GATE_PINS[c.key] ?? {});
      expect(failures, `\n${failures.join("\n\n")}\n`).toEqual([]);
    }, 120_000);
  }

  it("records the census totals it measured", async () => {
    // The number this census exists to produce, computed rather than narrated —
    // the mistake `api-caller-census-pins`' prose tallies made twice.  Bounds
    // rather than an exact figure, because the corpus grows: what matters is
    // that the population is reached (a zero here is the vacuous pass) and that
    // the REFUSED count cannot silently fall to nothing.
    let gatedTotal = 0;
    let refusedTotal = 0;
    let exemptTotal = 0;
    for (const c of POPULATION) {
      const { gated } = surfacesOf(await modelOf(c.source));
      gatedTotal += gated.length;
      if (c.exempt) {
        exemptTotal += gated.length;
        continue;
      }
      const refused =
        c.ladderKey === null ? new Set<string>() : refusedRoutes(LADDERS[c.ladderKey]);
      refusedTotal += gated.filter((s) => refused.has(`${s.method} ${s.path}`)).length;
    }
    const pinned = Object.values(AUTHZ_GATE_PINS).reduce((n, m) => n + Object.keys(m).length, 0);
    expect(
      gatedTotal,
      "no gated surface was censused — the enumeration has broken",
    ).toBeGreaterThan(80);
    expect(
      refusedTotal,
      "no gated surface has a refused caller any more — either every ladder arm was deleted or " +
        "the route matching has broken (which reads identically to a drained census)",
    ).toBeGreaterThanOrEqual(8);
    expect(
      exemptTotal + pinned + refusedTotal,
      "the three buckets do not account for every gated surface",
    ).toBe(gatedTotal);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Mutation proof — the gate must FAIL on a seeded defect.  Inline sources, so
// no real fixture is mutated.  (The LADDER proof — a no-op `requires` in the
// create emitter, caught by the arm this change added and NOT by the e2e — is
// recorded in `authz-gate-census-pins.ts`; it needs a booted backend, so it
// cannot live in the fast suite.)
// ---------------------------------------------------------------------------

const MUT_SOURCE = `
system Mut {
  user { id: string  role: string }
  subdomain Core {
    context Ops {
      aggregate Widget with crudish {
        name: string
        operation rename(to: string) {
          requires currentUser.role == "agent"
          name := to
        }
      }
      repository Widgets for Widget { }
    }
  }
  api OpsApi from Core
  storage primary { type: postgres }
  resource widgetState { for: Ops, kind: state, use: primary }
  deployable d {
    platform: node
    contexts: [Ops]
    dataSources: [widgetState]
    serves: OpsApi
    port: 3000
    auth: required
  }
}
`;

const MUT_CASE = { key: "mutation/widget", file: "(inline)" };

/** A ladder that REFUSES the guarded operation — the shape a drain writes. */
const MUT_LADDER: LadderSpec = {
  seed: { path: "/api/widgets", body: { name: "a" } },
  gated: { method: "POST", path: "/api/widgets/{id}/rename", body: { to: "b" } },
  arms: { anonymous: null, unauthorized: 403, authorized: 204 },
};

/** The same ladder with the denial arm removed — a probe that only ever drives
 *  the ALLOWED side, which is the instrument this census exists to reject. */
const MUT_LADDER_ALLOWED_ONLY: LadderSpec = {
  ...MUT_LADDER,
  arms: { anonymous: null, unauthorized: null, authorized: 204 },
};

describe("authz gate census — mutation proof", () => {
  it("FAILS, naming the surface, when a gated operation has no refused caller", async () => {
    const { gated } = surfacesOf(await modelOf(MUT_SOURCE));
    const surface = gated.find((s) => s.key === "operation POST /api/widgets/{id}/rename");
    // The gate is real and lifted…
    expect(surface, `censused surfaces: ${gated.map((s) => s.key).join(", ")}`).toBeDefined();
    expect(surface?.gates).toContain("requires");

    const failures = censusFailures(MUT_CASE, gated, new Set(), {});
    const named = failures.filter((f) => f.includes("`operation POST /api/widgets/{id}/rename`"));
    expect(
      named.length,
      `expected a failure naming the guarded rename, got:\n${failures.join("\n")}`,
    ).toBe(1);
    expect(named[0]).toContain("gates: requires");
    expect(named[0]).toContain("has NO caller that must be REFUSED");
    expect(named[0]).toContain("whose `unauthorized` (or `anonymous`) arm expects 401/403/404");
    expect(named[0]).toContain("or pin it in AUTHZ_GATE_PINS");
  });

  it("STILL FAILS when the ladder drives only the ALLOWED side", async () => {
    // The whole point of the census: a probe whose only arm is `authorized`
    // passes just as well against a gate emitted as a no-op.
    const { gated } = surfacesOf(await modelOf(MUT_SOURCE));
    const failures = censusFailures(MUT_CASE, gated, refusedRoutes(MUT_LADDER_ALLOWED_ONLY), {});
    expect(failures.some((f) => f.includes("operation POST /api/widgets/{id}/rename"))).toBe(true);
  });

  it("goes GREEN for that surface once a REFUSING ladder arm exists", async () => {
    const { gated } = surfacesOf(await modelOf(MUT_SOURCE));
    const refused = refusedRoutes(MUT_LADDER);
    expect(refused).toContain("POST /api/widgets/{id}/rename");
    expect(
      censusFailures(MUT_CASE, gated, refused, {}).filter((f) =>
        f.includes("operation POST /api/widgets/{id}/rename"),
      ),
    ).toEqual([]);
  });

  it("FAILS on a STALE pin — the surface gained a refused caller", async () => {
    const { gated } = surfacesOf(await modelOf(MUT_SOURCE));
    const failures = censusFailures(MUT_CASE, gated, refusedRoutes(MUT_LADDER), {
      "operation POST /api/widgets/{id}/rename": "pinned yesterday",
    });
    expect(
      failures.some((f) => f.includes("STALE pin `operation POST /api/widgets/{id}/rename`")),
    ).toBe(true);
    expect(failures.find((f) => f.includes("STALE pin"))).toContain("Delete the pin");
  });

  it("FAILS on a STALE pin — the gated surface no longer exists", async () => {
    const { gated } = surfacesOf(await modelOf(MUT_SOURCE));
    const failures = censusFailures(MUT_CASE, gated, new Set(), {
      "operation POST /api/widgets/{id}/renamed_away": "pinned yesterday",
    });
    expect(
      failures.some((f) => f.includes("STALE pin `operation POST /api/widgets/{id}/renamed_away`")),
    ).toBe(true);
    expect(failures.find((f) => f.includes("STALE pin"))).toContain("renamed or removed");
  });

  it("counts an UNGATED surface as no surface at all", async () => {
    // The inverse mistake — a census that flags every route would be satisfied
    // by pinning everything and would say nothing about gates.
    const { gated } = surfacesOf(await modelOf(MUT_SOURCE));
    expect(gated.map((s) => s.key)).not.toContain("getById GET /api/widgets/{id}");
    expect(gated.map((s) => s.key)).not.toContain("create POST /api/widgets");
  });
});
