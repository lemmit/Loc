// Money / DateDisplay format through the `intl` package (NumberFormat /
// DateFormat) rather than a bare `.toString()` — the Dart twin of the JS
// frontends' `Intl.NumberFormat` / locale date formatting.  The `intl` dep is
// declared in pubspec and imported on demand by the files that use it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Mobile {
  subdomain S { context Shop {
    aggregate Order { code: string  total: money  placedAt: datetime }
    repository Orders for Order {}
  } }
  ui App {
    framework: flutter
    page Detail {
      route: "/d"
      body: Stack {
        Money { value: 1234.5, currency: "USD" },
        Money { value: 9.99, currency: "JPY", decimals: 0 },
        DateDisplay { value: now() }
      }
    }
  }
  api A from S
  storage db { type: postgres }
  resource st { for: Shop, kind: state, use: db }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App port: 3006 }
}
`;

describe("flutter intl formatting", () => {
  it("formats Money/DateDisplay through intl, imports it, and declares the dep", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("pages/detail_page.dart"))?.[1];
    expect(page, "no detail_page.dart emitted").toBeDefined();

    // Money → NumberFormat.currency (grouping + the currency's own fraction
    // digits when `decimals` is omitted — NOT collapsed to decimalDigits: 0).
    expect(page).toContain(`NumberFormat.currency(symbol: '\${"USD"} ').format(1234.5)`);
    // Explicit `decimals` is honoured.
    expect(page).toContain(`NumberFormat.currency(decimalDigits: 0, symbol: '\${"JPY"} ')`);
    // DateDisplay → DateFormat, not DateTime.toString().
    expect(page).toContain("DateFormat.yMMMd().format(");
    // No bare `.toString()` money/date fallback survives.
    expect(page).not.toContain(".toString(), style: Theme.of(context).textTheme.bodySmall)");

    // Imported on demand.
    expect(page).toContain("import 'package:intl/intl.dart';");

    // Declared in pubspec.
    const pubspec = [...files.entries()].find(([k]) => k.endsWith("pubspec.yaml"))?.[1];
    expect(pubspec).toContain("intl:");
  });
});
