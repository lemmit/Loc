// Phase 5 — Action(<instance>.<op>).  On a byId detail page, a parameter-less
// public op on the loaded record renders as a one-click ElevatedButton that
// POSTs /<coll>/${record.id}/<op>; the page gains http + config imports on
// demand.  A parameterised op falls to a diagnostic comment (→ OperationForm).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  api A from S
  subdomain S { context C {
    aggregate Product {
      name: string  active: bool
      operation activate() { active := true }
      operation discount(percent: int) { requires percent > 0 }
    }
    repository Products for Product {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page ProductDetail {
      route: "/products/:id"
      body: QueryView {
        of: Shop.Product.byId(id), single: true,
        loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" },
        data: p => Stack { Heading { p.name, level: 1 }, Action { p.activate } }
      }
    }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter Action buttons", () => {
  it("emits a POST button for a parameter-less op + wires http/config imports", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("product_detail_page.dart"));
    expect(page, "no detail page").toBeDefined();
    const src = page![1];
    expect(src).toContain("ElevatedButton(onPressed: () async {");
    expect(src).toContain("http.post(apiUri('/products/${id}/activate'))");
    expect(src).toContain("child: Text('Activate')");
    expect(src).toContain("import 'package:http/http.dart' as http;");
    expect(src).toContain("import '../config.dart';");
    expect([...files.keys()].some((k) => k.endsWith("lib/config.dart"))).toBe(true);
  });

  it("steers a parameterised op to OperationForm via a diagnostic comment", async () => {
    const files = await generateSystemFiles(
      SRC.replace("Action { p.activate }", "Action { p.discount }"),
    );
    const page = [...files.entries()].find(([k]) => k.endsWith("product_detail_page.dart"))![1];
    expect(page).toContain("no parameter-less public operation");
    expect(page).not.toContain("/products/${id}/discount");
  });
});
