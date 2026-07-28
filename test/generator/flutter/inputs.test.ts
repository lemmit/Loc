// Flutter STANDALONE controlled inputs — Field / MultilineField / PasswordField
// / Toggle / SelectField bound to a page `state` field.  Each reads
// `state.<bind>` and writes via the generated `set<Field>` notifier method
// (bound as a page-shell tear-off).  These render through the flutter pack
// `RENDERERS` (no longer a `// flutter pack: no renderer` silent drop).  No Dart
// is compiled here — `generated-flutter-build.yml` owns the compile gate; these
// are string assertions on the emitted widgets + notifier setters.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system InputsDemo {
  subdomain S {
    context Shop {
      aggregate Product { name: string  active: bool }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  ui MobileApp {
    framework: flutter
    api Shop: ShopApi
    page Settings {
      route: "/settings"
      state { enabled: bool = false  title: string = ""  bio: string = ""  pw: string = ""  tier: string = "free" }
      body: Stack {
        Heading { "Settings", level: 1 },
        Toggle { "Notifications", bind: enabled },
        Field { "Title", bind: title },
        MultilineField { "Bio", bind: bio },
        PasswordField { "Password", bind: pw },
        SelectField { "Tier", bind: tier, options: ["free", "pro"] }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: ShopApi port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

describe("flutter standalone inputs (generate system)", () => {
  it("renders each input as its Material widget bound to page state — no silent drop", async () => {
    const files = await generateSystemFiles(SRC);
    const key = [...files.keys()].find((k) => k.endsWith("app/lib/pages/settings_page.dart"));
    expect(key, `no settings page in: ${[...files.keys()].join(", ")}`).toBeDefined();
    const page = files.get(key!)!;

    // No silent-drop marker for any input.
    expect(page).not.toContain("no renderer");

    // Notifier grew a typed setter per state cell.
    expect(page).toContain("void setEnabled(bool v) {");
    expect(page).toContain("state = state.copyWith(enabled: v);");
    expect(page).toContain("void setTitle(String v) {");
    expect(page).toContain("void setTier(String v) {");

    // Page shell binds the setter tear-offs for the bound fields.
    expect(page).toContain("final notifier = ref.read(settingsProvider.notifier);");
    expect(page).toContain("final setEnabled = notifier.setEnabled;");
    expect(page).toContain("final setTitle = notifier.setTitle;");

    // Each widget reads state.<bind> and writes through the setter.
    expect(page).toContain(
      "SwitchListTile(title: const Text('Notifications'), value: state.enabled, onChanged: (v) => setEnabled(v))",
    );
    expect(page).toContain(
      "TextFormField(initialValue: state.title, decoration: InputDecoration(labelText: 'Title'), onChanged: (v) => setTitle(v))",
    );
    expect(page).toContain("obscureText: true"); // PasswordField
    expect(page).toContain("minLines: 3, maxLines: 5"); // MultilineField
    expect(page).toContain("DropdownButtonFormField<String>(initialValue: state.tier"); // SelectField
    expect(page).toContain("onChanged: (v) => setTier(v ?? '')");
  });
});
