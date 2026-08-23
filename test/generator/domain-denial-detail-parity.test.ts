// RS-15 — the DOMAIN-FLOOR denial contract, pinned across all five backends in
// one place.
//
// Two claims, both cross-backend, both previously unpinned:
//
//   1. STATUS.  A rejection the DOMAIN makes on a well-formed request — a false
//      `precondition`, a tripped `invariant`, any `DomainError`-class throw the
//      wire validator cannot express — is **422 Unprocessable Entity**, never
//      400.  RFC 9110 §15.5.21: the request was well-formed but could not be
//      followed due to semantic errors.  400 is left to a genuinely malformed
//      body.  (`requires` stays 403 and the `when` state gate stays 409 — the
//      ladder is 403 / 409 / 422, identical on all five.)
//
//   2. DETAIL.  The RFC 7807 `detail` NAMES THE PREDICATE THAT FAILED —
//      `"Precondition failed: <source>"` / `"Forbidden: <source>"` — byte-for-
//      byte the same string on every backend.  This is the half that used to
//      diverge: the Phoenix backend's typed denial was a bare atom
//      (`{:error, :precondition_failed}`) carrying no message, so its
//      controller answered with a fixed sentence while the other four named the
//      predicate.  A generic `detail` is also just wrong per RFC 7807, which
//      wants it specific to the OCCURRENCE.
//
// Why one shared test rather than five per-backend ones: the value of both
// claims is that they hold TOGETHER.  A per-backend test can drift to four
// different messages and still be green everywhere; asserting the same literal
// against all five outputs cannot.  This is the static (T0) complement to the
// M-T9.11 wire-golden gate, which proves the same thing at runtime but only for
// systems that appear in a shared behavioural system.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One aggregate with BOTH guard kinds on one operation, so a single emission
 *  carries the `requires` (403) and the `precondition` (422) arm. */
const SOURCE = (platform: string) => `
system Denials {
  user { id: string  level: int }
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        total: int
        status: string

        operation cancel() {
          requires currentUser.level > 2
          precondition total > 0
          status := "cancelled"
        }

        // The third rung: a when STATE GATE.  Rejected -> 409, and its detail
        // must name the operation and aggregate (RS-17).
        operation reopen() when status != "open" {
          status := "open"
        }

        // A precondition with an AUTHOR-WRITTEN message, on an OPERATION (the
        // HTTP-boundary path).  Every backend must prefer it over the derived
        // "Precondition failed: <source>" — a backend that ignores the clause
        // and derives anyway sends a detail the author explicitly overrode.
        operation reprice(to: int) {
          precondition to > 0 message "Repricing needs a positive amount"
          total := to
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

/** The two messages, derived from the `.ddd` predicate source by the SAME rule
 *  on every backend.  These literals are the contract — a backend that
 *  paraphrases, truncates, or genericizes one of them fails here.  The
 *  predicates deliberately contain no STRING literal: each backend escapes
 *  quotes differently inside its own emitted string literal, which would make
 *  the expectation about escaping rather than about the message. */
const PRECONDITION_DETAIL = "Precondition failed: total > 0";
const FORBIDDEN_DETAIL = "Forbidden: currentUser.level > 2";
/** …and when the author writes `message "…"`, THAT is the detail — the derived
 *  form must not appear for that statement.  Elixir used to drop the clause
 *  here; its typed-denial path now shares one `denialMessage` rule with the
 *  other four.
 *
 *  This constant covers the OPERATION (HTTP-boundary) path.  Elixir has a
 *  second denial path — the RAISE used by `function` / `domainService` /
 *  pure-core bodies — which used to be routed by MESSAGE PREFIX and therefore
 *  could not carry an authored message at all; it is pinned by its own
 *  `describe` at the bottom of this file (M-T6.20 path 2). */
const AUTHORED_DETAIL = "Repricing needs a positive amount";
/** RS-17 — the 409 rung.  Elixir used to answer a fixed sentence with title
 *  "Conflict"; the denial reason is now a tuple carrying this message, and the
 *  title is the ERROR NAME (`errorTitle` humanises `Disallowed`) on all five. */
const DISALLOWED_DETAIL = "operation 'reopen' is not allowed in the current state of Order.";

async function emit(platform: string): Promise<string> {
  const files = await generateSystemFiles(SOURCE(platform));
  return [...files.values()].join("\n");
}

describe("RS-15 — domain-floor denials are 422 with an occurrence-specific detail", () => {
  for (const platform of ["node", "dotnet", "java", "python", "elixir"]) {
    it(`${platform}: the precondition message names the failed predicate`, async () => {
      expect(await emit(platform)).toContain(PRECONDITION_DETAIL);
    });

    it(`${platform}: the requires message names the failed predicate`, async () => {
      expect(await emit(platform)).toContain(FORBIDDEN_DETAIL);
    });

    it(`${platform}: an authored message clause wins over the derived detail`, async () => {
      const out = await emit(platform);
      expect(out).toContain(AUTHORED_DETAIL);
      expect(out, "derived detail emitted despite an authored message").not.toContain(
        "Precondition failed: to > 0",
      );
    });

    it(`${platform}: a refused when-gate names the operation it refused`, async () => {
      const out = await emit(platform);
      expect(out).toContain(DISALLOWED_DETAIL);
      // …and the state-gate arm's 7807 title is the ERROR NAME, not the 409
      // reason phrase.  Asserted POSITIVELY: "Conflict" is a legitimate title
      // on the sibling 409 rungs (UniquenessConflict / ConcurrencyConflict), so
      // a blanket `not.toContain('409, "Conflict"')` would fail on four correct
      // backends — the mistake this assertion originally made.
      expect(out, "the when-gate arm is not titled Disallowed").toContain('"Disallowed"');
    });

    it(`${platform}: the domain floor answers 422, and 400 is not its status`, async () => {
      const out = await emit(platform);
      // Every backend renders the domain-floor arm with the 422 status and the
      // canonical RFC 9110 reason phrase as the 7807 `title`.
      expect(out).toContain("Unprocessable Entity");
      // …and none of them still maps a DOMAIN fault to "Bad Request".  The
      // string may legitimately appear for a MALFORMED-body handler (java's
      // `problem(400, "Bad Request", "Malformed request body.")`), so the
      // assertion is scoped to lines that also mention a domain fault.
      const domainBadRequest = out
        .split("\n")
        .filter((l) => /Bad Request/.test(l))
        .filter((l) => /domain|precondition|DomainE(rror|xception)|guard_msg/i.test(l));
      expect(domainBadRequest, "domain faults still mapping to 400").toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The RAISE path — the same DETAIL claim, on the denial path that has no HTTP
// boundary to short-circuit through (M-T6.20 path 2).
//
// A guard inside an aggregate `function` (or a `domainService` operation) is
// reached from a PURE body: there is no `with`/middleware chain, so every
// backend THROWS and the framework's exception handler maps it.  Four of them
// put the author's message straight into the thrown `DomainException` /
// `DomainError`.  Elixir could not: its controller rescue routed the raise to
// its status by MESSAGE PREFIX (`String.starts_with?(guard_msg, "Precondition
// failed: ")`), so an authored message missed the prefix and reraised into a
// 500 — and the emitter deliberately shipped the DERIVED text to keep the
// routing intact.  The classification now rides a typed exception's `:kind`
// field, so the message is free text on this path too.
//
// Separate fixture from `SOURCE` above so the operation-path assertions stay
// exactly what they were; separate MESSAGE so a passing operation-path
// assertion can never stand in for this one.
// ---------------------------------------------------------------------------

const RAISE_SOURCE = (platform: string) => `
system Denials2 {
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        total: int

        function checkRepriceable(amount: int): bool {
          precondition amount > 0 message "A pure function keeps its authored message"
          return true
        }

        operation reprice(to: int) {
          let ok = checkRepriceable(to)
          total := to
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
  }
}
`;

const FUNCTION_AUTHORED_DETAIL = "A pure function keeps its authored message";

describe("RS-15 — the raise path carries the authored message too (M-T6.20 path 2)", () => {
  for (const platform of ["node", "dotnet", "java", "python", "elixir"]) {
    it(`${platform}: a function precondition's authored message reaches the thrown fault`, async () => {
      const files = await generateSystemFiles(RAISE_SOURCE(platform));
      const out = [...files.values()].join("\n");
      expect(out).toContain(FUNCTION_AUTHORED_DETAIL);
      expect(out, "derived detail emitted despite an authored message").not.toContain(
        "Precondition failed: amount > 0",
      );
    });
  }
});
