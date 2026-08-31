import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/api/index.js";
import { codeOfMessageKey, DIAGNOSTIC_MESSAGES } from "../../src/diagnostics/messages.js";
import {
  SUPPORTED_PAGED_BACKENDS,
  SUPPORTED_RETURN_BACKENDS,
} from "../../src/ir/validate/checks/structural-checks.js";
import {
  EVENT_SOURCING_WORKFLOW_BACKENDS,
  FILTER_BYPASS_FAMILIES,
  PAGED_QH_SUPPORTED,
  PROJECTION_AGG_SUPPORTED,
  PROJECTION_GROUPBY_SUPPORTED,
  PROJECTION_PROJ_SOURCE_SUPPORTED,
  PROJECTION_QT_SUPPORTED,
  PROJECTION_WF_SOURCE_SUPPORTED,
  REMOTE_API_OP_UNSUPPORTED,
} from "../../src/ir/validate/checks/system-checks.js";
import {
  allAdapterNames,
  hasAdapters,
  styleSupportedLayouts,
} from "../../src/platform/adapter-metadata.js";
import { parseBuiltinPlatformRef } from "../../src/platform/metadata.js";
import { FLUTTER_UNRENDERED_PRIMITIVES } from "../../src/util/flutter-deferred-primitives.js";
import { COVERED_ELSEWHERE, UNCOVERED } from "./diagnostic-firing-census.data.js";

// ---------------------------------------------------------------------------
// Diagnostic FIRING census (M-T9.33).
//
// `diagnostic-catalog.test.ts` gates the catalogue's WORDING — no inline
// literals, key⇒code agreement, no orphaned entries.  What nothing gated is
// whether a `loom.*` gate is ever REACHED.  A check can be refactored into
// unreachability with that test, the layering test, and 16,000 others all
// green, and the repo has already found four such arms by hand
// (`workflow-checks.ts`, M-T9.19) — plus one documented-covered claim that was
// simply false (`loom.workflow-emit-unknown-field`, cited to a test file that
// no longer exists).
//
// WHY THIS SHAPE, AND NOT A GREP.  Both static censuses were measured against
// the dynamic one on 2026-08-13 and both are wrong, in both directions
// (`docs/audits/test-coverage-audit-2026-08-13.md` §3.1):
//
//   code named nowhere under test/                         131 "uncovered"
//   …and no ≥14-char fragment of its message either        111 "uncovered"
//   never CONSTRUCTED during a full instrumented run        49  uncovered
//
// It over-reports because the suite's real coverage style includes split
// message assertions (`e.includes("self-hosted") && e.includes("issuer")`
// covers all five `auth.ts` codes) that no text search can reconstruct; and it
// under-reports because 23 of the 49 never-fired codes ARE named under test/ —
// in a register table that asserts the code is LISTED, or in a comment.
//
// So the gate does not search and does not instrument.  It DRIVES: each fixture
// below is a minimal `.ddd` that must make its code come out of `validate()`.
// That is deterministic, shard-safe (no whole-run state to union), and the
// drain it asks for produces real negative tests rather than a report.
//
// FIVE BUCKETS, and every catalogue code is in exactly one:
//
//   FIRING_FIXTURES   — proven here, by running it.
//   UNREACHABLE_PINS  — cannot fire from source; the reason is the entry.
//   DRIVEN_ELSEWHERE  — reachable, but not from `.ddd`: a named test drives it,
//                       and the pointer is CHECKED (file exists, names the
//                       code).  Added for the macro-authoring trio, which needs
//                       a misbehaving macro rather than a source defect.
//   UNCOVERED         — no proof yet.  Shrink-only.  The drain list.
//   COVERED_ELSEWHERE — raised by some other test per the 2026-08-13 census.
//                       Frozen; a NEW code can never join it.
//
// That last rule is what makes this a ratchet rather than a snapshot: a code
// added tomorrow fails this test until its author either writes a fixture or
// pins it with a reason.  Nobody has to remember to run a sweep.
// ---------------------------------------------------------------------------

/** A minimal system whose only defect is the one under test. */
const unionMatch = (subjectAndArms: string) => `
system S {
  subdomain D { context Shop {
    error NotFound { resource: string }
    error Other { resource: string }
    aggregate Order with crudish { code: string }
    repository Orders for Order {
      find byCode(code: string): Order or NotFound where this.code == code
    }
    workflow resolve {
      create(code: string) {
        let outcome = Orders.byCode(code)
        let label = match ${subjectAndArms}
      }
    }
  } }
}`;

const uiWith = (clause: string) => `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  ui WebApp with ${clause} { }
}`;

const repoOnly = (body: string) => `
system S {
  subdomain Sub { context C {
${body}
  } }
}`;

/** A deployable-bearing system — needed by the checks that read the deployment
 *  side (auth wiring, persistence mode) rather than the declaration alone. */
const deployed = (agg: string) => `
system P {
  subdomain D {
    context Orders {
${agg}
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}`;

/** A frontend SPA deployable that declares no `ui:` — the four
 *  `loom.<platform>-deployable-missing-ui` codes differ only in the platform
 *  they name, and stay four codes because the fix-hint registry dispatches on
 *  them per platform (`src/language/fix-hints.ts` → `missingUiFix`). */
const spaMissingUi = (platform: string) => `
system P {
  subdomain D { context Orders {
    aggregate Order with crudish { name: string }
    repository Orders for Order { }
  } }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable api { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
  deployable web { platform: ${platform} targets: api port: 3001 }
}`;

/**
 * code → the `.ddd` source that must raise it.
 *
 * A fixture asserts ONE code.  It may legitimately raise others (an
 * `index-suggestion` hint, a second error the same defect implies); the
 * assertion is containment, not equality, because pinning the full diagnostic
 * set would turn every unrelated validator change into a failure here.
 */
/** A ui-bearing system: the page-identity checks read the UI declaration AND
 *  the react deployable that serves it, so neither half can be dropped.  The
 *  `with` clause matters too — both collision codes fire when an AUTHORED page
 *  lands on a slot/path the SCAFFOLD also fills, so the fixture needs both. */
const uiPages = (withClause: string, uiBody: string) => `
system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  derived display: string = code }
    repository Orders for Order { }
    workflow ship {
      create(code: string) { precondition code.length > 0 }
    }
  } }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  ui WebApp${withClause} {
    api Sales: SalesApi
${uiBody}
  }
  deployable api { platform: node, contexts: [Orders], dataSources: [st], serves: SalesApi, port: 8080 }
  deployable web { platform: react, targets: api, ui: WebApp { Sales: api }, port: 3001 }
}`;

const FIRING_FIXTURES: Record<string, string> = {
  // --- structural ---------------------------------------------------------
  "loom.duplicate-find": repoOnly(`    aggregate Thing with crudish { name: string }
    repository Things for Thing {
      find byName(n: string): Thing[] where this.name == n
      find byName(n: string): Thing[] where this.name == n
    }`),

  // An abstract inheritance base owning its own `contains`.  The part's table
  // would have no reader and no writer — the base has no repository and the
  // concretes do not inherit its parts.  This was a `persistence: mikroorm`-only
  // reject until the shape was generated on every other target and the output
  // read: silently dropped on drizzle / efcore / python / java, a dead FK'd
  // table on dapper, and a 500-producing half-emission on elixir (schema +
  // `has_many` + a serializing controller, no migration, no preload).
  "loom.abstract-aggregate-contains":
    repoOnly(`    abstract aggregate Party inheritanceUsing: sharedTable {
      name: string
      contains addresses: Address[]
      entity Address { street: string }
    }
    aggregate Customer extends Party with crudish { creditLimit: int }
    repository Customers for Customer { }`),

  // --- variant match (structural-checks + the AST-level subject rule) ------
  "loom.match-unknown-variant": unionMatch(
    `outcome { Order o => o.code, Other x => x.resource, else => "" }`,
  ),
  "loom.match-duplicate-variant": unionMatch(
    `outcome { Order o => o.code, Order p => p.code, NotFound => "" }`,
  ),
  "loom.match-non-exhaustive": unionMatch(`outcome { Order o => o.code }`),
  "loom.match-subject-not-simple": unionMatch(
    `Orders.byCode(code) { Order o => o.code, NotFound => "" }`,
  ),

  // --- retrieval `where` --------------------------------------------------
  "loom.retrieval-where-unknown-field": repoOnly(`    aggregate Thing with crudish {
      name: string
      derived shouty: string = name
    }
    repository Things for Thing { }
    retrieval Loud() of Thing { where: this.shouty == "X" }`),
  "loom.retrieval-where-column-column":
    repoOnly(`    aggregate Thing with crudish { name: string  other: string }
    repository Things for Thing { }
    retrieval Same() of Thing { where: name == other }`),

  // --- projection `where` -------------------------------------------------
  // A projection's `where` is a selection position too — it is pushed down to
  // SQL by every backend — so it carries the same queryable-subset contract as
  // the find / retrieval twins above.  Arithmetic does not lower: node/drizzle
  // threw an internal error at generate time and the direct-table paths dropped
  // the filter silently (an endpoint returning every row) until this gate.
  "loom.projection-where-not-queryable":
    repoOnly(`    aggregate Order with crudish { lineCount: int }
    repository Orders for Order { }
    projection SalesTotals {
      orders: int
      from Order as o
      where o.lineCount + 1 > 5
      select orders = count
    }`),

  // --- macro expansion (phase ②) ------------------------------------------
  "loom.macro-arg-missing": uiWith("scaffoldAggregate()"),
  "loom.macro-arg-duplicate": uiWith("scaffoldAggregate(of: Thing, of: Thing)"),
  "loom.macro-arg-kind-mismatch": uiWith(`scaffoldAggregate(of: "Thing")`),
  "loom.capability-host-invalid": uiWith("auditable"),

  // --- handler body (#2659) -----------------------------------------------
  // An OPTIONAL repository read bound in a handler body.  The shared workflow
  // statement vocabulary the body renders through has no null-handling arm, so
  // before the gate this emitted an unguarded dereference (TS18047 / CS8602) in
  // the generated project.  The workflow twin refuses the same load.
  "loom.handler-load-nullable-unsupported": deployed(`      aggregate Order {
        code: string
        status: string
      }
      repository Orders2 for Order {
        find byCode(c: string): Order? where code == c
      }
      queryHandler CodeStatus(c: string): string {
        let o = Orders2.byCode(c)
        return o.status
      }`),

  // --- lifecycle gates (M-T3.16) ------------------------------------------
  // These three arrived on `main` AFTER the 2026-08-13 census and were caught
  // by this gate on the very next run, with no firing proof between them —
  // which is the whole reason it exists.
  "loom.guard-principal-without-auth": deployed(`      aggregate Order {
        code: string
        create(code: string) { requires currentUser.role == "admin"  code := code }
      }`),
  "loom.named-lifecycle-dropped": deployed(`      aggregate Order {
        code: string
        create(code: string) { code := code }
        create draft(code: string) { code := code }
      }`),
  // --- workflow instance-read gate (M-T3.15 §A2) --------------------------
  // The header gate runs BEFORE any instance is loaded, so only `currentUser`
  // is in scope; `stage` is a workflow STATE field and has no value to read.
  // It is lowered in the bare context env precisely so such a reference cannot
  // silently resolve — this turns that into a diagnostic.
  "loom.workflow-gate-not-current-user": `
system S {
  user { id: guid  role: string }
  subdomain Sales { context Orders {
    aggregate Order { code: string }
    repository Orders for Order { }
    workflow Fulfilment requires stage == "started" {
      orderId: Order id
      stage: string
      create start(order: Order id) { orderId := order  stage := "started" }
    }
  } }
  api Api from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [Orders]
    dataSources: [st]
    serves: Api
    port: 3000
    auth: required
  }
}`,

  // A query-time projection whose direct-table arm aggregates a field that has
  // no column: the source is `shape: document`, so `total` lives inside the
  // `data` jsonb blob and `sum(o.total)` names nothing.  Universal, not
  // per-backend — every backend emitted the missing reference.
  "loom.projection-columnless-source": `
system S {
  subdomain Sales { context Orders {
    aggregate Order shape: document, with crudish { code: string  total: int }
    repository Orders for Order { }
    projection OrderVolume {
      revenue: int
      from Order as o
      select revenue = sum(o.total)
    }
  } }
  api Api from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] serves: Api port: 3000 }
}`,

  // A ROW COUNT over a `shape: document` source — which the column gate above
  // deliberately allows, since a document table does have an `id` column —
  // whose aggregate is read-filtered by `tenantOwned` + `softDeletable`.  Those
  // predicates name `tenant_id` / `is_deleted`, which the `(id, data, version)`
  // triple has not: four backends emit the missing reference and EF Core emits
  // no filter at all, counting every tenant's rows.
  "loom.projection-document-source-capability-filtered": `
system S {
  user { id: guid  org: string }
  tenancy by user.org of Tenant
  subdomain Sales { context Orders {
    aggregate Tenant with tenantRegistry, crudish { slug: string }
    aggregate Order shape: document, with tenantOwned, softDeletable, crudish { code: string }
    repository Tenants for Tenant { }
    repository Orders for Order { }
    projection OrderVolume {
      rows: int
      from Order as o
      select rows = count()
    }
  } }
  api Api from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] serves: Api port: 3000 auth: required }
}`,

  // --- inheritance × capability (the TPH cluster) --------------------------

  // A TPH SUBTYPE whose capability `filter` reads a column only that subtype
  // declares.  EF Core registers a query filter on the hierarchy ROOT entity
  // type only, and a root-typed lambda has no such member — the one shape of
  // TPH filter .NET structurally cannot express.  Before the gate the whole
  // filter list was replaced by `[]` for every TPH participant, so the read
  // restriction vanished from the emitted queries with no error at all.
  "loom.tph-filter-unsupported": `
system S {
  subdomain Fleet { context Vehicles {
    criterion Live of Car = this.doors > 0
    abstract aggregate Vehicle { name: string }
    aggregate Car extends Vehicle with crudish { doors: int  filter Live }
    repository Cars for Car { }
  } }
  api Api from Fleet
  storage pg { type: postgres }
  resource st { for: Vehicles, kind: state, use: pg }
  deployable d { platform: dotnet contexts: [Vehicles] dataSources: [st] serves: Api port: 8080 }
}`,

  // A subtype taking the OPPOSITE tenancy stance from the base it inherits its
  // columns from.  The base capability still contributes `tenant_id NOT NULL`
  // to the row; `crossTenant` means nothing stamps or filters it.  This parsed
  // 0 errors on all five backends, and it is the exact spelling the old
  // `loom.tenancy-stance-unmarked` message recommended.
  "loom.tenancy-inherited-stance-conflict": `
system S {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Org
  subdomain Fleet { context Vehicles {
    aggregate Org with crudish { title: string }
    abstract aggregate Vehicle with tenantOwned { name: string }
    aggregate Car extends Vehicle crossTenant with crudish { doors: int }
    repository Cars for Car { }
    repository Orgs for Org { }
  } }
  api Api from Fleet
  storage pg { type: postgres }
  resource st { for: Vehicles, kind: state, use: pg }
  deployable d { platform: node contexts: [Vehicles] dataSources: [st] serves: Api port: 3000 auth: required }
}`,

  // A frontend deployable whose ui READS `currentUser` while the ui is not
  // served under auth (`auth: ui` absent) — arrived on `main` mid-PR, same as
  // the three above.
  "loom.current-user-needs-auth-ui": `
system S {
  user { id: guid  role: string }
  auth { oidc { issuer: "https://idp.example.com"  clientId: "app" } }
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    api C: Api
    page Home { route: "/" body: Text { currentUser.role } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 auth: required }
  deployable web { platform: static targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // A repository read used as a MEMBER RECEIVER never lowers to a `repo-read`
  // (the detector wants the whole chain), so no read port is threaded in and
  // every backend emits the bare repository name.
  "loom.domain-service-read-unsupported":
    repoOnly(`    aggregate Customer with crudish { tier: string }
    repository Customers for Customer {
      find byTier(tier: string): Customer? where this.tier == tier
    }
    domainService Lookup {
      operation tierOf(t: string): string { return Customers.byTier(t).tier }
    }`),

  // The parse-but-no-emit meta-warning (M-T5.9).  `connection:` reaches the IR
  // and no generator reads it — the emitted compose / k8s wiring is derived
  // heuristically from the compose host instead.
  "loom.reserved-not-emitted": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
    repository Things for Thing { }
  } }
  storage pg { type: postgres, connection: env("DB_URL") }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`,

  // `shape:` is read nowhere on an event-sourced aggregate — every backend's
  // schema emitter short-circuits on `persistedAs: eventLog` first — so the
  // clause parsed clean and generated byte-identical output.
  "loom.shape-on-event-sourced": repoOnly(`    event Opened { account: Account id, owner: string }
    aggregate Account persistedAs: eventLog shape: document {
      owner: string
      create open(owner: string) { emit Opened { account: id, owner: owner } }
      apply(e: Opened) { owner := e.owner }
    }
    repository Accounts for Account { }`),

  "loom.lifecycle-guard-event-sourced": deployed(`      event Made { order: Order id, code: string }
      aggregate Order persistedAs: eventLog {
        code: string
        create(code: string) { requires 1 == 1  emit Made { order: id, code: code } }
        apply(e: Made) { code := e.code }
      }`),

  // `Slot { }` is a placement contract — only a `component` body has a caller
  // whose children it can render; in a PAGE body it is an unbound reference.
  "loom.slot-outside-component": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    framework: react
    api C: Api
    page Home { route: "/"  body: Stack { Slot { } } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: static targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // --- backend-capability gates, driven by their UNHOSTED arm --------------
  // These three read as "your backend can't do this", and the census read them
  // as undrivable because every backend family IS in their capability set.
  // But each carries a second arm their siblings don't: `!anyBackend` — no
  // db-owning deployable hosts the context at all — and that arm is one
  // deployable-less system away.  It is the arm that matters, too: it is what
  // stops an event-sourced / provenanced / audited declaration from being
  // written, parsed, and then hosted by nothing that could honour it.
  "loom.event-sourcing-backend-unsupported":
    repoOnly(`    event Opened { account: Account id, owner: string }
    aggregate Account persistedAs: eventLog {
      owner: string
      create open(owner: string) { emit Opened { account: id, owner: owner } }
      apply(e: Opened) { owner := e.owner }
    }
    repository Accounts for Account { }`),
  "loom.provenanced-backend-unsupported": repoOnly(`    aggregate Order with crudish {
      total: int provenanced
    }`),
  "loom.audited-backend-unsupported": repoOnly(`    aggregate Order with crudish {
      code: string
      operation dispatch() audited { code := "x" }
    }`),
  // Needs the DEPLOYMENT side: the refusal is per-backend (node emits only the
  // void-204 handler for an audited RETURNING operation; python emits both),
  // so a declaration-only system raises nothing.
  "loom.audited-returning-operation-unsupported": deployed(`      error NotFound { message: string }
      aggregate Order with crudish {
        qty: int
        operation take(n: int) audited : Order or NotFound {
          qty := qty - n
          return this
        }
      }`),
  // A FOURTH of the same shape, found by reading `validateFieldMask` for the
  // `anyBackend` arm rather than trusting `FIELD_MASK_BACKENDS` (which does
  // list all five families).  `mask unless` on a context nothing hosts is the
  // drivable case, so this belongs here and not in the pins beside its
  // set-shaped siblings — the distinction the pin block warns about, caught in
  // the act.  The gate needs a `user {}` block for `currentUser` to resolve.
  "loom.field-mask-unsupported": `
system S {
  user { id: string  role: string }
  subdomain Sub { context C {
    aggregate Order with crudish {
      code: string
      total: int mask unless currentUser.role == "admin"
    }
    repository Orders for Order { }
  } }
}`,
  // `Tab` / `Column` are `group: "sub"` primitives — the parent consumes them
  // inline, so anywhere else they degrade to a comment on all seven targets.
  // --- workflow-checks.ts --------------------------------------------------
  // M-T9.19 recorded FOUR of this file's codes as unemittable from source.
  // Driving each one instead of re-reading the note found that claim wrong for
  // `loom.workflow-name-collision`: its stated preemption ("by
  // `loom.duplicate-workflow`") does not hold, because the two gates test
  // different things — `duplicate-workflow` fires on a REPEATED workflow name,
  // `workflow-name-collision` on a clash with an aggregate / value object /
  // enum / event / repository, and a workflow named after an aggregate trips
  // only the second.  The other three are confirmed preempted and pinned below.
  "loom.duplicate-workflow": repoOnly(`    aggregate Thing with crudish { name: string }
    repository Things for Thing { }
    workflow Dup { create(n: string) { precondition n.length > 0 } }
    workflow Dup { create(n: string) { precondition n.length > 0 } }`),
  "loom.workflow-name-collision": repoOnly(`    aggregate Thing with crudish { name: string }
    repository Things for Thing { }
    workflow Thing { create(n: string) { precondition n.length > 0 } }`),
  // The code whose "covered by message in validation.test.ts" claim outlived
  // the file it cited (M-T9.33's own opening finding).  It fires: an `emit`
  // supplying a field the event does not declare.
  "loom.workflow-emit-unknown-field": repoOnly(`    aggregate Thing with crudish { name: string }
    repository Things for Thing { }
    event Happened { thing: Thing id, label: string }
    workflow W {
      create(n: string) { emit Happened { thing: id, label: n, bogus: n } }
    }`),
  // `Repo.run(<Retrieval>(args))` naming a retrieval the context does not
  // declare.  Its repository-side sibling is NOT drivable — an unknown
  // repository name never lowers to a `repo-run` at all — so only this half
  // gets a fixture.  Control: the same source with `ActiveOrders()` raises
  // nothing, which is what makes the fixture's single diagnostic meaningful.
  "loom.workflow-run-unknown-retrieval":
    repoOnly(`    aggregate Order with crudish { code: string  archived: bool }
    criterion Active of Order = !this.archived
    retrieval ActiveOrders() of Order { where: Active  sort: [code asc] }
    repository Orders for Order { }
    workflow W {
      create(n: string) { let batch = Orders.run(Nope()) }
    }`),

  // --- the last singletons, each DRIVEN before being classified -----------
  // An applier body is a pure fold; a CALL statement in one is the impurity.
  // (Raises several event-sourcing codes together — the assertion is
  // containment, so a fixture may legitimately trip more than its own.)
  "loom.applier-impure-call": repoOnly(`    event Opened { account: Account id }
    aggregate Account persistedAs: eventLog {
      owner: string
      operation touch() { owner := "x" }
      create open(owner: string) { emit Opened { account: id } }
      apply(e: Opened) { touch() }
    }
    repository Accounts for Account { }`),

  // A resource op whose capability the bound storage does not offer.
  // `localDisk` offers objectStore{blob,list}; `signedUrl` is s3-only — so the
  // SAME source on `type: s3` does not raise this code, which is what makes
  // the fixture discriminating rather than incidental.
  "loom.resource-missing-capability": `
system S {
  subdomain Sub { context C {
    aggregate Doc with crudish { name: string }
    repository Docs for Doc { }
    workflow W {
      create(k: string) { let u = Blobs.signedUrl(k) }
    }
  } }
  storage pg { type: postgres }
  storage files { type: localDisk }
  resource st { for: C, kind: state, use: pg }
  resource Blobs { for: C, kind: objectStore, use: files }
  deployable api { platform: node contexts: [C] dataSources: [st, Blobs] port: 3000 }
}`,

  // A UI-mounting deployable whose form would need a Select picker for an
  // `X id` naming no aggregate in the system.  Needs the ui + react deployable
  // — a backend-only system never reaches the id-reference walk.
  "loom.ui-id-ref-unknown-aggregate": `
system S {
  subdomain Sub { context C {
    aggregate Order with crudish { code: string  buyer: Ghost id }
    repository Orders for Order { }
  } }
  api A from Sub
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  ui W { api Sales: A }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: react targets: api ui: W { Sales: api } port: 3001 }
}`,

  "loom.sub-primitive-misplaced": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    framework: react
    api C: Api
    page Home { route: "/"  body: Stack { Tab("one") } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: static targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // The `persist:` ladder now ships on EVERY frontend, so the platform-wide arm
  // of this code is gone; what remains is field-scoped.  Persistence on feliz
  // and flutter crosses an untyped boundary per field, so a cell whose type has
  // no total conversion in that language's codec (here a `datetime` on feliz)
  // is refused rather than silently dropped from the stored blob.
  "loom.store-lifetime-target-unsupported": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    framework: feliz
    api C: Api
    store Cart persist: local { state { seenAt: datetime } }
    page Home { route: "/"  body: Stack { Heading { "hi", level: 3 } } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // A resource handle is ambient over the whole context, but only the
  // application-layer emitters (workflow / command+query handler) have the
  // resource client in scope — a domainService body is rejected too.
  "loom.resource-op-outside-workflow": `
system S {
  subdomain Sub { context C {
    aggregate Thing {
      name: string
      operation archive() { files.put("t/" + this.name, this.name) }
    }
    repository Things for Thing { }
  } }
  api Api from Sub
  storage pg { type: postgres }
  storage blobs { type: s3, config: { bucket: "b" } }
  resource st { for: C, kind: state, use: pg }
  resource files { for: C, kind: objectStore, use: blobs }
  deployable api {
    platform: node
    contexts: [C]
    dataSources: [st, files]
    serves: Api
    port: 3000
  }
}`,
  // A domainService's `reading` tier is scoped to its OWN context: a body
  // naming another context's repository never lowers to a `repo-read`, so all
  // five backends render the unresolved receiver verbatim.
  "loom.domain-service-cross-context-read": `
system S {
  subdomain Sub {
    context Billing {
      aggregate Customer { name: string }
      repository Customers for Customer {
        find byName(name: string): Customer? where this.name == name
      }
    }
    context Ordering {
      aggregate Order { ref: string }
      repository Orders for Order { }
      domainService Naming {
        operation isFree(r: string): bool { return Customers.byName(r) == null }
      }
    }
  }
}`,

  // An unresolved bare ref in a rendered slot: the walker emits a comment and
  // the content silently disappears on all six frontends (A17).
  "loom.unresolved-page-ref": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    framework: react
    api C: Api
    page Home { route: "/"  body: Text { nosuchthing } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: static targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // `Stat(label, value)` is a fixed two-slot shape, not a children container —
  // a third positional is rendered by no design pack (A7's arity half).
  "loom.page-primitive-extra-children": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    framework: react
    api C: Api
    page Home { route: "/"  body: Stat { "Revenue", "10", Text { "extra" } } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: static targets: api ui: WebApp { C: api } port: 3001 }
}`,
  // --- frontend deployable without a `ui:` binding ------------------------
  "loom.react-deployable-missing-ui": spaMissingUi("react"),
  "loom.svelte-deployable-missing-ui": spaMissingUi("svelte"),
  "loom.vue-deployable-missing-ui": spaMissingUi("vue"),
  "loom.angular-deployable-missing-ui": spaMissingUi("angular"),
  // The two SELF-HOSTING frontends (own build toolchain, not the static-bundle
  // pipeline) were missing from the rule entirely: feliz crashed codegen with a
  // raw `Error`, flutter emitted a placeholder app at exit 0.
  "loom.feliz-deployable-missing-ui": spaMissingUi("feliz"),
  "loom.flutter-deployable-missing-ui": spaMissingUi("flutter"),
  // --- `ui:` on a platform that mounts no UI (Rule 3) ---------------------
  "loom.ui-binding-unmountable-platform": `
system P {
  subdomain D { context Orders {
    aggregate Order with crudish { name: string }
    repository Orders for Order { }
  } }
  ui WebApp { }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable api { platform: node contexts: [Orders] dataSources: [st] ui: WebApp port: 3000 }
}`,

  // A `match await` in a COMPONENT action, on a Flutter-hosted ui: the Flutter
  // component emitter filters such a component out entirely (no widget, every
  // call site an empty `SizedBox.shrink()`), so the gate makes the drop honest.
  "loom.flutter-async-effect-unsupported": `
system P {
  subdomain D { context C {
    aggregate Order with crudish { customerId: string
      operation reserve(): Order { return this }
    }
  } }
  api Api from D
  ui WebApp {
    api C: Api
    component Confirmer(order: Order) {
      state { note: string = "" }
      action go() {
        match await C.Order.reserve() {
          Order o => { note := o.customerId }
          else    => { note := "x" }
        }
      }
      body: Button { "Go", onClick: go }
    }
    page Detail(id: Order id) {
      route: "/orders/:id"
      body: Confirmer(order: C.Order.byId(id))
    }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable app { platform: flutter targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // A `slot` param on a WALKED component, on an Angular-hosted ui: the Angular
  // component emitter filters such a component out entirely (no class file, and
  // every call site keeps `<!-- unknown layout component: Panel -->`), because
  // `ngComponentOutletInputs` sets INPUTS and has no content-projection channel.
  "loom.user-component-deferred-target": `
system P {
  subdomain D { context C {
    aggregate Order with crudish { customerId: string }
  } }
  api Api from D
  ui WebApp {
    api C: Api
    component Panel(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { Panel(head: Text { "hi" }) } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable app { platform: angular targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // A `toast(<expr>)` outside the v1 message subset every realtime renderer
  // implements — two-level member access off the event binding.  Without the
  // gate this aborts `ddd generate system` with a raw Error from
  // `renderMessageExpr` / `renderFsToastMessage` / `renderMessageExprElixir`.
  "loom.toast-message-unsupported": `
system P {
  subdomain D { context C {
    aggregate Order with crudish { customerId: string }
    event OrderPlaced { order: Order id, at: datetime }
    channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
  } }
  api Api from D
  ui WebApp {
    api C: Api
    channel Live: C.Lifecycle
    on Live.OrderPlaced(e) { toast(e.order.id) }
    page Home { route: "/" body: Stack { Heading { "home" } } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable app { platform: react targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // `display`/`inspect` are reserved derived names that only mean something on
  // an aggregate — on a value object they are rejected.
  "loom.reserved-derived-on-vo": repoOnly(`    valueobject Money {
      amount: int
      derived display: string = "x"
    }`),

  // --- hand-authored `area` identity (the clause census's `Area` fixture) --
  // All three arrived with the page-identity fix and are the next instance of
  // the pattern the lifecycle trio above records: a code landing on `main` with
  // no proof it fires.  Shapes taken from `test/ir/ui-page-identity-gate.test.ts`.
  //
  // Two `area Ops` blocks in ONE scope: uniqueness was scoped per Area NODE, so
  // both pages computed `src/pages/ops/…` and the second silently won.
  "loom.ui-duplicate-area": uiPages(
    "",
    `    area Ops {
      page Dashboard { route: "/ops/a" body: Stack { Heading { "A", level: 1 }, testid: "a" } }
    }
    area Ops {
      page Overview { route: "/ops/b" body: Stack { Heading { "B", level: 1 }, testid: "b" } }
    }`,
  ),

  // The author's `area Sales { area Orders { page List } }` and the SCAFFOLD's
  // `area Orders { page List }` both classify as aggregate Order's list page.
  // Only one can be routed; the other was emitted as an unreachable file.
  //
  // NOTE two sibling areas holding same-named pages is NOT this defect — that
  // is the documented silent case, and using it here made the fixture raise
  // nothing at all.
  "loom.ui-page-slot-collision": uiPages(
    " with scaffold(aggregates: [Order])",
    `    area Sales {
      area Orders {
        page List {
          route: "/orders"
          body: Stack { Heading { "Mine", level: 1 }, testid: "mine" }
        }
      }
    }`,
  ),

  // `area Workflows { page Ship }` lands on `src/pages/workflows/ship.tsx` —
  // exactly where the scaffold's `ShipWorkflow` page goes.  The two classify
  // DIFFERENTLY, so only the path check sees this one.
  "loom.ui-page-path-collision": uiPages(
    " with scaffold(workflows: [ship])",
    `    area Workflows {
      page Ship {
        route: "/workflows/ship-custom"
        body: Stack { Heading { "Ship", level: 1 }, testid: "ship" }
      }
    }`,
  ),

  // --- seed crossings (F2-SEED-*, validators/seed.ts rules 5-8) -------------
  // Each of these parsed 0 errors / 0 warnings before the rule existed and
  // then produced a DIFFERENT wrong artefact per backend.
  "loom.seed-dataset-name-collision": repoOnly(`    aggregate Widget with crudish { name: string }
    repository Widgets for Widget { }
    seed default { Widget { name: "a" } }
    seed Default { Widget { name: "b" } }`),
  "loom.seed-raw-document-shape":
    repoOnly(`    aggregate Article shape: document, with crudish { title: string }
    repository Articles for Article { }
    seed wired raw { Article { id: "11111111-1111-1111-1111-111111111111", title: "Anchor" } }`),
  "loom.seed-event-sourced-unsupported":
    repoOnly(`    event Opened { account: Account id, owner: string }
    aggregate Account persistedAs: eventLog {
      owner: string
      create open(owner: string) { emit Opened { account: id, owner: owner } }
      apply(e: Opened) { owner := e.owner }
    }
    repository Accounts for Account { }
    seed default { Account { owner: "seeded-alice" } }`),
  "loom.seed-abstract-aggregate": repoOnly(`    abstract aggregate Base { name: string }
    aggregate Child extends Base with crudish { extra: int }
    repository Children for Child { }
    seed default { Base { name: "x" } }`),
  "loom.seed-tenant-owned-needs-raw": `
system S {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Org
  subdomain Sub { context C {
    aggregate Invoice with tenantOwned, crudish { label: string }
    aggregate Org with crudish { name: string }
    repository Invoices for Invoice { }
    seed default { Invoice { label: "Seeded" } }
  } }
}`,
};

/**
 * code → why it cannot be driven from `.ddd` source at all.
 *
 * A pin is a REVIEWED claim, not a TODO — "I could not write a fixture" belongs
 * in UNCOVERED.  Each entry must say what preempts the arm, so the next reader
 * can re-test the claim instead of inheriting it.
 */
const UNREACHABLE_PINS: Record<string, string> = {
  // The four below share ONE structure, and it is worth naming once: each gate
  // filters the platforms hosting a context against a SUPPORTED set, and
  // returns/skips when nothing is left over.  The hosting platforms come from
  // `backendPlatformsHostingEachContext` (system-checks.ts), which admits only
  // deployables whose descriptor has `needsDb: true` — exactly
  // {node, dotnet, elixir, python, java} in `PLATFORM_DESCRIPTORS`
  // (src/platform/metadata.ts), and always the bareword FAMILY, since
  // `qualifyPlatform` strips a `family@version` pin before the IR stores it.
  // So when a gate's supported set literal already lists all five families, the
  // difference is empty for every parseable source and the arm cannot be
  // reached.  Each pin below names the literal to re-test against: widen the
  // platform roster (a sixth backend family) or narrow one of these sets, and
  // the pin stops being true — which is the re-test the next reader is owed.
  "loom.projection-query-time-unsupported":
    "`PROJECTION_QT_SUPPORTED` (system-checks.ts) = {node, python, elixir, java, dotnet} — all " +
    "five backend families, and `validateQueryTimeProjectionBackend` skips any deployable that " +
    "is either not `platformOwnsBackend` or in that set, so no deployable can reach the push. " +
    "It was the honest gate while the query-time read was being ported one backend at a time " +
    "(node PR-C … dotnet PR-G); the port finished and left the arm latent.",
  "loom.saving-shape-unsupported":
    "`SavingShape` has exactly three members (loom-ir.ts: relational | embedded | document) and " +
    "`PLATFORM_SAVING_SHAPES` (util/platform-axes.ts) gives every backend family all three once " +
    "`validateSavingShapeSupport`'s elixir branch adds `document` to that family's " +
    "{relational, embedded} — so `supported.includes(shape)` holds for every (family, shape) " +
    "pair.  Delete the elixir widening, or add a fourth shape, and this fires again.",
  "loom.union-unsupported":
    "`SUPPORTED_UNION_BACKENDS` (structural-checks.ts, `validateUnionsUnimplemented`) = " +
    "{node, dotnet, elixir, python, java} — all five families — and the function returns early " +
    "on an empty `unsupported`, with no `no backend at all` arm (unlike its event-sourcing / " +
    "audited / provenanced siblings, which DO fire on an unhosted context and are therefore " +
    "driven by real fixtures above).  The staged rollout it gated (P4b hono, P4c dotnet, P4d " +
    "phoenix) is complete.",
  "loom.when-unsupported":
    "`SUPPORTED_WHEN_BACKENDS` (structural-checks.ts, `validateWhenGateSupport`) = " +
    "{node, dotnet, python, elixir, java} — all five families — and the function returns early " +
    "on an empty `unsupported`.  Its own doc comment already calls the guard `latent`, kept as " +
    "the safety net for a future backend that lands before its `when` emitter; this pin records " +
    "that the net currently catches nothing.",

  // --- the same latent-set shape, but CHECKED -------------------------------
  // Each of the ten below is registered in `LATENT_GATES`, so the set it names
  // is re-read on every run rather than trusted from this prose.  Each was
  // read for an `anyBackend` second arm first — the arm that makes
  // `loom.field-mask-unsupported` drivable and therefore a fixture, not a pin.
  "loom.paged-query-handler-unsupported-backend":
    "`PAGED_QH_SUPPORTED` covers every backend-owning platform, and " +
    "`validatePagedQueryHandlerBackends` skips a deployable that is either not " +
    "`platformOwnsBackend` or in that set.  Checked by `LATENT_GATES`.",
  "loom.projection-whole-table-aggregation-unsupported":
    "`PROJECTION_AGG_SUPPORTED` covers every backend-owning platform; the gate skips on " +
    "`!platformOwnsBackend(d.platform) || SET.has(d.platform)`.  Checked by `LATENT_GATES`.",
  "loom.projection-groupby-unsupported-backend":
    "`PROJECTION_GROUPBY_SUPPORTED` covers every backend-owning platform, same skip shape as " +
    "its whole-table sibling.  Checked by `LATENT_GATES`.",
  "loom.projection-workflow-source-unsupported-backend":
    "`PROJECTION_WF_SOURCE_SUPPORTED` covers every backend-owning platform, same skip shape.  " +
    "Checked by `LATENT_GATES`.",
  "loom.projection-source-unsupported-backend":
    "`PROJECTION_PROJ_SOURCE_SUPPORTED` covers every backend-owning platform, same skip shape.  " +
    "Checked by `LATENT_GATES`.",
  "loom.filter-bypass-unsupported":
    "`bypassSupported(dep)` is `FILTER_BYPASS_FAMILIES.has(family)` and that set covers every " +
    "backend-owning platform; a frontend deployable `continue`s before reaching the check, so " +
    "no deployable can reach the `!supported` push.  Checked by `LATENT_GATES`.",
  "loom.event-sourced-workflow-unsupported":
    "`EVENT_SOURCING_WORKFLOW_BACKENDS` covers every backend-owning platform and " +
    "`validateEventSourcedWorkflowStorage` returns on an empty `unsupported`.  Unlike its " +
    "event-sourced AGGREGATE sibling it has NO `anyBackend` arm — which is exactly why that " +
    "sibling is driven by a fixture and this one is pinned.  Checked by `LATENT_GATES`.",
  "loom.generic-carrier-unsupported":
    "`SUPPORTED_PAGED_BACKENDS` (structural-checks.ts) covers every backend-owning platform and " +
    "`validateGenericCarrierSupport` returns on an empty `unsupported`; its own comment records " +
    "that a context served by no backend is emittable and stays quiet, so there is no second " +
    "arm.  Checked by `LATENT_GATES`.",
  "loom.operation-return-unsupported":
    "`SUPPORTED_RETURN_BACKENDS` (structural-checks.ts) covers every backend-owning platform and " +
    "the loop `continue`s on an empty `unsupported`; the no-backend case is documented as " +
    "deliberately quiet.  A bare scalar return is not gated at all.  Checked by `LATENT_GATES`.",
  "loom.remote-api-op-unsupported":
    "`REMOTE_API_OP_UNSUPPORTED` is the EMPTY set and the gate fires only for its members " +
    "(`if (!REMOTE_API_OP_UNSUPPORTED.has(dep.platform)) continue`), so every platform skips.  " +
    "Checked by `LATENT_GATES`.",
  "loom.flutter-primitive-unsupported":
    "`FLUTTER_UNRENDERED_PRIMITIVES` is the EMPTY set — every page primitive has a Flutter " +
    "renderer today — and the gate only rejects a primitive that is a member.  Its own source " +
    "comment calls it a dormant safety net the gate re-arms from.  Checked by `LATENT_GATES`.",

  // --- workflow-checks.ts, the three M-T9.19 claims that HELD ---------------
  // Each was re-driven rather than inherited.  All three are preempted by
  // SCOPE resolution: the unknown name is reported as `loom.unknown-name`
  // during linking, and the statement never lowers to the `factory-let` /
  // `repo-let` / `repo-run` kind whose arm carries these codes — so the arm
  // switches on a shape that cannot exist.  Re-test by making the lowerer emit
  // the typed statement kind for an unresolved name (it currently degrades to a
  // generic `expr-let`), which is the change that would re-arm all three at once.
  "loom.workflow-create-unknown-aggregate":
    "`Nope.create({…})` in a workflow raises `loom.unknown-name` at link time and lowers to a " +
    "generic `expr-let`, never the `factory-let` this arm switches on.  Driven and confirmed: " +
    "the only code out of `validate()` is `loom.unknown-name`.",
  "loom.workflow-unknown-repository":
    "`Missing.getById(x)` in a workflow raises `loom.unknown-name` and lowers to a generic " +
    "`expr-let`, never the `repo-let` this arm switches on.  Driven and confirmed.",
  "loom.workflow-run-unknown-repository":
    "`Missing.run(ActiveOrders())` raises `loom.unknown-name` and never lowers to a `repo-run`, " +
    "so the repository half of that arm is unreachable — while its RETRIEVAL half is drivable " +
    "(`Orders.run(Nope())`) and has a fixture.  Both halves driven; only this one is dead.",
  "loom.isolation-requires-transactional":
    "The gate calls itself defence-in-depth against a future grammar change, and the grammar " +
    "still gates `isolation:` behind `transactional`: a workflow carrying `isolation:` alone is " +
    "a PARSE error, so no model reaches the IR with `wf.isolation && !wf.transactional`.  " +
    "Driven and confirmed: the only code out of `validate()` is `loom.parse-error`.  Re-test by " +
    "ungating `isolation:` in `ddd.langium`.",

  // --- the last three singletons -------------------------------------------
  "loom.cross-aggregate-entity-part":
    "The arm needs a RESOLVED entity-part owned by a different aggregate, and `ddd-scope.ts` " +
    "restricts containment part types to entity parts declared in the SAME aggregate (the rule " +
    "CLAUDE.md states as `cross-aggregate references must use X id`).  So the name never links " +
    "and the source reports `loom.linking-error` instead.  Driven and confirmed.  Re-test by " +
    "widening the containment part-type scope to sibling aggregates.",
  "loom.platform-knob-style-layout-mismatch":
    "Every platform's LAYOUT menu is a subset of what its style declares in `styleSupportedLayouts`, " +
    "so a layout that would mismatch is already out-of-menu and `loom.platform-knob-out-of-menu` " +
    "fires first (the gate's own comment says an unknown value 'already errored under R1').  " +
    "Checked by `the style/layout menus cannot disagree` below — and note the gate's comment " +
    "names elixir + `byLayer` as the way to reach it, which does NOT work for exactly this " +
    "reason: `byLayer` is not in elixir's menu at all.  Driven and confirmed.",
  "loom.ir-internal":
    "A catch-all: `irDiagnosticsFor` wraps the whole lower/enrich/validate pipeline and converts " +
    "a THROW into this code, so it fires only when the compiler crashes.  A `.ddd` that reaches " +
    "it is a compiler bug to fix, not a fixture to keep — pinning a crashing source here would " +
    "enshrine the crash as expected behaviour and make the fixture fail the day it is fixed.  " +
    "Re-test by removing the try/catch: every source that reaches it should be a bug report.",

  // --- defensive backstops for shapes scope already forbids ------------------
  "loom.java-workflow-instance-field-unsupported":
    "Fires on an ENTITY-typed field in a workflow's `instanceWireShape`.  An entity is a " +
    "containment part, and a part type never resolves in workflow scope (`ddd-scope.ts` " +
    "restricts part types to the owning aggregate), so no source can put one there.  " +
    "`validateJavaReadModelShapes` calls it a defensive backstop in its own comment.  Re-test " +
    "by widening part-type scope, or by making `wireLeafKind` report `entity` for a shape a " +
    "workflow CAN name.",
  "loom.java-projection-field-unsupported":
    "The projection twin of the workflow-instance backstop above: an ENTITY-typed field in a " +
    "projection's `wireShape`.  Same preemption — a containment part type does not resolve in " +
    "projection scope — and the same re-test.",
};

// ---------------------------------------------------------------------------
// LATENT CAPABILITY GATES — pins whose reason is CHECKED, not just written.
//
// The pins above are prose: a reader has to re-derive the claim by reading the
// validator.  That is the weak half of a pin, and it rots silently — the claim
// "this set lists all five families" stops being true the moment a sixth
// backend family lands, and nothing says so.
//
// These entries close that.  Each names the actual `Set` its gate consults, so
// the pin's reason is re-evaluated on every run:
//
//   "covers-every-backend" — the gate computes `unsupported = hosting \ SET`
//                            and returns/skips when that is empty.  Latent for
//                            as long as SET ⊇ every backend-owning platform.
//   "empty"                — the gate fires only for members of SET, and SET
//                            has none.  Latent until something is added.
//
// The backend-owning roster is not hardcoded here either: it is derived from
// `parseBuiltinPlatformRef`, the same predicate `platformOwnsBackend` uses, so
// registering a sixth backend family fails these pins on the next run and
// forces whoever added it to either port the feature or write a real fixture.
//
// WHAT THIS DOES NOT PROVE.  That a gate cannot fire *via this set* — not that
// it cannot fire at all.  Several sibling gates carry a SECOND arm ("no
// db-owning deployable hosts this context at all") which fires with the set
// fully satisfied; `loom.field-mask-unsupported` is exactly that shape and is
// therefore driven by a real fixture above, not pinned here.  Every entry below
// was read for that arm first.  A pin added without that read is a TODO wearing
// a pin's clothes — which is the failure mode the prose block above warns about
// in its own words.
// ---------------------------------------------------------------------------

/** Platforms that own a backend — the roster `platformOwnsBackend` admits. */
const BACKEND_OWNING = [
  "node",
  "dotnet",
  "python",
  "java",
  "elixir",
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "flutter",
  "static",
].filter((p) => parseBuiltinPlatformRef(p) !== null);

const LATENT_GATES: ReadonlyArray<{
  code: string;
  setName: string;
  set: ReadonlySet<string>;
  kind: "covers-every-backend" | "empty";
}> = [
  // system-checks.ts — the `!platformOwnsBackend(d.platform) || SET.has(...)`
  // skip shape.  No second arm: a context nothing hosts iterates zero
  // deployables, so the push is unreachable rather than reachable-with-a-
  // different-message.
  // Already pinned in prose above; listed here so the claim is re-checked.
  {
    code: "loom.projection-query-time-unsupported",
    setName: "PROJECTION_QT_SUPPORTED",
    set: PROJECTION_QT_SUPPORTED,
    kind: "covers-every-backend",
  },
  {
    code: "loom.paged-query-handler-unsupported-backend",
    setName: "PAGED_QH_SUPPORTED",
    set: PAGED_QH_SUPPORTED,
    kind: "covers-every-backend",
  },
  {
    code: "loom.projection-whole-table-aggregation-unsupported",
    setName: "PROJECTION_AGG_SUPPORTED",
    set: PROJECTION_AGG_SUPPORTED,
    kind: "covers-every-backend",
  },
  {
    code: "loom.projection-groupby-unsupported-backend",
    setName: "PROJECTION_GROUPBY_SUPPORTED",
    set: PROJECTION_GROUPBY_SUPPORTED,
    kind: "covers-every-backend",
  },
  {
    code: "loom.projection-workflow-source-unsupported-backend",
    setName: "PROJECTION_WF_SOURCE_SUPPORTED",
    set: PROJECTION_WF_SOURCE_SUPPORTED,
    kind: "covers-every-backend",
  },
  {
    code: "loom.projection-source-unsupported-backend",
    setName: "PROJECTION_PROJ_SOURCE_SUPPORTED",
    set: PROJECTION_PROJ_SOURCE_SUPPORTED,
    kind: "covers-every-backend",
  },
  // `bypassSupported(dep)` is `FILTER_BYPASS_FAMILIES.has(family)`, and a
  // frontend deployable `continue`s before reaching it.
  {
    code: "loom.filter-bypass-unsupported",
    setName: "FILTER_BYPASS_FAMILIES",
    set: FILTER_BYPASS_FAMILIES,
    kind: "covers-every-backend",
  },
  // `validateEventSourcedWorkflowStorage` returns on an empty `unsupported`
  // and — unlike its event-sourced AGGREGATE sibling — carries no `anyBackend`
  // arm, which is why that sibling is driven by a fixture and this is pinned.
  {
    code: "loom.event-sourced-workflow-unsupported",
    setName: "EVENT_SOURCING_WORKFLOW_BACKENDS",
    set: EVENT_SOURCING_WORKFLOW_BACKENDS,
    kind: "covers-every-backend",
  },
  // structural-checks.ts — both return early on an empty `unsupported`, and
  // both document the no-backend case as deliberately QUIET (the carrier / the
  // union return is emittable when nothing hosts the context).
  {
    code: "loom.generic-carrier-unsupported",
    setName: "SUPPORTED_PAGED_BACKENDS",
    set: SUPPORTED_PAGED_BACKENDS,
    kind: "covers-every-backend",
  },
  {
    code: "loom.operation-return-unsupported",
    setName: "SUPPORTED_RETURN_BACKENDS",
    set: SUPPORTED_RETURN_BACKENDS,
    kind: "covers-every-backend",
  },
  // The inverted polarity: these gates fire only for a MEMBER, and have none.
  {
    code: "loom.remote-api-op-unsupported",
    setName: "REMOTE_API_OP_UNSUPPORTED",
    set: REMOTE_API_OP_UNSUPPORTED as ReadonlySet<string>,
    kind: "empty",
  },
  {
    code: "loom.flutter-primitive-unsupported",
    setName: "FLUTTER_UNRENDERED_PRIMITIVES",
    set: FLUTTER_UNRENDERED_PRIMITIVES,
    kind: "empty",
  },
];

// ---------------------------------------------------------------------------
// DRIVEN_ELSEWHERE — proven, but not from `.ddd` source.
//
// A code can be perfectly reachable and still have no fixture here, because
// this census drives SOURCE TEXT and some gates are not defects in source at
// all.  The macro-authoring trio is the clean example: `loom.macro-threw` and
// its siblings fire when a registered MACRO misbehaves, so tripping them needs
// a macro, not a `.ddd`.
//
// Neither existing bucket fits, and forcing one would be a lie:
//   * UNREACHABLE_PINS says "cannot be driven from `.ddd` source at all" — true
//     here, but the word `unreachable` would then cover codes a test DOES
//     drive, which is precisely the confusion this census exists to remove.
//   * COVERED_ELSEWHERE is frozen and, by its own header, credits coverage
//     measured ONCE — if the test that raised a code is deleted, nothing
//     notices.  That is the weakness; adding to it would inherit the weakness.
//
// So this bucket carries a POINTER, and the pointer is checked: the named file
// must exist AND must name the code.  Delete the test, rename the file, or
// remove the assertion, and this fails — which is the guarantee
// COVERED_ELSEWHERE cannot make.
// ---------------------------------------------------------------------------
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DRIVEN_ELSEWHERE: Record<string, string> = {
  "loom.macro-threw": "test/macro/misbehaving-macro-diagnostics.test.ts",
  "loom.macro-non-ast-result": "test/macro/misbehaving-macro-diagnostics.test.ts",
  "loom.macro-escapes-host": "test/macro/misbehaving-macro-diagnostics.test.ts",
};

const catalogueCodes = (): string[] => [
  ...new Set(
    Object.keys(DIAGNOSTIC_MESSAGES).map((k) =>
      codeOfMessageKey(k as keyof typeof DIAGNOSTIC_MESSAGES),
    ),
  ),
];

/** UNCOVERED's size on 2026-08-13, the day the census was taken.  Shrink-only:
 *  lowering it is the drain; raising it is what this number exists to stop.
 *
 *  38 -> 31: four codes moved to UNREACHABLE_PINS (their capability-set literal
 *  already lists every backend family, so the arm cannot be reached), and three
 *  — event-sourcing / provenanced / audited backend-unsupported — turned out to
 *  be drivable after all, through the `no db-owning deployable hosts this
 *  context` arm their pinned siblings lack.  That split is the point: "every
 *  backend supports it" is a reason to pin only when the gate has NO second
 *  arm, and reading for the second arm is what separates a real pin from a
 *  TODO.
 *
 *  31 -> 17: the backend-capability cluster.  Thirteen were latent — their
 *  gate's capability set already lists every backend-owning platform (or, for
 *  two, is empty) — and are pinned, but as CHECKED pins: `LATENT_GATES` reads
 *  the real `Set` on every run, so a sixth backend family re-arms the gate and
 *  fails the pin instead of leaving a stale claim in a comment.  The
 *  fourteenth, `loom.field-mask-unsupported`, looked identical and is NOT
 *  pinned: reading `validateFieldMask` for the `anyBackend` arm its siblings
 *  have showed it fires on a context no backend hosts, so it got a fixture.
 *  That one-in-fourteen split is the whole reason the pin block insists on
 *  reading for the second arm.
 *
 *  17 -> 9: the workflow-checks cluster.  Four are drivable and get fixtures;
 *  four are pinned after being DRIVEN rather than inherited — three preempted
 *  by scope resolution (the unknown name reports `loom.unknown-name` and the
 *  statement lowers to a generic `expr-let`, never the typed kind the arm
 *  switches on) and one by the grammar (`isolation:` without `transactional`
 *  is a parse error).  M-T9.19 had listed FOUR as unreachable; one of them,
 *  `loom.workflow-name-collision`, fires cleanly — its recorded preemption was
 *  simply wrong, which is the second false unreachability claim this census
 *  has caught in that one file. */
const UNCOVERED_BASELINE = 0;

describe("diagnostic firing census", () => {
  // Keeps the LATENT_GATES pins honest.  Without this the pin is prose and its
  // truth decays silently the moment a sixth backend family registers.
  describe("the latent capability gates are still latent", () => {
    it("every entry names a code that is actually pinned", () => {
      const notPinned = LATENT_GATES.filter((g) => !(g.code in UNREACHABLE_PINS)).map(
        (g) => g.code,
      );
      expect(
        notPinned,
        "a LATENT_GATES row whose code is not in UNREACHABLE_PINS checks a claim nobody made",
      ).toEqual([]);
    });

    // The guard against a vacuous pass: an empty roster would make the
    // subset assertion below trivially true for every gate.
    it("the backend-owning roster is non-empty", () => {
      expect(BACKEND_OWNING.length).toBeGreaterThan(0);
      expect(BACKEND_OWNING).toContain("node");
    });

    it.each(LATENT_GATES.map((g) => [g.code, g] as const))("%s", (_code, gate) => {
      if (gate.kind === "empty") {
        expect(
          [...gate.set],
          `${gate.setName} is no longer empty, so ${gate.code} can fire again — it needs a real ` +
            `FIRING_FIXTURES entry, and its UNREACHABLE_PINS entry must go`,
        ).toEqual([]);
        return;
      }
      const uncovered = BACKEND_OWNING.filter((p) => !gate.set.has(p));
      expect(
        uncovered,
        `${gate.setName} no longer covers every backend-owning platform (missing ` +
          `${uncovered.join(", ")}), so ${gate.code} is reachable again — either port the ` +
          `feature on those platforms or replace its pin with a FIRING_FIXTURES entry`,
      ).toEqual([]);
    });
  });

  // Backs the `loom.platform-knob-style-layout-mismatch` pin the same way
  // LATENT_GATES backs the capability pins: by re-deriving the claim, not
  // trusting the prose.  The gate can only fire for a layout that is IN the
  // platform's menu (anything else trips the out-of-menu check first) but NOT
  // in the style's supported set.  Today no platform has such a value.
  describe("the style/layout menus cannot disagree", () => {
    const platforms = ["node", "dotnet", "python", "java", "elixir"] as const;

    it("at least one platform declares layout adapters", () => {
      // Vacuous-pass guard: if every platform had an empty menu the loop below
      // would assert nothing at all.
      expect(platforms.some((p) => hasAdapters(p) && allAdapterNames(p, "layout").length > 0)).toBe(
        true,
      );
    });

    it.each(platforms)("%s", (platform) => {
      if (!hasAdapters(platform)) return;
      const layouts = allAdapterNames(platform, "layout");
      const unreachable: string[] = [];
      for (const style of allAdapterNames(platform, "style")) {
        const supported = new Set(styleSupportedLayouts(platform, style) ?? []);
        for (const layout of layouts) {
          if (!supported.has(layout)) unreachable.push(`${style} does not support ${layout}`);
        }
      }
      expect(
        unreachable,
        `${platform} now offers a layout its style refuses (${unreachable.join("; ")}), so ` +
          `loom.platform-knob-style-layout-mismatch is reachable — replace its UNREACHABLE_PINS ` +
          `entry with a FIRING_FIXTURES entry naming that combination`,
      ).toEqual([]);
    });
  });

  // The half that makes DRIVEN_ELSEWHERE a claim rather than a note.
  describe("every DRIVEN_ELSEWHERE pointer still points at something", () => {
    it.each(Object.entries(DRIVEN_ELSEWHERE))("%s", (code, relPath) => {
      const abs = join(repoRoot, relPath);
      expect(existsSync(abs), `${code} points at ${relPath}, which does not exist`).toBe(true);
      // A BOUNDED match, not `toContain`.  A plain substring check passes for a
      // RENAMED code — `loom.macro-escapes-host-RENAMED` contains
      // `loom.macro-escapes-host` — so the first version of this assertion was
      // vacuous, and the mutation that should have failed it did not.  The
      // negative lookahead is what makes the pointer check real.
      const named = new RegExp(`${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`);
      expect(
        named.test(readFileSync(abs, "utf8")),
        `${relPath} no longer names ${code} (as a whole code — a longer code that merely ` +
          `starts with it does not count), so the pointer credits coverage that is gone.  ` +
          `Restore the assertion, or move the code back to UNCOVERED.`,
      ).toBe(true);
    });
  });

  describe("every catalogued code is in exactly one bucket", () => {
    const buckets = {
      FIRING_FIXTURES: Object.keys(FIRING_FIXTURES),
      UNREACHABLE_PINS: Object.keys(UNREACHABLE_PINS),
      DRIVEN_ELSEWHERE: Object.keys(DRIVEN_ELSEWHERE),
      UNCOVERED: [...UNCOVERED],
      COVERED_ELSEWHERE: [...COVERED_ELSEWHERE],
    };

    it("no code is claimed by two buckets", () => {
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const [bucket, codes] of Object.entries(buckets)) {
        for (const c of codes) {
          const prev = seen.get(c);
          if (prev) collisions.push(`${c} — in both ${prev} and ${bucket}`);
          else seen.set(c, bucket);
        }
      }
      expect(collisions, collisions.join("\n")).toEqual([]);
    });

    it("no bucket names a code the catalogue does not define", () => {
      const catalogue = new Set(catalogueCodes());
      const orphans: string[] = [];
      for (const [bucket, codes] of Object.entries(buckets)) {
        for (const c of codes) if (!catalogue.has(c)) orphans.push(`${c} (in ${bucket})`);
      }
      expect(
        orphans,
        `These codes are listed here but no longer exist in src/diagnostics/messages.ts.\n` +
          `The check that raised them was deleted or renamed — delete the entry too:\n  ${orphans.join("\n  ")}`,
      ).toEqual([]);
    });

    it("every catalogued code is accounted for", () => {
      const claimed = new Set(Object.values(buckets).flat());
      const unplaced = catalogueCodes()
        .filter((c) => !claimed.has(c))
        .sort();
      expect(
        unplaced,
        `New diagnostic code(s) with no firing proof:\n  ${unplaced.join("\n  ")}\n\n` +
          `Add a minimal .ddd to FIRING_FIXTURES that makes the code come out of\n` +
          `validate() — that is the negative test the code is owed.  If the arm\n` +
          `cannot fire from source, add it to UNREACHABLE_PINS with the reason.\n` +
          `COVERED_ELSEWHERE is frozen at the 2026-08-13 census and takes no new\n` +
          `entries; UNCOVERED is shrink-only.`,
      ).toEqual([]);
    });
  });

  describe("every fixture raises the code it claims", () => {
    for (const [code, source] of Object.entries(FIRING_FIXTURES)) {
      it(`${code} fires`, async () => {
        const raised = (await validate(source)).diagnostics.map((d) => d.code);
        expect(
          raised,
          `${code} did not come out of its own fixture.  Either the fixture\n` +
            `stopped expressing the defect (a grammar or default changed under it)\n` +
            `or the check stopped firing — which is exactly what this gate exists\n` +
            `to catch.  Raised instead: ${[...new Set(raised)].join(", ") || "(nothing)"}`,
        ).toContain(code);
      });
    }
  });

  it("UNCOVERED only shrinks", () => {
    expect(
      UNCOVERED.length,
      `UNCOVERED grew.  A code with no firing proof may not be parked here —\n` +
        `write a fixture, or pin it as unreachable with a reason.`,
    ).toBeLessThanOrEqual(UNCOVERED_BASELINE);
    expect(
      UNCOVERED_BASELINE - UNCOVERED.length,
      `UNCOVERED shrank to ${UNCOVERED.length} but UNCOVERED_BASELINE still says\n` +
        `${UNCOVERED_BASELINE}.  Lower the baseline in the same PR — slack in a\n` +
        `ratchet is how it stops ratcheting (allowlist-ratchet.test.ts, same rule).`,
    ).toBeLessThan(1);
  });

  it("every pin states a reason", () => {
    const blank = Object.entries(UNREACHABLE_PINS)
      .filter(([, why]) => why.trim().length < 20)
      .map(([c]) => c);
    expect(
      blank,
      `A pin without a real reason is a TODO wearing a gate's clothes: ${blank}`,
    ).toEqual([]);
  });
});
