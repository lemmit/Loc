import type { SystemIR, TypeIR } from "../../types/loom-ir.js";
import {
  classifyTenantStance,
  hasTenantOwned,
  hasTenantRegistry,
  hierarchyRegistry,
  tenancyClaimBinding,
} from "../../util/tenant-stance.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Tenancy checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §1).
//
// The AST-level tenancy rule (duplicate `tenancy by`) lives in
// `src/language/validators/tenancy.ts`; claim / registry existence is the
// LINKER's job since 1b.1 (both bindings are real cross-references — an
// unknown name is a parse-level "Could not resolve reference …", not the
// former `loom.tenancy-registry-unknown` / `loom.tenancy-unknown-claim`).
// This leaf owns everything that needs the merged, fully-lowered model:
//
//   - the explicit-stance lint: under a `tenancy by` system every
//     row-persisting aggregate must pick a side — `with tenantOwned`
//     (tenant data) or `crossTenant` (shared data)
//     (`loom.tenancy-stance-unmarked`).  The registry is exempt (self-keyed;
//     neither marker fits — a *marked* registry is
//     `loom.tenancy-registry-marked`), and so are `abstract` bases (they
//     persist no rows of their own — no repository, no table; the
//     requirement falls on the TPC/TPH concretes, which do NOT inherit the
//     base's capability record).
//   - stance markers without a `tenancy by` declaration:
//     `loom.tenant-owned-without-tenancy` (error — the capability stamps and
//     filters by a claim no declaration names) and
//     `loom.cross-tenant-without-tenancy` (warning — intent declared,
//     nothing to opt out of)
//   - `loom.tenancy-conflicting-stance` — both markers on one aggregate.
//
// Stance is DERIVED per aggregate via `classifyTenantStance`
// (`src/ir/util/tenant-stance.ts`) — never stamped on the IR.
// ---------------------------------------------------------------------------

/** Display name for the claim's declared type in the mismatch message. */
function typeName(t: TypeIR): string {
  return t.kind === "primitive" ? t.name : t.kind;
}

/** Structural checks for the `tenantRegistry` hierarchy capability
 *  (multi-tenancy Phase 2, plan P2.2).  The capability PROVIDES the registry
 *  tree fields (`parent: Self id?`, managed `dataKey`); this verifies the
 *  facts the design lists that aren't field-presence (which the capability
 *  guarantees by construction): it is opted into only under a `tenancy by`
 *  system, exactly one aggregate carries it, and that aggregate is the
 *  `of <Registry>` target.  `parent`'s immutability and its self-reference are
 *  structural — `immutable` access freezes it after create, and `Self`
 *  resolves to the host aggregate at expansion — so neither needs a check. */
function validateTenantRegistry(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const registries: { ctx: string; agg: string }[] = [];
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      for (const agg of ctx.aggregates) {
        if (hasTenantRegistry(agg)) registries.push({ ctx: ctx.name, agg: agg.name });
      }
    }
  }
  if (registries.length === 0) return;

  // Hierarchy has no meaning without the `tenancy by` declaration that names
  // the claim keying `currentUser.orgPath` into the registry — fail-closed.
  if (!sys.tenancy) {
    for (const r of registries) {
      diags.push({
        severity: "error",
        code: "loom.tenant-registry-without-tenancy",
        message:
          `aggregate '${r.agg}' implements 'tenantRegistry' but system '${sys.name}' declares no ` +
          `'tenancy by user.<claim> of <Registry>' line.  The registry tree (parent + dataKey) is ` +
          `only meaningful under a tenancy declaration — add it, or drop 'implements tenantRegistry'.`,
        source: `${r.ctx}/${r.agg}`,
      });
    }
    return;
  }

  // Exactly one registry aggregate — 'tenantRegistry' is the singular tree root.
  if (registries.length > 1) {
    for (const r of registries) {
      diags.push({
        severity: "error",
        code: "loom.tenancy-registry-duplicate",
        message:
          `system '${sys.name}' has ${registries.length} aggregates implementing 'tenantRegistry' ` +
          `(${registries.map((x) => `'${x.agg}'`).join(", ")}); the tenant registry is singular — ` +
          `keep it on exactly one aggregate (the '${sys.tenancy.registryName}' named in 'tenancy by … of').`,
        source: `${r.ctx}/${r.agg}`,
      });
    }
    return;
  }

  // The one registry must BE the `of <Registry>` target — the hierarchy fields
  // hang off the aggregate the tenancy claim keys into, nowhere else.
  const only = registries[0];
  if (only && only.agg !== sys.tenancy.registryName) {
    diags.push({
      severity: "error",
      code: "loom.tenancy-registry-not-target",
      message:
        `aggregate '${only.agg}' implements 'tenantRegistry' but the tenancy registry is ` +
        `'${sys.tenancy.registryName}' ('tenancy by … of ${sys.tenancy.registryName}').  The tree ` +
        `capability belongs on the registry itself — move 'implements tenantRegistry' onto ` +
        `'${sys.tenancy.registryName}'.`,
      source: `${only.ctx}/${only.agg}`,
    });
  }
}

/** Validate `policy { allow <level> on <Aggregate> }` read-reachability rules
 *  (authorization.md §3; multi-tenancy Phase 2 P2.4).  Fail-closed:
 *
 *   - `loom.policy-unknown-aggregate` — the target names no aggregate in the
 *     policy's own context (the read ladder scopes a concrete tenant-owned
 *     aggregate; a bare name must resolve locally).
 *   - `loom.policy-target-not-tenant-owned` — the target exists but isn't
 *     `with tenantOwned`.  A read level only refines the tenant floor, which
 *     only tenant-owned aggregates carry (`crossTenant` / unscoped / the
 *     self-keyed registry have no `tenantId`/`dataKey` to scope by).
 *   - `loom.policy-level-requires-hierarchy` — `deep` / `global` need the
 *     materialized-path tree (`implements tenantRegistry`); without it the
 *     directional ladder is meaningless (`local` is the only defined level
 *     under flat tenancy — every org is its own root).
 *   - `loom.policy-duplicate-target` — two rules select the same aggregate, so
 *     the effective level is ambiguous.
 */
function validatePolicyReadLevels(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const hierarchy = hierarchyRegistry(sys) !== undefined;
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      const rules = ctx.policyReadLevels ?? [];
      if (rules.length === 0) continue;
      const seen = new Set<string>();
      for (const rule of rules) {
        const src = `${ctx.name}/policy`;
        if (seen.has(rule.aggregate)) {
          diags.push({
            severity: "error",
            code: "loom.policy-duplicate-target",
            message:
              `policy in context '${ctx.name}' selects a read level for '${rule.aggregate}' more ` +
              `than once (\`${rule.source}\`); keep exactly one \`allow … on ${rule.aggregate}\`.`,
            source: src,
          });
          continue;
        }
        seen.add(rule.aggregate);

        const agg = ctx.aggregates.find((a) => a.name === rule.aggregate);
        if (!agg) {
          diags.push({
            severity: "error",
            code: "loom.policy-unknown-aggregate",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` names '${rule.aggregate}', which ` +
              `is not an aggregate in this context.  A read level scopes a tenant-owned aggregate ` +
              `declared in the same context.`,
            source: src,
          });
          continue;
        }
        if (!hasTenantOwned(agg)) {
          diags.push({
            severity: "error",
            code: "loom.policy-target-not-tenant-owned",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` targets '${rule.aggregate}', which ` +
              `is not \`with tenantOwned\`.  A read level refines the tenant floor, so it applies only ` +
              `to tenant-owned aggregates (crossTenant / unscoped / the registry have no tenant scope).`,
            source: src,
          });
          continue;
        }
        if ((rule.level === "deep" || rule.level === "global") && !hierarchy) {
          diags.push({
            severity: "error",
            code: "loom.policy-level-requires-hierarchy",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` uses the '${rule.level}' read level, ` +
              `which needs a tenant hierarchy — mark the registry \`implements tenantRegistry\` (the ` +
              `materialized-path tree).  Under flat tenancy only 'local' is defined (every org is its ` +
              `own root).`,
            source: src,
          });
        }
      }
    }
  }
}

/** Validate `policy { allow write <level> on <Aggregate> }` rules (authorization
 *  Phase 3 P3.1 — `docs/plans/authorization-phase3.md`).  Fail-closed:
 *
 *   - the shared target checks (`loom.policy-unknown-aggregate`,
 *     `loom.policy-target-not-tenant-owned`, `loom.policy-duplicate-target`) —
 *     a write rule scopes a concrete tenant-owned aggregate, and a context may
 *     hold at most one write rule per aggregate.
 *   - `loom.policy-write-global-unsupported` — `write global` is rejected in
 *     P3.1 (root-subtree-wide mutation is a footgun); only `write local` (the
 *     floor) and `write deep` are offered.
 *   - `loom.policy-level-requires-hierarchy` — `write deep` needs the
 *     materialized-path tree (`implements tenantRegistry`), same as read `deep`.
 *   - `loom.policy-write-wider-than-read` — `write deep` requires a matching
 *     `allow deep`/`allow global` read rule (you cannot write what you cannot
 *     read).
 */
function validatePolicyWriteLevels(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const hierarchy = hierarchyRegistry(sys) !== undefined;
  const rank: Record<string, number> = { local: 0, deep: 1, global: 2 };
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      const rules = ctx.policyWriteLevels ?? [];
      if (rules.length === 0) continue;
      const readByAgg = new Map(
        (ctx.policyReadLevels ?? []).map((r) => [r.aggregate, r.level] as const),
      );
      const seen = new Set<string>();
      for (const rule of rules) {
        const src = `${ctx.name}/policy`;
        if (seen.has(rule.aggregate)) {
          diags.push({
            severity: "error",
            code: "loom.policy-duplicate-target",
            message:
              `policy in context '${ctx.name}' selects a write level for '${rule.aggregate}' more ` +
              `than once (\`${rule.source}\`); keep exactly one \`allow write … on ${rule.aggregate}\`.`,
            source: src,
          });
          continue;
        }
        seen.add(rule.aggregate);

        const agg = ctx.aggregates.find((a) => a.name === rule.aggregate);
        if (!agg) {
          diags.push({
            severity: "error",
            code: "loom.policy-unknown-aggregate",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` names '${rule.aggregate}', which ` +
              `is not an aggregate in this context.  A write level scopes a tenant-owned aggregate ` +
              `declared in the same context.`,
            source: src,
          });
          continue;
        }
        if (!hasTenantOwned(agg)) {
          diags.push({
            severity: "error",
            code: "loom.policy-target-not-tenant-owned",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` targets '${rule.aggregate}', which ` +
              `is not \`with tenantOwned\`.  A write level refines the tenant floor, so it applies only ` +
              `to tenant-owned aggregates.`,
            source: src,
          });
          continue;
        }
        if (rule.level === "global") {
          diags.push({
            severity: "error",
            code: "loom.policy-write-global-unsupported",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` uses \`write global\`, which is not ` +
              `offered — root-subtree-wide mutation is a footgun.  Use \`write deep\` (the caller's own ` +
              `subtree) or \`write local\` (the floor).  A caller can still \`allow global\` for READS.`,
            source: src,
          });
          continue;
        }
        if (rule.level === "deep" && !hierarchy) {
          diags.push({
            severity: "error",
            code: "loom.policy-level-requires-hierarchy",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` uses the 'deep' write level, which ` +
              `needs a tenant hierarchy — mark the registry \`implements tenantRegistry\` (the ` +
              `materialized-path tree).  Under flat tenancy only 'local' is defined.`,
            source: src,
          });
          continue;
        }
        // Coherence: you cannot write wider than you can read.  `write deep`
        // requires the aggregate's read level to be at least `deep`
        // (`allow deep` or `allow global`).
        if (rule.level === "deep") {
          const readLevel = readByAgg.get(rule.aggregate) ?? "local";
          if ((rank[readLevel] ?? 0) < (rank.deep ?? 1)) {
            diags.push({
              severity: "error",
              code: "loom.policy-write-wider-than-read",
              message:
                `policy in context '${ctx.name}': \`${rule.source}\` grants a wider WRITE scope than ` +
                `the READ scope for '${rule.aggregate}' (read is '${readLevel}').  You cannot write ` +
                `what you cannot read — add \`allow deep on ${rule.aggregate}\` (or \`allow global\`).`,
              source: src,
            });
          }
        }
      }
    }
  }
}

/** Validate `policy { deny [write] on <Aggregate> }` carve-outs (authorization
 *  Phase 4 — deny-wins, docs/plans/authorization-phase4-deny.md):
 *
 *   - `loom.policy-deny-unknown-aggregate` — the target names no aggregate in the
 *     policy's own context (a carve-out scopes a concrete local aggregate).
 *   - `loom.policy-deny-duplicate` — the same `(aggregate, access)` is denied by
 *     two rules in one context (copy-paste; the carve-out is already total).
 *   - `loom.policy-deny-shadows-allow` — an `allow` rule targets the same
 *     `(aggregate, access)` a `deny` covers in this context; the allow is DEAD
 *     because deny wins.  Emitted as a WARNING (not an error): the proposal's
 *     motivating "role A allows, role B denies" scenario is legitimate deny-wins
 *     and must not be a hard error, but a shadowed allow should never be silent.
 *
 *  Unlike the allow ladder, deny is NOT gated on `tenantOwned` — it composes
 *  through `contextFilters` / `writeScopeFilter`, which every aggregate carries.
 */
function validatePolicyDenies(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      const rules = ctx.policyDenies ?? [];
      if (rules.length === 0) continue;
      const readAllowed = new Set((ctx.policyReadLevels ?? []).map((r) => r.aggregate));
      const writeAllowed = new Set((ctx.policyWriteLevels ?? []).map((r) => r.aggregate));
      const seen = new Set<string>();
      for (const rule of rules) {
        const src = `${ctx.name}/policy`;
        const key = `${rule.access}:${rule.aggregate}`;
        if (seen.has(key)) {
          diags.push({
            severity: "error",
            code: "loom.policy-deny-duplicate",
            message:
              `policy in context '${ctx.name}' denies ${rule.access} on '${rule.aggregate}' more ` +
              `than once (\`${rule.source}\`); one \`deny ${rule.access === "write" ? "write " : ""}` +
              `on ${rule.aggregate}\` is total — keep exactly one.`,
            source: src,
          });
          continue;
        }
        seen.add(key);

        const agg = ctx.aggregates.find((a) => a.name === rule.aggregate);
        if (!agg) {
          diags.push({
            severity: "error",
            code: "loom.policy-deny-unknown-aggregate",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` names '${rule.aggregate}', which ` +
              `is not an aggregate in this context.  A deny carve-out scopes an aggregate declared ` +
              `in the same context.`,
            source: src,
          });
          continue;
        }

        // A shadowed allow is dead (deny wins) — flag it, but only as a warning.
        const shadowed = rule.access === "write" ? writeAllowed : readAllowed;
        if (shadowed.has(rule.aggregate)) {
          diags.push({
            severity: "warning",
            code: "loom.policy-deny-shadows-allow",
            message:
              `policy in context '${ctx.name}': \`${rule.source}\` shadows an \`allow\` ${rule.access} ` +
              `rule for '${rule.aggregate}' — deny wins, so the allow is dead.  Remove the allow, or ` +
              `the deny if you meant to keep the grant.`,
            source: src,
          });
        }
      }
    }
  }
}

export function validateTenancy(sys: SystemIR, diags: LoomDiagnostic[]): void {
  validateTenantRegistry(sys, diags);
  validatePolicyReadLevels(sys, diags);
  validatePolicyWriteLevels(sys, diags);
  validatePolicyDenies(sys, diags);
  const tenancy = sys.tenancy;

  // Registry existence is a LINKING concern since 1b.1 — `of <Registry>` is a
  // real cross-reference (`registry=[Aggregate:ID]`), so an unknown name
  // surfaces as a Langium "could not resolve" diagnostic at parse time; no IR
  // re-check needed (an unresolved ref lowers with its `$refText`, and the
  // lookups below simply find no aggregate and skip).
  if (tenancy) {
    // The derived registry self-scope filter (Phase 1b, capstone decision 4)
    // compares `<Registry>.id == currentUser.<claim>` — the `tenantId ≡
    // <Registry>.id` identity — so the claim's declared type must bind
    // against the registry's id value type: same-typed always works, and a
    // `string` claim binds as a guid at each backend's accessor site
    // (`tenancyClaimBinding`).  Anything else can't compare on any backend —
    // reject with the fix spelled out rather than emitting a filter that
    // never matches (or doesn't compile).
    const registry = sys.subdomains
      .flatMap((mod) => mod.contexts)
      .flatMap((ctx) => ctx.aggregates)
      .find((a) => a.name === tenancy.registryName);
    const claimType = sys.user?.fields.find((f) => f.name === tenancy.claimField)?.type;
    if (
      registry &&
      claimType &&
      tenancyClaimBinding(registry.idValueType, claimType) === "mismatch"
    ) {
      diags.push({
        severity: "error",
        code: "loom.tenancy-claim-type-mismatch",
        message:
          `system '${sys.name}': tenancy claim 'user.${tenancy.claimField}' is typed ` +
          `'${typeName(claimType)}' but registry '${registry.name}' has a ${registry.idValueType} id. ` +
          `The derived registry self-scope filter compares ${registry.name}.id to the claim, so ` +
          `declare the claim as '${tenancy.claimField}: ${registry.idValueType}'` +
          `${registry.idValueType === "guid" ? ` (or '${tenancy.claimField}: string', bound as a guid at the accessor site)` : ""}.`,
        source: `${sys.name}/tenancy`,
      });
    }

    // tenantOwned claim-type gate (1b-tail): the capability's provided field
    // is `tenantId: string`, and its stamp/filter compare that field to the
    // claim — a non-string claim (`tenantId: guid`) makes `string == Guid`
    // comparisons that mis-compile the typed backends (.NET/Java).  The
    // registry's own comparison handles guid claims (same-typed against
    // the registry's guid id), so this only fires when a `tenantOwned` aggregate exists.
    // The proper fix — claim-typed capability fields — is future work; until
    // then, string claims carry guid VALUES fine (the org id round-trips as
    // text), so the suggested fix costs nothing.
    const claimIsString = claimType?.kind === "primitive" && claimType.name === "string";
    if (claimType && !claimIsString) {
      const anyOwned = sys.subdomains.some((mod) =>
        mod.contexts.some((ctx) => ctx.aggregates.some((a) => hasTenantOwned(a))),
      );
      if (anyOwned) {
        diags.push({
          severity: "error",
          code: "loom.tenant-owned-claim-type",
          message:
            `system '${sys.name}': tenancy claim 'user.${tenancy.claimField}' is typed ` +
            `'${typeName(claimType)}' but 'tenantOwned' provides 'tenantId: string' — the ` +
            `stamp/filter comparison mis-compiles typed backends.  Declare the claim as ` +
            `'${tenancy.claimField}: string' (guid values round-trip as text).`,
          source: `${sys.name}/tenancy`,
        });
      }
    }
  }

  for (const mod of sys.subdomains) {
    for (const ctx of mod.contexts) {
      for (const agg of ctx.aggregates) {
        const owned = hasTenantOwned(agg);
        const cross = agg.crossTenant === true;

        // Both markers on one aggregate are contradictory regardless of
        // whether the system declares tenancy at all.
        if (owned && cross) {
          diags.push({
            severity: "error",
            code: "loom.tenancy-conflicting-stance",
            message:
              `aggregate '${agg.name}' is marked both 'crossTenant' and 'with tenantOwned'; ` +
              `the stances are mutually exclusive — keep exactly one.`,
            source: `${ctx.name}/${agg.name}`,
          });
          continue;
        }

        if (!tenancy) {
          // Stance markers only mean something under a `tenancy by` system.
          if (owned) {
            diags.push({
              severity: "error",
              code: "loom.tenant-owned-without-tenancy",
              message:
                `aggregate '${agg.name}' implements 'tenantOwned' but system '${sys.name}' ` +
                `declares no 'tenancy by user.<claim> of <Registry>' line.  Add the tenancy ` +
                `declaration, or drop 'with tenantOwned'.`,
              source: `${ctx.name}/${agg.name}`,
            });
          }
          if (cross) {
            diags.push({
              severity: "warning",
              code: "loom.cross-tenant-without-tenancy",
              message:
                `aggregate '${agg.name}' is marked 'crossTenant' but system '${sys.name}' ` +
                `declares no 'tenancy by' line — there is no tenant scoping to opt out of, ` +
                `so the flag has no effect.`,
              source: `${ctx.name}/${agg.name}`,
            });
          }
          continue;
        }

        const stance = classifyTenantStance(agg, sys);

        // The registry is self-keyed — neither stance marker fits it.
        if (stance === "registry") {
          if (owned || cross) {
            diags.push({
              severity: "error",
              code: "loom.tenancy-registry-marked",
              message:
                `aggregate '${agg.name}' is the tenancy registry (named in ` +
                `'tenancy by ... of ${agg.name}') and must not be marked ` +
                `${owned ? "'with tenantOwned'" : "'crossTenant'"} — the registry is ` +
                `self-keyed; drop the marker.`,
              source: `${ctx.name}/${agg.name}`,
            });
          }
          continue;
        }

        // Explicit-stance lint: every row-persisting aggregate under a
        // tenancy system must pick a side.  Abstract bases are exempt (no
        // repository, no table — aggregate-inheritance.md I1).
        if (stance === "unscoped" && !agg.isAbstract) {
          diags.push({
            severity: "error",
            code: "loom.tenancy-stance-unmarked",
            message:
              `aggregate '${agg.name}' declares no tenancy stance; add ` +
              `\`with tenantOwned\` (tenant data) or \`crossTenant\` (shared data).`,
            source: `${ctx.name}/${agg.name}`,
          });
        }

        // Tenant-scope lint (uniqueness-and-indexes.md §5): a `unique (...)`
        // on a tenant-owned aggregate that omits the tenant discriminator
        // (`tenantId`) is a global unique — it blocks legitimate cross-tenant
        // duplicates.  Almost always the author meant `unique (tenantId, …)`.
        if (stance === "tenantOwned") {
          for (const uk of agg.uniqueKeys ?? []) {
            if (!uk.columns.includes("tenantId")) {
              diags.push({
                severity: "warning",
                code: "loom.unique-missing-tenant-scope",
                message:
                  `\`${uk.source}\` on tenant-owned aggregate '${agg.name}' omits the tenant ` +
                  `discriminator — this is a GLOBAL unique across all tenants. Did you mean ` +
                  `\`unique (tenantId, ${uk.columns.join(", ")})\`?`,
                source: `${ctx.name}/${agg.name}`,
              });
            }
          }
        }
      }
    }
  }
}
