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

const NUM_TABS_SRC = `
system NT {
  subdomain S {
    context Shop {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  ui MobileApp {
    framework: flutter
    api Shop: ShopApi
    page Panel {
      route: "/panel"
      state { qty: int = 0  price: decimal = 0 }
      body: Stack {
        Heading { "Panel", level: 1 },
        Tabs {
          Tab { "Numbers", Stack { NumberField { "Qty", bind: qty }, NumberField { "Price", bind: price } } },
          Tab { "Info", Text { "second tab" } }
        }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: ShopApi port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

describe("flutter NumberField + Tabs (generate system)", () => {
  it("renders NumberField as a numeric TextFormField with a string-parsing setter, and Tabs as DefaultTabController", async () => {
    const files = await generateSystemFiles(NUM_TABS_SRC);
    const key = [...files.keys()].find((k) => k.endsWith("app/lib/pages/panel_page.dart"));
    expect(key, `no panel page in: ${[...files.keys()].join(", ")}`).toBeDefined();
    const page = files.get(key!)!;

    expect(page).not.toContain("no renderer");

    // Both a typed setter and a string-parsing `set<Field>Text` per numeric cell.
    expect(page).toContain("void setQty(int v) {");
    expect(page).toContain("void setQtyText(String v) {");
    expect(page).toContain("state = state.copyWith(qty: int.tryParse(v) ?? 0);");
    expect(page).toContain("state = state.copyWith(price: double.tryParse(v) ?? 0);");

    // Only the NumberField (Text) tear-offs are bound — the typed setters stay unused.
    expect(page).toContain("final setQtyText = notifier.setQtyText;");
    expect(page).not.toContain("final setQty = notifier.setQty;");

    // NumberField widget: numeric keyboard + raw-string dispatch.
    expect(page).toContain(
      "TextFormField(initialValue: '${state.qty}', keyboardType: TextInputType.number, decoration: InputDecoration(labelText: 'Qty'), onChanged: (v) => setQtyText(v))",
    );

    // Tabs → DefaultTabController + TabBar + a bounded TabBarView.
    expect(page).toContain("DefaultTabController(length: 2");
    expect(page).toContain("TabBar(tabs: <Widget>[ Tab(text: 'Numbers'), Tab(text: 'Info') ])");
    expect(page).toContain("SizedBox(height: 360, child: TabBarView(children:");
  });
});

const FILE_SRC = `
system FU {
  subdomain S {
    context Shop {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  ui MobileApp {
    framework: flutter
    api Shop: ShopApi
    page Upload {
      route: "/upload"
      state { doc: File }
      body: Stack { Heading { "Upload", level: 1 }, FileUpload { "Document", bind: doc } }
    }
  }
  storage db { type: postgres }
  storage files { type: localDisk }
  resource obj { for: Shop, kind: objectStore, use: files }
  resource st { for: Shop, kind: state, use: db }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st, obj] serves: ShopApi port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

describe("flutter FileUpload (generate system)", () => {
  it("renders a pick+multipart-upload button, a nullable FileRef state cell, the FileRef model, and the file_picker dep", async () => {
    const files = await generateSystemFiles(FILE_SRC);
    const key = [...files.keys()].find((k) => k.endsWith("app/lib/pages/upload_page.dart"));
    expect(key, `no upload page in: ${[...files.keys()].join(", ")}`).toBeDefined();
    const page = files.get(key!)!;

    expect(page).not.toContain("no renderer");

    // A File state cell is a nullable FileRef, null until uploaded.
    expect(page).toContain("final FileRef? doc;");
    expect(page).toContain("const UploadState(doc: null);");
    expect(page).toContain("void setDoc(FileRef? v) {");

    // The upload widget: pick with bytes, multipart POST to /files, write the FileRef.
    expect(page).toContain("FilePicker.platform.pickFiles(withData: true)");
    expect(page).toContain("http.MultipartRequest('POST', apiUri('/files'))");
    expect(page).toContain("http.MultipartFile.fromBytes('file', f.bytes!, filename: f.name)");
    expect(page).toContain(
      "setDoc(FileRef.fromJson(jsonDecode(resp.body) as Map<String, dynamic>))",
    );

    // Imports pulled in by the content scan.
    expect(page).toContain("import 'package:file_picker/file_picker.dart';");
    expect(page).toContain("import 'package:http/http.dart' as http;");
    expect(page).toContain("import '../config.dart';");

    // The FileRef model is emitted, and file_picker is a dependency.
    const models = files.get([...files.keys()].find((k) => k.endsWith("app/lib/models.dart"))!)!;
    expect(models).toContain("class FileRef {");
    expect(models).toContain("factory FileRef.fromJson(Map<String, dynamic> json)");
    const pubspec = files.get([...files.keys()].find((k) => k.endsWith("app/pubspec.yaml"))!)!;
    expect(pubspec).toContain("file_picker:");
  });
});
