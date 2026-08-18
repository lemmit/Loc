import { describe, expect, it } from "vitest";
import { validate } from "../../src/api/index.js";
import { codeOfMessageKey, DIAGNOSTIC_MESSAGES } from "../../src/diagnostics/messages.js";
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
// FOUR BUCKETS, and every catalogue code is in exactly one:
//
//   FIRING_FIXTURES   — proven here, by running it.
//   UNREACHABLE_PINS  — cannot fire from source; the reason is the entry.
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
const FIRING_FIXTURES: Record<string, string> = {
  // --- structural ---------------------------------------------------------
  "loom.duplicate-find": repoOnly(`    aggregate Thing with crudish { name: string }
    repository Things for Thing {
      find byName(n: string): Thing[] where this.name == n
      find byName(n: string): Thing[] where this.name == n
    }`),

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

  // --- macro expansion (phase ②) ------------------------------------------
  "loom.macro-arg-missing": uiWith("scaffoldAggregate()"),
  "loom.macro-arg-duplicate": uiWith("scaffoldAggregate(of: Thing, of: Thing)"),
  "loom.macro-arg-kind-mismatch": uiWith(`scaffoldAggregate(of: "Thing")`),
  "loom.capability-host-invalid": uiWith("auditable"),

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
  // `Tab` / `Column` are `group: "sub"` primitives — the parent consumes them
  // inline, so anywhere else they degrade to a comment on all seven targets.
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

  // `persist: local|session|url` is dropped to in-memory by the feliz and
  // flutter store emitters — an honest error until they implement the ladder.
  "loom.store-lifetime-target-unsupported": `
system S {
  subdomain Sub { context C {
    aggregate Thing with crudish { name: string }
  } }
  api Api from Sub
  ui WebApp {
    framework: flutter
    api C: Api
    store Cart persist: local { state { count: int = 0 } }
    page Home { route: "/"  body: Stack { Heading { Cart.count, level: 3 } } }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: flutter targets: api ui: WebApp { C: api } port: 3001 }
}`,

  // A resource handle is ambient over the whole context, but only workflow /
  // handler / domain-service emitters have the resource client in scope.
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
  // --- frontend deployable without a `ui:` binding ------------------------
  "loom.react-deployable-missing-ui": spaMissingUi("react"),
  "loom.svelte-deployable-missing-ui": spaMissingUi("svelte"),
  "loom.vue-deployable-missing-ui": spaMissingUi("vue"),
  "loom.angular-deployable-missing-ui": spaMissingUi("angular"),

  // `display`/`inspect` are reserved derived names that only mean something on
  // an aggregate — on a value object they are rejected.
  "loom.reserved-derived-on-vo": repoOnly(`    valueobject Money {
      amount: int
      derived display: string = "x"
    }`),
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
 *  TODO. */
const UNCOVERED_BASELINE = 31;

describe("diagnostic firing census", () => {
  describe("every catalogued code is in exactly one bucket", () => {
    const buckets = {
      FIRING_FIXTURES: Object.keys(FIRING_FIXTURES),
      UNREACHABLE_PINS: Object.keys(UNREACHABLE_PINS),
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
