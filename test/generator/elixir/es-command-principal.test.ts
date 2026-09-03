import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Pairwise F10 — an event-sourced command whose `requires` reads the principal.
//
// The ES command emitter was the ONE command path that never grew the
// `current_user \\ nil` trailing argument the relational (`context-emit.ts`)
// and document paths take.  A `requires currentUser.role == "…"` on an
// event-sourced operation therefore rendered `current_user.role` into the
// `with` chain of a function that never bound it:
//
//   error: undefined variable "current_user"
//     lib/d/main.ex:27:24: D.Main.bump_thing/2
//
// Found by the pairwise cover at `versioned` x `eventLog` x `requires`, which
// is a crossing no single-feature fixture reaches — `requires` has one, event
// sourcing has one, and the bug lives only where they meet.
//
// BOTH halves are pinned.  Emitting the parameter alone would compile (it
// defaults to nil) and then deny every request at runtime on `nil.role`, which
// is strictly worse than the compile error it replaced.
// ---------------------------------------------------------------------------

const SRC = `
system EsPrincipal {
  subdomain Core {
    context Main {
      event Opened { thing: Thing id, label: string }
      event Bumped { thing: Thing id, by: int }
      aggregate Thing persistedAs: eventLog {
        label: string
        amount: int = 0
        create open(label: string) {
          requires currentUser.role == "agent"
          emit Opened { thing: id, label: label }
        }
        operation bump(by: int) {
          requires currentUser.role == "agent"
          emit Bumped { thing: id, by: by }
        }
        apply(e: Opened) { label := e.label  amount := 0 }
        apply(e: Bumped) { amount := amount + e.by }
      }
      repository Things for Thing { }
    }
  }
  api MainApi from Core { }
  user { id: string  role: string }
  storage pg { type: postgres }
  resource st { for: Main, kind: state, use: pg }
  resource es { for: Main, kind: eventLog, use: pg }
  deployable d {
    platform: elixir
    contexts: [Main]
    dataSources: [st, es]
    serves: MainApi
    port: 3000
    auth: required
  }
}
`;

describe("event-sourced command with a principal `requires` (F10)", async () => {
  const files = await generateSystemFiles(SRC);
  const pick = (suffix: string) => [...files].find(([p]) => p.endsWith(suffix))?.[1] ?? "";
  const ctx = pick("lib/d/main.ex");
  const ctl = pick("thing_controller.ex");

  it("the command function BINDS current_user", () => {
    expect(ctx).toContain("def bump_thing(%D.Main.Thing{} = state, attrs, current_user \\\\ nil)");
  });

  it("the guard it renders actually reads that binding", () => {
    expect(ctx).toMatch(/ensure\(current_user\.role == "agent"/);
  });

  it("the controller PASSES the real principal, not the nil default", () => {
    expect(ctl).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(ctl).toMatch(/bump_thing\(record, attrs, current_user\)/);
  });

  // The `create` action is a separate emission site from the operation actions
  // and was missed by the first pass at this fix.
  it("a `create` guarded on the principal takes the same argument", () => {
    expect(ctx).toContain("def create_thing(attrs, current_user \\\\ nil)");
  });

  it("and the create action passes it through too", () => {
    expect(ctl).toMatch(/create_thing\(params, current_user\)/);
  });
});
