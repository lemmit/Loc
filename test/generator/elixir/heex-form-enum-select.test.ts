// HEEx form input — enum field renders as `<.input type="select">`.
//
// Phase D Slice B from
// `docs/old/plans/platform-expansion-roadmap.md`.
//
// Before this slice the walker's `renderFieldInputForField` (in
// heex-walker.ts:1007) routed enum-typed fields to the legacy
// `<.input type="text">` fallback — the comment on
// `htmlInputTypeForIRType` documented this as a known gap ("T id,
// enum (until the select variant lands)").  This slice closes the
// enum half.  T-id remains text-input until a follow-up slice
// threads the mount-time options-list loading.
//
// What this file pins:
//   1. Enum-typed aggregate fields render as `<.input type="select"
//      options={[...]}>` with each enum value as a quoted string in
//      the options list.  Order matches `EnumIR.values`.
//   2. Optional enum fields (`status: OrderStatus?`) get the same
//      select treatment — `optional` unwraps before the enum check.
//   3. Non-enum types are unchanged — text/number/checkbox/etc.
//      dispatch the same as before this slice.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

function phoenixSystemWithEnum(enumBody: string, fieldType = "OrderStatus"): string {
  return `
  system Demo {
    subdomain M {
      context C {
        enum OrderStatus ${enumBody}
        aggregate Order {
          status: ${fieldType}
          notes: string
          derived display: string = notes
        }
        repository Orders for Order { }
      }
    }
    api DemoApi from M
    ui DemoUi {
      page NewOrder {
        route: "/orders/new"
        body: CreateForm { of: Order }
      }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], serves: DemoApi,
      ui: DemoUi, port: 4000
    }
  }
`;
}

function findNewOrderHeex(files: Map<string, string>): string {
  for (const [path, content] of files) {
    if (path.endsWith("/new_order_live.ex")) return content;
  }
  throw new Error(
    `NewOrder LiveView not found.  Files: ${[...files.keys()]
      .filter((p) => p.includes("live"))
      .slice(0, 5)
      .join(", ")}`,
  );
}

describe("HEEx form — enum field renders as <.input type='select'>", () => {
  it("emits select input with quoted option strings in EnumIR.values order", async () => {
    const files = await generateSystemFiles(
      phoenixSystemWithEnum(`{ Draft, Pending, Confirmed, Cancelled }`),
    );
    const heex = findNewOrderHeex(files);
    expect(heex).toMatch(
      /<\.input field=\{@form\[:status\]\} type="select" label="Status" options=\{\["Draft", "Pending", "Confirmed", "Cancelled"\]\} \/>/,
    );
  });

  it("optional enum (`status: OrderStatus?`) still routes to select", async () => {
    // Walker unwraps `optional<T>` before consulting the enum
    // registry — without the unwrap, an optional enum would fall
    // through to the text-input default.
    const files = await generateSystemFiles(
      phoenixSystemWithEnum(`{ Open, Closed }`, "OrderStatus?"),
    );
    const heex = findNewOrderHeex(files);
    expect(heex).toMatch(/type="select"[^>]*options=\{\["Open", "Closed"\]\}/);
  });

  it("non-enum fields stay on their previous input types", async () => {
    // Anti-regression: the dispatch added for enums shouldn't
    // accidentally divert string/int/bool/datetime to select.
    const files = await generateSystemFiles(phoenixSystemWithEnum(`{ A, B }`));
    const heex = findNewOrderHeex(files);
    // `notes: string` still text-input.
    expect(heex).toMatch(/<\.input field=\{@form\[:notes\]\} type="text"/);
    // `status: OrderStatus` is the select (sanity).
    expect(heex).toMatch(/<\.input field=\{@form\[:status\]\} type="select"/);
  });
});

// Operation-modal forms (renderModal path) ALSO route through
// renderFieldInputForField — the walker change in this slice
// passed ctx.enumsByName at both call sites (line 907 + 979).
// A dedicated test for that path needs more setup (OperationForm
// dispatch + Modal wiring); the CreateForm tests above are the
// load-bearing gate.  Operation-modal enum dispatch is implicitly
// exercised by the showcase-phoenix fixture re-capture (no diff
// expected if any enum param survived from scaffold expansion).
