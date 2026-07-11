// F1 parity guardrail (backend-parity-plan W5).  Mechanises the invariant that
// a capability feature can never be silently "ungated AND unemitting" on a
// backend — the F1 footgun, where a backend parses a feature keyword, the
// validator doesn't gate it, and the emitter drops it on the floor.
//
// For each capability feature × each domain backend, the (feature, backend)
// pair must be in EXACTLY ONE of two states:
//
//   1. GATED   — validateLoomModel(...) returns an error with the feature's
//                gate code (the feature is rejected at compile time), or
//   2. EMITTED — generateSystems(model).files contains the feature's
//                backend-specific emitter marker (the feature is realised).
//
// "Neither" (no gate error AND no emitter marker) is the F1 silent gap and
// FAILS this test.  This is the inverse of the gate sets in
// `src/ir/validate/checks/system-checks.ts` (LIMITED_FAMILIES, PROVENANCE_-,
// AUDIT_OP_-, EVENT_SOURCING_-, TPH_CAPABLE).  The test additionally
// cross-checks that the emit/gate split matches gate-set membership, so drift
// in EITHER direction is caught:
//
//   - a backend the gate set CLAIMS emits but actually doesn't  → emit miss;
//   - a backend NOT in the gate set that silently emits anyway  → unlisted emit.
//
// Markers were chosen empirically (generate each feature × emitting backend,
// pick a robust shared/per-backend string proven present on the emitting
// backends AND absent on a feature-free baseline — see the probe log in the
// W5 audit).  Fast suite: no docker, no LOOM_* env; pure lower+enrich+validate
// and in-memory generateSystems.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

// The five domain (logic-running, persistence-owning) backends.  `elixir` has a
// single foundation — vanilla (plain Phoenix+Ecto) — which emits capability
// filters, provenance, audited operations, event sourcing, and TPH, so it is in
// the `emits` set for every feature below.
const DOMAIN_BACKENDS = ["node", "dotnet", "java", "python", "elixir"] as const;
type Backend = (typeof DOMAIN_BACKENDS)[number];

interface Feature {
  /** Human name for diagnostics. */
  readonly name: string;
  /** The validator gate code that rejects this feature on an unsupporting backend. */
  readonly code: string;
  /** Build a `.ddd` source exercising the feature, hosted on `platform`. */
  readonly ddd: (platform: string) => string;
  /** Backends whose generator EMITS the feature today (the gate-set membership,
   *  used ONLY to cross-check the emit/gate split — NOT to decide the core
   *  no-silent-gap assertion). */
  readonly emits: ReadonlySet<Backend>;
  /** Per-backend emitter marker string proving the feature emitted.  A backend
   *  not in `emits` has no marker (it is expected to gate instead). */
  readonly marker: Partial<Record<Backend, string>>;
}

// ---------------------------------------------------------------------------
// `.ddd` source factories — one per feature, parameterised by the deployable's
// `platform:` clause.  Kept minimal (one aggregate, one repository) so the
// only variable is the feature under test.
// ---------------------------------------------------------------------------

const filterDdd = (platform: string): string => `
system Crit {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        archived: bool
        filter !this.archived
      }
      repository Orders for Order {
        find recent(): Order[] where this.code == "x"
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [ordersState], serves: OrdersApi, port: 4000 }
}`;

const provenanceDdd = (platform: string): string => `
system OrderingSystem {
  subdomain Ordering {
    context Ordering {
      aggregate Order {
        reference: string
        total: int provenanced
        operation reprice(price: int) { total := price }
      }
      repository Orders for Order { }
    }
  }
  api OrderingApi from Ordering
  storage primary { type: postgres }
  resource orderingState { for: Ordering, kind: state, use: primary }
  deployable d { platform: ${platform}, contexts: [Ordering], dataSources: [orderingState], serves: OrderingApi, port: 4000 }
}`;

const auditedDdd = (platform: string): string => `
system Shop {
  subdomain Core {
    context Ordering {
      aggregate Order {
        status: string
        operation cancel() audited { status := "cancelled" }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource ordersState { for: Ordering, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Ordering], dataSources: [ordersState], port: 4000 }
}`;

const eventSourcingDdd = (platform: string): string => `
system Ledger {
  subdomain Core {
    context Accounts {
      event Deposited { account: Account id, amount: int }
      aggregate Account persistedAs(eventLog) {
        balance: int
        create open() { emit Deposited { account: id, amount: 0 } }
        operation deposit(amount: int) { emit Deposited { account: id, amount: amount } }
        apply(e: Deposited) { balance := balance + e.amount }
      }
      repository Accounts for Account { }
    }
  }
  storage pg { type: postgres }
  resource accountsLog { for: Accounts, kind: eventLog, use: pg }
  deployable d { platform: ${platform}, contexts: [Accounts], dataSources: [accountsLog], port: 4000 }
}`;

const tphDdd = (platform: string): string => `
system TPH {
  subdomain D {
    context Fleet {
      abstract aggregate Vehicle { name: string }
      aggregate Car extends Vehicle { doors: int }
      aggregate Truck extends Vehicle { payloadKg: int }
      repository Cars for Car { }
      repository Trucks for Truck { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Fleet, kind: state, use: primary }
  deployable d { platform: ${platform}, contexts: [Fleet], dataSources: [st], serves: A, port: 4000 }
}`;

// ---------------------------------------------------------------------------
// The FEATURES table.  `emits` mirrors the gate-set membership in
// system-checks.ts (LIMITED_FAMILIES / PROVENANCE_BACKENDS /
// AUDIT_OP_BACKENDS / EVENT_SOURCING_BACKENDS / TPH_CAPABLE) — all five domain
// backends emit every feature below (the vanilla Elixir foundation included).
// `marker` strings were verified empirically (present on every `emits` backend,
// absent on a feature-free baseline).
// ---------------------------------------------------------------------------

const FEATURES: readonly Feature[] = [
  {
    name: "capability filter (soft-delete `filter !this.archived`)",
    code: "loom.context-filter-unsupported",
    ddd: filterDdd,
    // Non-principal relational filter: every domain backend emits it
    // (LIMITED_FAMILIES node/elixir/java/python AND it into each read;
    // dotnet rides EF `HasQueryFilter`).
    emits: new Set<Backend>(["node", "dotnet", "java", "python", "elixir"]),
    marker: {
      node: "not(eq(schema.orders.archived",
      dotnet: "!x.Archived",
      java: '@SQLRestriction("not (archived)")',
      python: "not_(OrderRow.archived)",
      // Vanilla Phoenix/Ecto folds the filter into each read's `where:` clause.
      elixir: "not record.archived",
    },
  },
  {
    name: "provenance (`provenanced` field)",
    code: "loom.provenanced-backend-unsupported",
    ddd: provenanceDdd,
    // PROVENANCE_BACKENDS = node/dotnet/java/python/elixir (vanilla emits the
    // provenance_records side table).
    emits: new Set<Backend>(["node", "dotnet", "java", "python", "elixir"]),
    marker: {
      node: "provenance_records",
      dotnet: "provenance_records",
      java: "provenance_records",
      python: "provenance_records",
      elixir: "provenance_records",
    },
  },
  {
    name: "audited operation (`operation … audited`)",
    code: "loom.audited-backend-unsupported",
    ddd: auditedDdd,
    // AUDIT_OP_BACKENDS = node/dotnet/java/python/elixir (vanilla emits the
    // audit_records side table).
    emits: new Set<Backend>(["node", "dotnet", "java", "python", "elixir"]),
    marker: {
      node: "audit_records",
      dotnet: "audit_records",
      java: "audit_records",
      python: "audit_records",
      elixir: "audit_records",
    },
  },
  {
    name: "event sourcing (`persistedAs(eventLog)`)",
    code: "loom.event-sourcing-backend-unsupported",
    ddd: eventSourcingDdd,
    // EVENT_SOURCING_BACKENDS = node/dotnet/python/java/elixir (vanilla's Ecto
    // fold-on-load data layer emits the account_events log table).
    emits: new Set<Backend>(["node", "dotnet", "java", "python", "elixir"]),
    marker: {
      node: "account_events",
      dotnet: "account_events",
      java: "account_events",
      python: "account_events",
      elixir: "account_events",
    },
  },
  {
    name: "TPH inheritance (abstract base + `extends`, sharedTable)",
    code: "loom.tph-backend-unsupported",
    ddd: tphDdd,
    // TPH_CAPABLE = node/dotnet/elixir/python/java (all five domain backends).
    emits: new Set<Backend>(["node", "dotnet", "java", "python", "elixir"]),
    marker: {
      // node/dotnet/python: one shared `vehicles` table (TPH) vs per-concrete
      // tables (TPC).  java: the JPA `@DiscriminatorValue`.  elixir (vanilla):
      // the single `vehicles` migration table.
      node: 'CREATE TABLE "fleet"."vehicles"',
      // .NET wraps the SQL in a C# `@"..."` verbatim literal, doubling each `"`.
      dotnet: 'CREATE TABLE ""fleet"".""vehicles""',
      python: 'CREATE TABLE "fleet"."vehicles"',
      java: "@DiscriminatorValue",
      elixir: "create table(:vehicles",
    },
  },
];

/** `platform:` clause for a backend.  `elixir` has a single (vanilla)
 *  foundation, so the bare keyword is unambiguous. */
const platformClause = (b: Backend): string => b;

/** True iff the validator gates the feature on this backend (an error carrying
 *  the feature's gate code). */
async function isGated(feature: Feature, backend: Backend): Promise<boolean> {
  const { model } = await parseString(feature.ddd(platformClause(backend)), {
    validate: false,
  });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).some(
    (d) => d.severity === "error" && d.code === feature.code,
  );
}

/** True iff the generator emits the feature's marker for this backend.
 *  Generation may THROW on a gated/invalid model (the gate path is what
 *  catches it) — a throw counts as "not emitted". */
async function isEmitted(feature: Feature, backend: Backend): Promise<boolean> {
  const marker = feature.marker[backend];
  const { model } = await parseString(feature.ddd(platformClause(backend)), {
    validate: false,
  });
  let files: Map<string, string>;
  try {
    files = generateSystems(model).files;
  } catch {
    return false;
  }
  // When the gate-set claims this backend does NOT emit, there is no marker to
  // look for — treat any incidental file content as "not emitted" so the
  // cross-check below stays honest (the gate must be carrying the pair).
  if (!marker) return false;
  return [...files.values()].some((c) => c.includes(marker));
}

describe("backend capability-feature parity gates (F1 guardrail)", () => {
  for (const feature of FEATURES) {
    describe(feature.name, () => {
      for (const backend of DOMAIN_BACKENDS) {
        it(`${backend}: is gated XOR emitted (never a silent gap)`, async () => {
          const [gated, emitted] = await Promise.all([
            isGated(feature, backend),
            isEmitted(feature, backend),
          ]);

          // (1) The core F1 invariant: a (feature, backend) pair is NEVER
          // "neither".  A gap here means the backend parses the feature,
          // doesn't gate it, and silently drops it — the exact footgun this
          // test exists to prevent.
          expect(
            gated || emitted,
            `F1-class silent gap: ${feature.name} on ${backend} is neither gated nor emitted ` +
              `(validator returned no '${feature.code}' error AND no emitter marker found). ` +
              `Either gate the feature on ${backend} (add it to the gate set in ` +
              `system-checks.ts) or emit it (and add the marker to this test).`,
          ).toBe(true);

          // (2) Exactly one state — never BOTH gated and emitted (a gated
          // feature must not also realise; that would mean the gate is dead).
          expect(
            gated && emitted,
            `${feature.name} on ${backend} is BOTH gated and emitted — the gate is ` +
              `unreachable or the marker is a false positive.`,
          ).toBe(false);

          // (3) Positive cross-check: a backend the gate set CLAIMS emits must
          // actually emit (catches "listed but doesn't really emit"), and a
          // backend NOT in the set must be gated (catches "silently emitting
          // an unlisted backend").
          const shouldEmit = feature.emits.has(backend);
          expect(
            emitted,
            shouldEmit
              ? `${feature.name}: gate set claims ${backend} emits, but no marker ` +
                  `'${feature.marker[backend]}' was found in the generated output.`
              : `${feature.name}: ${backend} is NOT in the gate set but silently emitted ` +
                  `a marker — it must be gated instead.`,
          ).toBe(shouldEmit);
          expect(
            gated,
            shouldEmit
              ? `${feature.name}: ${backend} emits, so it must not also be gated.`
              : `${feature.name}: ${backend} is not an emitting backend, so it must be ` +
                  `gated with '${feature.code}'.`,
          ).toBe(!shouldEmit);
        });
      }
    });
  }
});
