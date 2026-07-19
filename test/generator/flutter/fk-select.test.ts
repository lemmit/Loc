// Phase 5b — FK-loaded select.  A form field that is a foreign key (`Target
// id`) renders as a runtime-loaded `DropdownButtonFormField`: its options are
// GET-loaded from `/<target-collection>` and labelled by the target's derived
// `display` field.  (Loom's validator already requires every FK a form binds to
// carry a `derived display`, so this is the single real path — the raw id-text
// branch is a defensive fallback for an unresolvable target only.)  No Dart is
// compiled here; `generated-flutter-build.yml` owns the SDK compile gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Order → Customer FK.  Customer carries `derived display`, so the CreateForm's
// customer field becomes a loaded dropdown.
const SRC = `
system Sales {
  api A from S
  subdomain S { context C {
    aggregate Customer {
      name: string
      derived display: string = name
    }
    aggregate Order {
      customer: Customer id
      total: int
    }
    repository Customers for Customer {}
    repository Orders for Order {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page NewOrder { route: "/orders/new"  body: Stack { Heading { "New order", level: 1 }, CreateForm { of: Order } } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter FK-loaded select", () => {
  it("renders a display-backed FK as a runtime-loaded dropdown", async () => {
    const files = await generateSystemFiles(SRC);
    const forms = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"));
    expect(forms, "no forms.dart emitted").toBeDefined();
    const src = forms![1];
    // Options list + selected-id state.
    expect(src).toContain("List<Map<String, dynamic>> _customerOptions = const [];");
    expect(src).toContain("String? _customer;");
    // initState fires the loader; the loader GETs the target collection + unwraps
    // the paged {items} envelope.
    expect(src).toContain("_loadCustomerOptions();");
    expect(src).toContain("http.get(apiUri('/customers'))");
    expect(src).toContain("decoded['items']");
    // The dropdown maps the loaded rows, labelled by the target's `display` field.
    expect(src).toContain("_customerOptions.map((o) => DropdownMenuItem(");
    expect(src).toContain("o['display'] ?? o['id']");
    // The selected id is submitted under the FK's own json key.
    expect(src).toContain("'customer': _customer,");
  });

  it("keeps a plain scalar field a TextFormField alongside the FK dropdown", async () => {
    const files = await generateSystemFiles(SRC);
    const src = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"))![1];
    // The non-FK `total: int` stays a controller-backed numeric field — the FK
    // machinery doesn't leak onto ordinary scalars.
    expect(src).toContain("_totalController");
    expect(src).not.toContain("_loadTotalOptions");
  });
});
