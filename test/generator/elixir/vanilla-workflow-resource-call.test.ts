import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #6 — `resource-call` (Phase 4 bare
// resource-op statement form).
//
//   files.put(key, value)
//     → _ = <App>.Resources.<SourceType>.<resource>_put(key, value)
//
// Rendered INSIDE the with-chain's do-branch like `emit` so a failed
// preceding clause skips the side effect.  The `<App>.Resources.<Type>`
// helper modules are emitted by the orchestrator's reuse of the shared
// `emitPhoenixResourceFiles` (foundation-agnostic; the same adapter set
// the Ash path uses).  `_ =` discards the call result — the bare
// statement form intentionally has no binding (the `let x = …` form
// rides `expr-let`).
//
// Note on transactions: the validator (loom.workflow-tx-effect) rejects
// resource-call inside a `transactional` workflow because external
// effects don't roll back with the DB transaction.  These tests use
// non-transactional workflows.
// ---------------------------------------------------------------------------

const SOURCE = `
system Archive {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        sku: string
        status: string
      }
      repository Orders for Order { }

      // Bare resource-call: archive a file when the order completes.  The
      // files.put(...) discards its return value (no let-binding).
      workflow archiveOrder {
        create(orderId: Order id) {
          files.put("archive", "{}")
        }
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  storage objects { type: s3, config: { bucket: "loom-test" } }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource files       { for: Orders, kind: objectStore, use: objects }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState, files]
    serves: OrdersApi
    port: 4000
  }
}
`;

async function load(): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE);
}

describe("vanilla — resource adapter helper modules", () => {
  it("emits one helper module per resource source-type under lib/<app>/resources/", async () => {
    const files = await load();
    const path = [...files.keys()].find((k) => k.endsWith("/resources/s3.ex"));
    expect(path).toBeDefined();
    const body = files.get(path!)!;
    // The shared Phoenix adapter set emits a per-source-type helper module
    // that exposes one fn per (resource, verb).  Foundation-agnostic — no
    // Ash references appear.
    expect(body).not.toContain("Ash.");
    // Names a fn for the declared `files` resource's `put` verb.
    expect(body).toContain("files_put");
  });
});

describe("vanilla — workflow body lowering (resource-call)", () => {
  it("lowers `files.put(k, v)` to a bare adapter call discarded with `_ =`", async () => {
    const files = await load();
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/archive_order.ex"))!,
    )!;
    // The renderer routes through the per-source-type module
    // (`<App>.Resources.S3`) and prefixes the verb with the resource name.
    expect(wf).toMatch(/_ = .+\.Resources\.S3\.files_put\(/);
  });

  it("no Ash references appear in the lowered resource-call", async () => {
    const files = await load();
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/archive_order.ex"))!,
    )!;
    expect(wf).not.toContain("Ash.");
    expect(wf).not.toContain("ResourceAdapter");
  });

  it("threads the resource-adapter hex deps into mix.exs", async () => {
    const files = await load();
    const mix = files.get([...files.keys()].find((k) => k.endsWith("/mix.exs"))!)!;
    expect(mix).toMatch(/\{:ex_aws_s3, "~> 2\.5"\}/);
    expect(mix).toMatch(/\{:ex_aws, "~> 2\.5"\}/);
    expect(mix).toMatch(/\{:hackney, "~> 1\.20"\}/);
    // No double-quoting regression (the values from `hexDeps` come
    // pre-quoted; the renderer must not add another pair).
    expect(mix).not.toMatch(/""~>/);
  });

  it("a workflow with NO resource-call emits no resource module references", async () => {
    // Regression: byte-shape unchanged when no workflow uses a resource.
    const files = await generateSystemFiles(`
      system Tasks {
        subdomain Productivity {
          context Tracker {
            aggregate Task with crudish { title: string }
            repository Tasks for Task { }
            workflow noop transactional { create() { } }
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
    `);
    const wf = files.get([...files.keys()].find((k) => k.endsWith("/workflows/noop.ex"))!)!;
    expect(wf).not.toContain("Resources.");
    // ...and no resources/ dir at all.
    expect([...files.keys()].some((k) => k.includes("/resources/"))).toBe(false);
    // ...and no extra hex deps spliced into mix.exs.
    const mix = files.get([...files.keys()].find((k) => k.endsWith("/mix.exs"))!)!;
    expect(mix).not.toContain("ex_aws");
  });
});
