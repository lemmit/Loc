// ---------------------------------------------------------------------------
// M-T9.29 — the pairwise-combination corpus: the COMPOSER.
//
// Turns an axis tuple into a complete, self-consistent `.ddd` source.  The
// output is real Loom source (it round-trips through `ddd parse`), just
// generated rather than hand-written — ~100 crossings is not a set of files
// anyone maintains, and the whole point of the matrix is that no human chose
// which crossings to write down.
//
// The composer's ONE job is to be honest: every system it emits must be a
// system a user could plausibly write.  When two axis values genuinely cannot
// coexist, the composer does NOT quietly drop one — it emits the combination
// and lets the pipeline answer, because "which impossible pairs does a
// `loom.*` validator reject, and which ones crash codegen instead" is exactly
// the question this corpus exists to ask.  The only adjustments it makes are
// the ones a user would also have to make for the source to mean anything:
//
//   - `policy { allow … }` is restricted to tenant-owned aggregates, so the
//     `policyAllow` axis value ALSO mixes in `tenantOwned` (and the tenancy
//     scaffolding it needs).  Without that the fixture would test the
//     validator's stance rule, not the authz×capability crossing.
//   - Under a `tenancy by` system every aggregate needs an explicit stance, so
//     a non-tenant-owned subject is marked `crossTenant`.
//   - `softDelete` owns the destroy command, so `crudish` drops to
//     `updateOnly: true` beside it (exactly as `corpus/scaffold-macros.ddd`
//     spells it).
//
// `__PLATFORM__` is substituted by the harness, matching the corpus
// convention in `test/fixtures/corpus/harness.ts`.
// ---------------------------------------------------------------------------

import { upperFirst } from "../../src/util/naming.js";
import type { Authz, Capability, PairwiseCase, Persistence, Shape } from "./axes.js";

const PLATFORM_TOKEN = "__PLATFORM__";

/** Does this crossing declare a `tenancy by … of Org` system? */
function needsTenancy(cap: Capability, authz: Authz): boolean {
  return cap === "tenantOwned" || authz === "policyAllow" || authz === "deny";
}

/** Does the subject aggregate carry `tenantOwned`?  `policyAllow` forces it —
 *  the `allow` read ladder is only defined over tenant-owned aggregates. */
function subjectIsTenantOwned(cap: Capability, authz: Authz): boolean {
  return cap === "tenantOwned" || authz === "policyAllow";
}

/** `implements tenantRegistry` — the registry only grows the TREE fields when
 *  a `deep` ladder rung actually needs a materialized path. */
function needsRegistryTree(authz: Authz): boolean {
  return authz === "policyAllow";
}

function needsUser(cap: Capability, authz: Authz): boolean {
  return authz !== "none" || needsTenancy(cap, authz);
}

/** Aggregate header modifiers (order-independent per the grammar, but emitted
 *  in a fixed order so the generated source is stable across runs). */
function header(cap: Capability, shape: Shape, authz: Authz): string {
  const parts: string[] = [];
  if (shape === "document") parts.push("shape: document,");
  if (shape === "embedded") parts.push("shape: embedded,");
  if (shape === "eventLog") parts.push("persistedAs: eventLog,");
  if (needsTenancy(cap, authz) && !subjectIsTenantOwned(cap, authz)) parts.push("crossTenant,");
  if (cap === "audited") parts.push("audited,");
  return parts.length > 0 ? ` ${parts.join(" ").replace(/,$/, "")}` : "";
}

/** The `with …` mixin list on the subject aggregate. */
function withClause(cap: Capability, shape: Shape, authz: Authz): string {
  const mixins: string[] = [];
  // An event-sourced aggregate writes its truth by emitting events, so the
  // crudish field-writing update/destroy pair does not belong on it — the
  // fixture spells its own create/operation/apply trio instead.
  if (shape !== "eventLog") {
    mixins.push(cap === "softDeletable" ? "crudish(updateOnly: true)" : "crudish");
  }
  if (subjectIsTenantOwned(cap, authz)) mixins.push("tenantOwned");
  if (cap === "versioned") mixins.push("versioned");
  if (cap === "softDeletable") mixins.push("softDeletable", "softDelete");
  return mixins.length > 0 ? ` with ${mixins.join(", ")}` : "";
}

/** Subject-aggregate members. */
function members(shape: Shape, authz: Authz): string[] {
  const out: string[] = ["    label: string", "    amount: int = 0"];
  if (authz === "mask") {
    out.push("    ssn: string mask unless currentUser.permissions.contains(permissions.unmask)");
  }
  if (shape === "eventLog") {
    out.push(
      "    create open(label: string) { emit Opened { thing: id, label: label } }",
      "    operation bump(by: int) {",
      "      precondition by > 0",
      ...(authz === "requires" ? ['      requires currentUser.role == "agent"'] : []),
      "      emit Bumped { thing: id, by: by }",
      "    }",
      "    apply(e: Opened) { label := e.label  amount := 0 }",
      "    apply(e: Bumped) { amount := amount + e.by }",
    );
    return out;
  }
  // A containment on every stored shape: on `shape: embedded` it is the thing
  // that folds into jsonb, on `document` it rides inside the single column,
  // and on `relational` it is an ordinary child table — one axis value, three
  // completely different emissions.
  out.push(
    "    contains lines: Line[]",
    "    entity Line {",
    "      sku: string",
    "      qty: int",
    "    }",
    "    operation bump(by: int) {",
    "      precondition by > 0",
    ...(authz === "requires" ? ['      requires currentUser.role == "agent"'] : []),
    "      amount := amount + by",
    "    }",
  );
  return out;
}

function policyBlock(authz: Authz): string[] {
  if (authz === "policyAllow") return ["      policy {", "        allow deep on Thing", "      }"];
  // WRITE-deny rather than read-deny: it keeps both seams emitted (reads stay
  // open, the write-scope filter becomes the always-false sentinel), so the
  // fixture exercises the command-load site #2492 crashed on.
  if (authz === "deny") return ["      policy {", "        deny write on Thing", "      }"];
  return [];
}

/** The `platform:` clause, with an optional persistence-adapter override. */
export function platformClause(platform: string, persistence: Persistence): string {
  return persistence === "default" ? platform : `${platform} { persistence: ${persistence} }`;
}

/** Compose one system's `.ddd` source (with the `__PLATFORM__` token left in,
 *  exactly like a curated corpus fixture). */
export function composeSource(c: Pick<PairwiseCase, "capability" | "shape" | "authz">): string {
  const { capability: cap, shape, authz } = c;
  const tenancy = needsTenancy(cap, authz);
  const truthKind = shape === "eventLog" ? "eventLog" : "state";
  const name = `Pw${upperFirst(cap)}${upperFirst(shape)}${upperFirst(authz)}`;

  const L: string[] = [];
  L.push(
    "// GENERATED by test/pairwise/compose.ts (M-T9.29) — do not edit by hand.",
    `// axes: capability=${cap} shape=${shape} authz=${authz}`,
    `system ${name} {`,
  );
  if (needsUser(cap, authz)) {
    L.push("  user { id: guid  role: string  tenantId: string  permissions: string[] }");
  }
  if (tenancy) L.push("  tenancy by user.tenantId of Org");
  L.push("  subdomain Core {");
  if (authz === "mask") L.push("    permissions { unmask }");
  L.push("    context Main {");
  if (shape === "eventLog") {
    L.push(
      "      event Opened { thing: Thing id, label: string }",
      "      event Bumped { thing: Thing id, by: int }",
    );
  }
  L.push(`      aggregate Thing${header(cap, shape, authz)}${withClause(cap, shape, authz)} {`);
  L.push(...members(shape, authz).map((m) => `  ${m}`));
  L.push("      }");
  L.push(
    "      repository Things for Thing {",
    "        find byLabel(l: string): Thing[] where this.label == l",
    "      }",
  );
  L.push(...policyBlock(authz));
  L.push("    }");
  if (tenancy) {
    // The registry lives in its OWN context so its state resource is separate
    // from the subject's — an event-sourced subject's context owns an
    // `eventLog` resource, and a registry is never event-sourced.
    L.push(
      "    context Registry {",
      `      aggregate Org with crudish {`,
      "        name: string",
      ...(needsRegistryTree(authz) ? ["        implements tenantRegistry"] : []),
      "      }",
      "      repository Orgs for Org { }",
      "    }",
    );
  }
  L.push("  }");
  L.push("  api MainApi from Core");
  L.push("  storage primary { type: postgres }");
  L.push(`  resource mainState { for: Main, kind: ${truthKind}, use: primary }`);
  if (tenancy) L.push("  resource registryState { for: Registry, kind: state, use: primary }");
  L.push(
    "  deployable d {",
    `    platform: ${PLATFORM_TOKEN}`,
    `    contexts: [Main${tenancy ? ", Registry" : ""}]`,
    `    dataSources: [mainState${tenancy ? ", registryState" : ""}]`,
    "    serves: MainApi",
    "    port: 4000",
    // `auth: required` whenever ANY principal-referencing machinery is on —
    // an authz surface, or a tenancy filter/stamp.  Not a convenience: a
    // `tenancy by` deployable without auth is refused by name
    // (`loom.context-filter-unsupported`, `loom.<backend>-stamp-unsupported`),
    // so omitting it would spend 40 crossings re-proving one validator instead
    // of reaching the capability×shape interactions the matrix exists for.
    ...(authz === "none" && !tenancy ? [] : ["    auth: required"]),
    "  }",
  );
  L.push("}", "");
  return L.join("\n");
}

/** Compose one case's source specialised for a backend, with the persistence
 *  override applied — the pairwise twin of `corpusSourceFor`. */
export function composeSourceFor(c: PairwiseCase, platform: string): string {
  return composeSource(c).replaceAll(PLATFORM_TOKEN, platformClause(platform, c.persistence));
}
