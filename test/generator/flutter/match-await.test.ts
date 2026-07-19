// Phase 6 — `match await` async effects.  An `action` that awaits a remote
// Result-returning op (`operation confirm(): Order or Rejected`) projects an
// async Riverpod Notifier method: POST the instance-op to `/<coll>/$id/<op>`,
// reify a non-2xx ProblemDetails back into the error variant (clobbering the
// wire `type` tag), then a Dart-3 `switch` over `result['type']` that reifies
// each arm via `fromJson` and runs the arm body as a `state.copyWith` write.
// The page-shell binds the action as an id-capturing closure so the button's
// bare `<a>()` call is unchanged.  No Dart is compiled here; the SDK gate lives
// in generated-flutter-build.yml.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  api A from S
  subdomain S { context C {
    error Rejected { reason: string }
    aggregate Order {
      code: string  status: string
      operation confirm(): Order or Rejected { status := "confirmed" }
    }
    repository Orders for Order {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page OrderDetail {
      route: "/orders/:id"
      state { message: string = "" }
      action confirm() {
        match await Shop.Order.confirm() {
          Order o    => { message := o.code }
          Rejected r => { message := r.reason }
        }
      }
      body: Stack { Button { "Confirm", onClick: confirm } }
    }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter match await (async effect)", () => {
  it("projects an async Notifier method that awaits + reifies + switches", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("order_detail_page.dart"));
    expect(page, "no detail page").toBeDefined();
    const src = page![1];
    // Async method taking the route id.
    expect(src).toContain("Future<void> confirm(String id) async {");
    // POSTs the instance op.
    expect(src).toContain("http.post(apiUri('/orders/${id}/confirm')");
    // Reifies a non-2xx body into the single error variant tag.
    expect(src).toContain("result = {...decoded, 'type': 'Rejected'};");
    // Discriminant switch over the wire tag, reifying each arm via fromJson +
    // a state.copyWith write.
    expect(src).toContain("switch (result['type']) {");
    expect(src).toContain("case 'Order':");
    expect(src).toContain("final o = Order.fromJson(result);");
    expect(src).toContain("state = state.copyWith(message: o.code);");
    expect(src).toContain("case 'Rejected':");
    expect(src).toContain("final r = Rejected.fromJson(result);");
    // Imports the JSON codec + wire models + http/config.
    expect(src).toContain("import 'dart:convert';");
    expect(src).toContain("import '../models.dart';");
    expect(src).toContain("import 'package:http/http.dart' as http;");
  });

  it("binds the action as an id-capturing closure so the button call is unchanged", async () => {
    const files = await generateSystemFiles(SRC);
    const src = [...files.entries()].find(([k]) => k.endsWith("order_detail_page.dart"))![1];
    // Route id bound, action tear-off captures it.
    expect(src).toContain(
      "final id = (ModalRoute.of(context)?.settings.arguments as String?) ?? '';",
    );
    expect(src).toContain("final confirm = () => notifier.confirm(id);");
  });
});
