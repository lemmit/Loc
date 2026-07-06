import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #3 — workflow create-param surfacing.
//
// A vanilla workflow's `run/1` receives the command as a string-keyed
// map.  A body that references a declared create-param now gets a leading
// destructure of exactly the referenced params, so the bare-local
// rendering of a `param` ref (`initial_title`) binds:
//
//   def run(params) when is_map(params) do
//     %{"initial_title" => initial_title} = params
//     with :ok <- (if String.length(initial_title) > 0, ...), ...
//
// Keys are snake_case (the wire shape).  Only *referenced* params are
// bound — an unused binding would trip `mix compile --warnings-as-errors`.
// Before this slice, a workflow referencing a param emitted an unbound
// local (uncompilable); the unit suite missed it (asserts strings, never
// compiles) and the e2e fixture dodged it (literal-only bodies).
// ---------------------------------------------------------------------------

function sys(body: string): string {
  return `
system Tasks {
  subdomain Productivity {
    context Tracker {
      aggregate Task with crudish {
        title: string
        done: bool

        operation markDone() {
          done := true
        }
      }
      repository Tasks for Task { }

      ${body}
    }
  }
  api TrackerApi from Productivity
  storage primary { type: postgres }
  resource trackerState { for: Tracker, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Tracker]
    dataSources: [trackerState]
    serves: TrackerApi
    port: 4000
  }
}
`;
}

async function workflowFor(body: string, file: string): Promise<string> {
  const files = await generateSystemFiles(sys(body));
  return files.get([...files.keys()].find((k) => k.endsWith(`/workflows/${file}.ex`))!)!;
}

describe("vanilla — workflow create-param surfacing", () => {
  it("destructures a referenced create-param off the run/1 map", async () => {
    const wf = await workflowFor(
      `workflow guardedCreate transactional {
        create(initialTitle: string) {
          precondition initialTitle.length > 0
          let t = Task.create({ title: initialTitle, done: false })
        }
      }`,
      "guarded_create",
    );
    expect(wf).toContain(`%{"initial_title" => initial_title} = params`);
  });

  it("surfaces the param as a bare local in the lowered body", async () => {
    const wf = await workflowFor(
      `workflow guardedCreate transactional {
        create(initialTitle: string) {
          precondition initialTitle.length > 0
          let t = Task.create({ title: initialTitle, done: false })
        }
      }`,
      "guarded_create",
    );
    // The precondition's lowered guard reads the destructured local, not
    // a camelCase or map-access form.
    expect(wf).toMatch(/if String\.length\(initial_title\) > 0/);
    expect(wf).toContain("title: initial_title");
  });

  it("maps a camelCase param name to a snake_case map key", async () => {
    const wf = await workflowFor(
      `workflow placeOrder transactional {
        create(customerId: string) {
          let t = Task.create({ title: customerId, done: false })
        }
      }`,
      "place_order",
    );
    expect(wf).toContain(`%{"customer_id" => customer_id} = params`);
  });

  it("binds ONLY referenced params — an unused declared param is not destructured", async () => {
    const wf = await workflowFor(
      `workflow guardedCreate transactional {
        create(usedTitle: string, unusedNote: string) {
          let t = Task.create({ title: usedTitle, done: false })
        }
      }`,
      "guarded_create",
    );
    expect(wf).toContain(`%{"used_title" => used_title} = params`);
    // The unused param must NOT appear in the destructure — binding it
    // would leave an unused local that fails `--warnings-as-errors`.
    expect(wf).not.toContain("unused_note");
  });

  it("destructures multiple referenced params in declaration order", async () => {
    const wf = await workflowFor(
      `workflow guardedCreate transactional {
        create(firstName: string, lastName: string) {
          let t = Task.create({ title: firstName, done: false })
          let u = Task.create({ title: lastName, done: false })
        }
      }`,
      "guarded_create",
    );
    expect(wf).toContain(`%{"first_name" => first_name, "last_name" => last_name} = params`);
  });

  it("a param-free workflow emits NO destructure line (byte-identity regression)", async () => {
    const wf = await workflowFor(
      `workflow markAllDone transactional {
        create() {
          let t = Task.create({ title: "Untitled", done: false })
          t.markDone()
        }
      }`,
      "mark_all_done",
    );
    expect(wf).not.toContain("= params");
    // The run/1 + run_inner/1 shape is unchanged for param-free bodies.
    expect(wf).toContain("def run(params) when is_map(params) do");
  });

  // The "still-TODO kind doesn't surface its param" invariant moved to
  // `vanilla-workflow-repo-let.test.ts` (non-getById repo-let arg stays
  // unbound).  This test originally targeted `emit`, which is now lowered;
  // re-asserting against the new still-TODO kinds (for-each / repo-run /
  // resource-call) is covered structurally there.
});
