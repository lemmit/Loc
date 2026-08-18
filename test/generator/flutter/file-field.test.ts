// Flutter `File` AGGREGATE FIELD — the two silent gaps a File-typed field on an
// aggregate (rather than in page `state`) used to open.
//
// (A) `dart-model-emit.ts` appended the nullability `?` off the IR `optional`
//     flag, but `dartType` already spells a `File` primitive as the NULLABLE
//     `FileRef?` (a File holds a FileRef-or-nothing).  So `thumb: File?` emitted
//     `final FileRef?? thumb;` and `copyWith` emitted `FileRef??` for EVERY File
//     field — Dart that does not parse.  `toJson` keyed off the same flag and
//     emitted `blob.toJson()` on a nullable receiver.
//
// (B) `forms-emit.ts`'s `scalarInputKind` sent `File` down `default: "text"`, so
//     an in-form File input got a `TextEditingController` and POSTed
//     `'blob': _blobController.text` — a bare String against a backend requiring
//     the `{url,key,contentType,size}` FileRef object.  A guaranteed 422, with no
//     drop marker to make it visible.
//
// The CI gate that would have caught (A) — `generated-flutter-build.yml`'s
// `flutter analyze` — was blind to it because its fixture used `File` only in
// page STATE, never as an aggregate field.  That fixture now carries one; these
// unit assertions are the fast per-PR half.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = `
system Files {
  api FApi from S
  subdomain S {
    context Ctx {
      aggregate Doc {
        name: string
        blob: File
        thumb: File?
      }
      repository Docs for Doc { }
    }
  }
  storage db { type: postgres }
  storage blobs { type: localDisk }
  resource st { for: Ctx, kind: state, use: db }
  resource fs { for: Ctx, kind: objectStore, use: blobs }
  ui App {
    framework: flutter
    api F: FApi
    page NewDoc {
      route: "/docs/new"
      body: Stack { CreateForm(of: Doc) }
    }
  }
  deployable api { platform: node contexts: [Ctx] dataSources: [st, fs] serves: FApi port: 3000 }
  deployable mobile { platform: flutter targets: api ui: App { F: api } port: 3006 }
}`;

const emitted = async (): Promise<Map<string, string>> => await generateSystemFiles(SYS);

const dartFile = async (path: string): Promise<string> => {
  const f = await emitted();
  const src = f.get(path);
  expect(src, `missing ${path} (have: ${[...f.keys()].join(", ")})`).toBeDefined();
  return src as string;
};

describe("flutter: a File-typed aggregate field (models.dart)", () => {
  it("never doubles the nullability marker — no `??` type anywhere in the emitted Dart", async () => {
    for (const [path, src] of await emitted()) {
      if (!path.endsWith(".dart")) continue;
      // `FileRef?? blob` / `FileRef?? thumb,` — a type spelling, so the `??`
      // is directly followed by whitespace + an identifier.  A real `a ?? b`
      // null-coalesce (which IS legal and present) is preceded by whitespace.
      expect(`${path}\n${src}`).not.toMatch(/\w\?\?\s/);
    }
  });

  it("declares BOTH the required and the optional File field as a single-`?` FileRef", async () => {
    const models = await dartFile("mobile/lib/models.dart");
    expect(models).toContain("final FileRef? blob;");
    expect(models).toContain("final FileRef? thumb;");
    expect(models).not.toContain("FileRef??");
  });

  it("null-guards toJson on a File field — never `.toJson()` on a nullable receiver", async () => {
    const models = await dartFile("mobile/lib/models.dart");
    // The regression: `'blob': blob.toJson(),` on a `FileRef?` field.
    expect(models).not.toMatch(/'blob': blob\.toJson\(\)/);
    expect(models).toContain("'blob': blob == null ? null : blob!.toJson(),");
    expect(models).toContain("'thumb': thumb == null ? null : thumb!.toJson(),");
  });

  it("null-guards fromJson on a File field (the Dart type accepts null, so the decode must too)", async () => {
    const models = await dartFile("mobile/lib/models.dart");
    expect(models).toContain(
      "blob: json['blob'] == null ? null : FileRef.fromJson(json['blob'] as Map<String, dynamic>),",
    );
  });

  it("takes the single-`?` form in copyWith too", async () => {
    const models = await dartFile("mobile/lib/models.dart");
    expect(models).toContain("    FileRef? blob,");
    expect(models).toContain("    FileRef? thumb,");
  });
});

describe("flutter: a File field INSIDE a form (forms.dart)", () => {
  it("submits a FileRef payload, not a String from a text controller", async () => {
    const forms = await dartFile("mobile/lib/forms.dart");
    // The regression: a TextEditingController + its raw `.text` in the body.
    expect(forms).not.toContain("_blobController");
    expect(forms).not.toContain("'blob': _blobController.text");
    // The fix: the `{url,key,contentType,size}` object the backend wants.
    expect(forms).toContain("'blob': _blob?.toJson(),");
    expect(forms).toContain("'thumb': _thumb?.toJson(),");
    expect(forms).toContain("FileRef? _blob;");
  });

  it("wires the same pick -> multipart POST /files -> FileRef write-back the standalone FileUpload ships", async () => {
    const forms = await dartFile("mobile/lib/forms.dart");
    expect(forms).toContain("Future<void> _pickBlob() async {");
    expect(forms).toContain("FilePicker.platform.pickFiles(withData: true)");
    expect(forms).toContain("http.MultipartRequest('POST', apiUri('/files'))");
    expect(forms).toContain(
      "setState(() => _blob = FileRef.fromJson(jsonDecode(resp.body) as Map<String, dynamic>));",
    );
  });

  it("imports file_picker + models.dart, and the pubspec pulls the plugin", async () => {
    const forms = await dartFile("mobile/lib/forms.dart");
    expect(forms).toContain("import 'package:file_picker/file_picker.dart';");
    expect(forms).toContain("import 'models.dart';");
    // The in-form File input pulls the dependency exactly as a standalone
    // `FileUpload` primitive does — otherwise `flutter pub get` fails.
    expect(await dartFile("mobile/pubspec.yaml")).toContain("file_picker:");
  });

  it("enforces a REQUIRED file outside the Form validator sweep (it is not a FormField)", async () => {
    const forms = await dartFile("mobile/lib/forms.dart");
    expect(forms).toContain("if (_blob == null) {");
    expect(forms).toContain("setState(() => _error = 'Blob is required');");
    // The OPTIONAL one must NOT be guarded.
    expect(forms).not.toContain("if (_thumb == null) {");
  });

  it("renders a pick button + the current selection, not a text input", async () => {
    const forms = await dartFile("mobile/lib/forms.dart");
    expect(forms).toContain("onPressed: _pickBlob");
    expect(forms).toContain("Icon(Icons.upload_file)");
    expect(forms).toContain("_blob?.key ?? 'No file selected'");
  });

  it("emits no form-field DROP marker for a File field — it is rendered, not deferred", async () => {
    const forms = await dartFile("mobile/lib/forms.dart");
    expect(forms).not.toMatch(/TODO\(flutter form-field\): (blob|thumb)/);
  });
});
