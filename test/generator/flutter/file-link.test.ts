// Flutter `FileLink(<File field>)` — the `renderFileLink` WalkerTarget override.
//
// The shared primitive (`_walker/primitives/file-link.ts`) hand-builds an HTML
// `<a href download>` from the markup seams for the four JSX frontends.  Dart is
// not markup, so with no override a `File` property on a scaffolded detail page
// put a literal `<a href: docById.blob.url download>` inside
// `lib/pages/detail_page.dart` — a file `flutter analyze` cannot even parse.
// Feliz forks the primitive for the same reason (`Html.a [ … ]`); this is the
// Dart leg.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (body: string) => `
system Docs {
  subdomain S { context Files {
    aggregate Doc { name: string  blob: File }
    repository Docs for Doc { } } }
  api DocsApi from S
  storage pg { type: postgres }
  resource filesState { for: Files, kind: state, use: pg }
  ui App {
    api Docs: DocsApi
    page Detail { route: "/docs/:id"
      body: QueryView { of: Docs.Doc.byId(id), single: true,
        data: d => Stack { ${body} } } }
  }
  deployable api { platform: node contexts: [Files] dataSources: [filesState] serves: DocsApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Docs: api } port: 3006 }
}`;

const dartFiles = async (body: string): Promise<Map<string, string>> => {
  const files = await generateSystemFiles(SYS(body));
  return new Map([...files].filter(([p]) => p.endsWith(".dart")));
};

const page = async (body = "FileLink(d.blob)"): Promise<string> =>
  (await dartFiles(body)).get("app/lib/pages/detail_page.dart")!;

describe("flutter FileLink", () => {
  it("emits Dart, not an HTML anchor", async () => {
    const dart = await page();
    // The exact regression: the shared primitive's markup leaking into a .dart.
    expect(dart).not.toContain("<a ");
    expect(dart).not.toContain("<a href");
    expect(dart).not.toContain("download>");
    expect(dart).not.toContain("<span>");
  });

  it("…in EVERY generated Dart file, not just the page under test", async () => {
    for (const [path, src] of await dartFiles("FileLink(d.blob)")) {
      expect(`${path}: ${src}`).not.toMatch(/<a[ >]/);
    }
  });

  it("null-guards through a binding pattern rather than a member null-test", async () => {
    const dart = await page();
    // A `File` decodes to `FileRef?`, and a property read off a model class is
    // NOT promotable in Dart — so `d.blob != null ? d.blob.url : …` would not
    // compile.  The null-check pattern binds a non-nullable local instead.
    expect(dart).toContain("switch (docById.blob) { final __f? =>");
    expect(dart).toContain("_ => const Text('—')");
    // …and it must not name `FileRef`: the page files reach `models.dart` only
    // transitively (through `reads.dart`), so a type pattern would not resolve.
    expect(dart).not.toContain("final FileRef __f");
  });

  it("labels with the storage key and carries the url", async () => {
    const dart = await page();
    expect(dart).toContain("Tooltip(message: __f.url");
    expect(dart).toContain("SelectableText(__f.key)");
  });

  it("balances its parentheses and brackets", async () => {
    const dart = await page();
    const count = (re: RegExp) => (dart.match(re) ?? []).length;
    expect(count(/\(/g)).toBe(count(/\)/g));
    expect(count(/\[/g)).toBe(count(/\]/g));
  });
});
