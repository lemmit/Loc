// Phase 6 — scalar array form inputs.  A form field that is a scalar array
// (`tags: string[]` / `scores: int[]`) renders as a repeatable add/remove row
// list: one `TextEditingController` per row (managed in state, disposed on
// remove + in dispose), a trailing "Add" button, and a submit value that maps
// the controllers to the list (numeric arrays parse each row).  Enum / bool /
// datetime / value-object / id-collection element arrays stay deferred.  No Dart
// is compiled here; generated-flutter-build.yml owns the SDK gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system S {
  api A from D
  subdomain D { context C {
    aggregate Post {
      title: string
      tags: string[]
      scores: int[]
    }
    repository Posts for Post {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page NewPost { route: "/posts/new"  body: Stack { Heading { "New", level: 1 }, CreateForm { of: Post } } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter scalar array inputs", () => {
  it("renders a string[] field as a controller-list add/remove row list", async () => {
    const files = await generateSystemFiles(SRC);
    const forms = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"));
    expect(forms, "no forms.dart").toBeDefined();
    const src = forms![1];
    // Controller list + disposal.
    expect(src).toContain("final List<TextEditingController> _tagsControllers = [];");
    expect(src).toContain("for (final c in _tagsControllers) c.dispose();");
    // Add + remove-row wiring.
    expect(src).toContain("_tagsControllers.add(TextEditingController())");
    expect(src).toContain("_tagsControllers.removeAt(entry.key).dispose()");
    // A string array submits the raw list of texts.
    expect(src).toContain("'tags': _tagsControllers.map((c) => c.text).toList(),");
  });

  it("parses a numeric int[] array on submit + sets a number keyboard", async () => {
    const files = await generateSystemFiles(SRC);
    const src = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"))![1];
    expect(src).toContain(
      "'scores': _scoresControllers.map((c) => int.tryParse(c.text)).whereType<int>().toList(),",
    );
    // The numeric row uses a number keyboard.
    expect(src).toContain("keyboardType: TextInputType.number");
  });
});
