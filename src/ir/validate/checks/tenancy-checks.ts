import { diagMessage } from "../../../diagnostics/messages.js";
import type { AggregateIR, SystemIR, TypeIR } from "../../types/loom-ir.js";
import {
  classifyTenantStance,
  hasTenantOwned,
  hasTenantRegistry,
  hierarchyRegistry,
  type TenantStance,
  tenancyClaimBinding,
} from "../../util/tenant-stance.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Tenancy checks (tenancy.md).
//
// The AST-level tenancy rule (duplicate `tenancy by`) lives in
// `src/language/validators/tenancy.ts`; claim / registry existence is the
// LINKER's job (both bindings are real cross-references — an
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
 *  (tenancy.md).  The capability PROVIDES the registry
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
        message: diagMessage("loom.tenant-registry-without-tenancy", {
          agg: r.agg,
          name: sys.name,
        }),
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
        message: diagMessage("loom.tenancy-registry-duplicate", {
          name: sys.name,
          length: registries.length,
          registries: registries.map((x) => `'${x.agg}'`).join(", "),
          registryName: sys.tenancy.registryName,
        }),
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
      message: diagMessage("loom.tenancy-registry-not-target", {
        agg: only.agg,
        registryName: sys.tenancy.registryName,
      }),
      source: `${only.ctx}/${only.agg}`,
    });
  }
}

/** Validate `policy { allow <level> on <Aggregate> }` read-reachability rules
 *  (authorization.md §3; tenancy.md).  Fail-closed:
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
            message: diagMessage("loom.policy-duplicate-target#read", {
              name: ctx.name,
              aggregate: rule.aggregate,
              source: rule.source,
            }),
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
            message: diagMessage("loom.policy-unknown-aggregate#read", {
              name: ctx.name,
              source: rule.source,
              aggregate: rule.aggregate,
            }),
            source: src,
          });
          continue;
        }
        if (!hasTenantOwned(agg)) {
          diags.push({
            severity: "error",
            code: "loom.policy-target-not-tenant-owned",
            message: diagMessage("loom.policy-target-not-tenant-owned#read", {
              name: ctx.name,
              source: rule.source,
              aggregate: rule.aggregate,
            }),
            source: src,
          });
          continue;
        }
        if ((rule.level === "deep" || rule.level === "global") && !hierarchy) {
          diags.push({
            severity: "error",
            code: "loom.policy-level-requires-hierarchy",
            message: diagMessage("loom.policy-level-requires-hierarchy#read", {
              name: ctx.name,
              source: rule.source,
              level: rule.level,
            }),
            source: src,
          });
        }
      }
    }
  }
}

/** Validate `policy { allow write <level> on <Aggregate> }` rules
 *  (`docs/old/plans/authorization-phase3.md`).  Fail-closed:
 *
 *   - the shared target checks (`loom.policy-unknown-aggregate`,
 *     `loom.policy-target-not-tenant-owned`, `loom.policy-duplicate-target`) —
 *     a write rule scopes a concrete tenant-owned aggregate, and a context may
 *     hold at most one write rule per aggregate.
 *   - `loom.policy-write-global-invalid` — `write global` is rejected in
 * (root-subtree-wide mutation is a footgun); only `write local` (the
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
            message: diagMessage("loom.policy-duplicate-target#write", {
              name: ctx.name,
              aggregate: rule.aggregate,
              source: rule.source,
            }),
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
            message: diagMessage("loom.policy-unknown-aggregate#write", {
              name: ctx.name,
              source: rule.source,
              aggregate: rule.aggregate,
            }),
            source: src,
          });
          continue;
        }
        if (!hasTenantOwned(agg)) {
          diags.push({
            severity: "error",
            code: "loom.policy-target-not-tenant-owned",
            message: diagMessage("loom.policy-target-not-tenant-owned#write", {
              name: ctx.name,
              source: rule.source,
              aggregate: rule.aggregate,
            }),
            source: src,
          });
          continue;
        }
        if (rule.level === "global") {
          diags.push({
            severity: "error",
            code: "loom.policy-write-global-invalid",
            message: diagMessage("loom.policy-write-global-invalid", {
              name: ctx.name,
              source: rule.source,
            }),
            source: src,
          });
          continue;
        }
        if (rule.level === "deep" && !hierarchy) {
          diags.push({
            severity: "error",
            code: "loom.policy-level-requires-hierarchy",
            message: diagMessage("loom.policy-level-requires-hierarchy#write", {
              name: ctx.name,
              source: rule.source,
            }),
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
              message: diagMessage("loom.policy-write-wider-than-read", {
                name: ctx.name,
                source: rule.source,
                aggregate: rule.aggregate,
                readLevel,
              }),
              source: src,
            });
          }
        }
      }
    }
  }
}

/** Validate `policy { deny [write] on <Aggregate> }` carve-outs (deny-wins —
 *  docs/old/plans/authorization-phase4-deny.md):
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
            message: diagMessage("loom.policy-deny-duplicate", {
              name: ctx.name,
              access: rule.access,
              aggregate: rule.aggregate,
              source: rule.source,
              access2: rule.access === "write" ? "write " : "",
            }),
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
            message: diagMessage("loom.policy-deny-unknown-aggregate", {
              name: ctx.name,
              source: rule.source,
              aggregate: rule.aggregate,
            }),
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
            message: diagMessage("loom.policy-deny-shadows-allow", {
              name: ctx.name,
              source: rule.source,
              access: rule.access,
              aggregate: rule.aggregate,
            }),
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
    // The derived registry self-scope filter compares
    // `<Registry>.id == currentUser.<claim>` — the `tenantId ≡
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
        message: diagMessage("loom.tenancy-claim-type-mismatch", {
          name: sys.name,
          claimField: tenancy.claimField,
          claimType: typeName(claimType),
          registryName: registry.name,
          idValueType: registry.idValueType,
          idValueType2:
            registry.idValueType === "guid"
              ? ` (or '${tenancy.claimField}: string', bound as a guid at the accessor site)`
              : "",
        }),
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
          message: diagMessage("loom.tenant-owned-claim-type", {
            name: sys.name,
            claimField: tenancy.claimField,
            claimType: typeName(claimType),
          }),
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
            message: diagMessage("loom.tenancy-conflicting-stance", { name: agg.name }),
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
              message: diagMessage("loom.tenant-owned-without-tenancy", {
                name: agg.name,
                sysName: sys.name,
              }),
              source: `${ctx.name}/${agg.name}`,
            });
          }
          if (cross) {
            diags.push({
              severity: "warning",
              code: "loom.cross-tenant-without-tenancy",
              message: diagMessage("loom.cross-tenant-without-tenancy", {
                name: agg.name,
                sysName: sys.name,
              }),
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
              message: diagMessage("loom.tenancy-registry-marked", {
                name: agg.name,
                owned: owned ? "'with tenantOwned'" : "'crossTenant'",
              }),
              source: `${ctx.name}/${agg.name}`,
            });
          }
          continue;
        }

        // Inheritance and stance (aggregate-inheritance.md × tenancy.md).
        // A base's FIELDS are merged onto a subtype by the enrich pass, so the
        // base's `tenantOwned` puts `tenant_id NOT NULL` on the subtype's row —
        // but its STANCE is read off `agg.capabilities` alone and does not
        // propagate.  The two rules below are the two halves of that asymmetry:
        // C11 (the subtype takes the opposite side) is a contradiction the
        // model must not express at all, and C10 (the subtype takes no side) is
        // the existing lint, told to say what is actually true.
        const baseStance = inheritedStance(agg, ctx.aggregates, sys);
        if (baseStance && baseStance.stance !== stance && stance !== "unscoped") {
          diags.push({
            severity: "error",
            code: "loom.tenancy-inherited-stance-conflict",
            message: diagMessage("loom.tenancy-inherited-stance-conflict", {
              name: agg.name,
              base: baseStance.base,
              own: stance === "tenantOwned" ? "with tenantOwned" : "crossTenant",
              baseMarker: baseStance.stance === "tenantOwned" ? "with tenantOwned" : "crossTenant",
            }),
            source: `${ctx.name}/${agg.name}`,
          });
          continue;
        }

        // Explicit-stance lint: every row-persisting aggregate under a
        // tenancy system must pick a side.  Abstract bases are exempt (no
        // repository, no table — aggregate-inheritance.md I1).
        if (stance === "unscoped" && !agg.isAbstract) {
          // When the base DID declare a stance, the generic remedy ("add `with
          // tenantOwned` or `crossTenant`") names something the author already
          // wrote and offers a second option that is now an error — so the two
          // remedies are two SITES, each rendering its own catalog key.
          if (baseStance) {
            diags.push({
              severity: "error",
              code: "loom.tenancy-stance-unmarked",
              message: diagMessage("loom.tenancy-stance-unmarked#inherited", {
                name: agg.name,
                base: baseStance.base,
                marker: baseStance.stance === "tenantOwned" ? "with tenantOwned" : "crossTenant",
              }),
              source: `${ctx.name}/${agg.name}`,
            });
          } else {
            diags.push({
              severity: "error",
              code: "loom.tenancy-stance-unmarked",
              message: diagMessage("loom.tenancy-stance-unmarked", { name: agg.name }),
              source: `${ctx.name}/${agg.name}`,
            });
          }
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
                message: diagMessage("loom.unique-missing-tenant-scope", {
                  source: uk.source,
                  name: agg.name,
                  columns: uk.columns.join(", "),
                }),
                source: `${ctx.name}/${agg.name}`,
              });
            }
          }
        }
      }
    }
  }
}

/** The tenancy stance an aggregate inherits from its `extends` chain — the
 *  nearest ancestor that declares one — or `undefined` when no ancestor picks a
 *  side (or the aggregate is a root).
 *
 *  This is deliberately NOT a change to `classifyTenantStance`: resolving the
 *  stance through the chain would silence `loom.tenancy-stance-unmarked` while
 *  the subtype still gets no stamp and no read filter (those are driven by the
 *  base's own `contextFilters`/stamps, which do not propagate either), turning
 *  an honest error into a silent isolation hole.  The rule stays "declare it on
 *  each concrete"; the inherited stance is used only to say something TRUE
 *  about that rule, and to reject a subtype that contradicts it. */
function inheritedStance(
  agg: AggregateIR,
  pool: readonly AggregateIR[],
  sys: Pick<SystemIR, "tenancy">,
): { base: string; stance: TenantStance } | undefined {
  const seen = new Set<string>([agg.name]);
  let cur = agg;
  while (cur.extendsAggregate && !seen.has(cur.extendsAggregate)) {
    seen.add(cur.extendsAggregate);
    const base = pool.find((a) => a.name === cur.extendsAggregate);
    if (!base) return undefined;
    const stance = classifyTenantStance(base, sys);
    if (stance === "tenantOwned" || stance === "crossTenant") return { base: base.name, stance };
    cur = base;
  }
  return undefined;
}
