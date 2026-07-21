// Nested page-state writes (`draft.address.zip := v`) on Flutter.  Previously
// the Riverpod Notifier projector dropped a multi-segment target to a
// `// TODO(flutter full-parity)` comment; now it folds the segment list into an
// immutable `copyWith` chain — the Dart analogue of React's inside-out spread
// (`setShipping({ ...shipping, zip })`).  Every intermediate level is a wire
// model that now carries its own `copyWith` (emitted by dart-model-emit.ts).
//
// Flutter rejects inline effect writes in render-tree lambdas
// (`loom.effect-in-lambda`), so a nested write lands in a NAMED action, which
// projects to a Notifier method — that's where the chain is asserted.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system S {
  api A from D
  subdomain D { context C {
    valueobject Address { zip: string  city: string }
    valueobject Shipping { address: Address  method: string }
    aggregate Order { code: string  shipping: Shipping }
    repository Orders for Order {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page Edit {
      route: "/edit"
      state { draft: Shipping = Shipping.create({ address: Address.create({ zip: "", city: "" }), method: "std" }) }
      action setZip(z: string) { draft.address.zip := z }
      action setMethod(m: string) { draft.method := m }
      body: Stack { Heading { "Edit", level: 1 }, Text { "Zip: " + draft.address.zip }, Button { "set", onClick: setZip } }
    }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter nested page-state writes", () => {
  it("folds a 3-segment write into an inside-out copyWith chain", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("edit_page.dart"))![1];
    // draft.address.zip := z → state.copyWith(draft: state.draft.copyWith(address: state.draft.address.copyWith(zip: z)))
    expect(page).toContain(
      "state = state.copyWith(draft: state.draft.copyWith(address: state.draft.address.copyWith(zip: z)));",
    );
    // A single-nested (2-segment) write stays a one-level chain.
    expect(page).toContain("state = state.copyWith(draft: state.draft.copyWith(method: m));");
    // No leftover deferral comment.
    expect(page).not.toContain("TODO(flutter full-parity): nested state write");
  });

  it("emits copyWith on the intermediate wire models the chain calls", async () => {
    const files = await generateSystemFiles(SRC);
    const models = [...files.entries()].find(([k]) => k.endsWith("lib/models.dart"))![1];
    expect(models).toContain("Address copyWith({");
    expect(models).toContain("Shipping copyWith({");
    // copyWith keeps the current value for an omitted arg.
    expect(models).toContain("zip: zip ?? this.zip,");
  });
});
