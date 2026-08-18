// Feliz `File` upload — the two surfaces the generator emits, mirroring
// React's split (`test/generator/react/file-upload.test.ts`):
//
//   (a) a standalone `FileUpload(bind: <File state>)` — previously degraded to a
//       `(* feliz pack: no renderer *)` comment (a no-op the bound field never
//       received a file through); now a real file input whose `onChange`
//       dispatches the picked browser file, the MVU projection runs the
//       multipart upload `Cmd` (`Api.uploadFile` → POST /files), and the
//       returned `FileRef` lands on the `File` Model field.
//
//   (b) an in-form `File` field (`CreateForm`/`OperationForm`/`WorkflowForm`) —
//       previously the SILENT half of the gap: `FelizInputKind` had no `file`
//       member, so `inputKindFor` fell through to `text` and the form emitted
//       `attachment: string` + `Encode.string form.attachment` + a plain text
//       input.  That submits a STRING where every backend expects the FileRef
//       object `{ url, key, contentType, size }` — a guaranteed 422, with no
//       marker anywhere.  Now the cell is a `FileRef option` fed by the same
//       upload machinery as (a), and the encoder ships the object.
//
// The emitted F# is proven to compile via `dotnet fable` in the
// generated-feliz-build gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const APP = `
system FUp {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Up {
      route: "/"
      state { doc: File  name: string = "" }
      body: Stack {
        Field { "Name", bind: name },
        FileUpload { "Doc", bind: doc }
      }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(APP);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

async function fsproj(): Promise<string> {
  const files = await generateSystemFiles(APP);
  return [...files.entries()].find(([p]) => p.endsWith("App.fsproj"))![1];
}

// Surface (b): a `File` field reached through a form (`CreateForm`), with a
// REQUIRED (`attachment`) and an OPTIONAL (`thumb`) one so the required-guard /
// touched-error path and the plain path are both covered.
const FORM_APP = `
system Docs {
  api DocsApi from Media
  subdomain Media {
    context Documents {
      aggregate Attachment with crudish {
        title: string
        attachment: File
        thumb: File?
      }
      repository Attachments for Attachment { }
    }
  }
  storage db { type: postgres }
  storage blobs { type: localDisk }
  resource docState { for: Documents, kind: state, use: db }
  resource docFiles { for: Documents, kind: objectStore, use: blobs }
  ui WebApp {
    framework: feliz
    api Docs: DocsApi
    page NewAttachment {
      route: "/new"
      body: Stack { CreateForm { of: Attachment } }
    }
  }
  deployable api { platform: node contexts: [Documents] dataSources: [docState, docFiles] serves: DocsApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Docs: api } port: 3005 }
}
`;

async function formAppFs(): Promise<string> {
  const files = await generateSystemFiles(FORM_APP);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

async function formFsproj(): Promise<string> {
  const files = await generateSystemFiles(FORM_APP);
  return [...files.entries()].find(([p]) => p.endsWith("App.fsproj"))![1];
}

describe("feliz standalone FileUpload(bind:)", () => {
  it("renders a real file input — no `no renderer` placeholder leaks", async () => {
    const app = await appFs();
    expect(app).not.toContain("no renderer");
    // A daisyUI file input whose typed onChange dispatches the picked file.
    expect(app).toContain("prop.type'.file");
    expect(app).toContain(
      "prop.onChange (fun (file: Browser.Types.File) -> dispatch (SelectDocFile file))",
    );
  });

  it("types the bound File state field as a FileRef option in the Model", async () => {
    const app = await appFs();
    expect(app).toContain("Doc: FileRef option");
    // …initialised empty (no FileRef until the user uploads).
    expect(app).toContain("Doc = None");
    // The fixed FileRef wire record + its Thoth decoder are emitted.
    expect(app).toContain("type FileRef =");
    expect(app).toContain("contentType: string");
    expect(app).toContain("let fileRefDecoder : Decoder<FileRef> =");
  });

  it("projects the file-picked + upload-completed Msg pair", async () => {
    const app = await appFs();
    expect(app).toContain("| SelectDocFile of Browser.Types.File");
    expect(app).toContain("| DocUploaded of Result<FileRef, string>");
  });

  it("runs the upload Cmd and sets the model field on success", async () => {
    const app = await appFs();
    expect(app).toContain(
      "| SelectDocFile file -> model, Cmd.OfAsync.perform Api.uploadFile file DocUploaded",
    );
    expect(app).toContain(
      "| DocUploaded (Ok fileRef) -> { model with Doc = Some fileRef }, Cmd.none",
    );
    expect(app).toContain("| DocUploaded (Error _) -> model, Cmd.none");
  });

  it("emits the shared Api.uploadFile — multipart POST /files → FileRef", async () => {
    const app = await appFs();
    expect(app).toContain(
      "let uploadFile (file: Browser.Types.File) : Async<Result<FileRef, string>> =",
    );
    expect(app).toContain('let formData : Browser.Types.FormData = emitJsExpr () "new FormData()"');
    expect(app).toContain('formData.append ("file", file)');
    expect(app).toContain('Http.request "/files"');
    expect(app).toContain("|> Http.content (BodyContent.Form formData)");
    expect(app).toContain("match Decode.fromString fileRefDecoder response.responseText with");
  });

  it("opens the JS-interop + references Fable.Browser.Dom for FormData/File", async () => {
    const app = await appFs();
    expect(app).toContain("open Fable.Core.JsInterop");
    expect(app).toContain("open Thoth.Json");
    const proj = await fsproj();
    expect(proj).toContain('Include="Fable.Browser.Dom"');
  });
});

describe("feliz in-form File field (CreateForm)", () => {
  it("holds the uploaded FileRef in the form record — never a string", async () => {
    const app = await formAppFs();
    expect(app).toContain("    attachment: FileRef option");
    expect(app).toContain("    thumb: FileRef option");
    // …and starts empty (nothing uploaded yet), not `""`.
    expect(app).toContain("    attachment = None");
    expect(app).toContain("    thumb = None");
    // The `text` degradation is gone in both directions.
    expect(app).not.toContain("    attachment: string");
    expect(app).not.toContain('    attachment = ""');
  });

  it("encodes the FileRef OBJECT, not `Encode.string`", async () => {
    const app = await formAppFs();
    // The wire shape every backend's File column round-trips.
    expect(app).toContain("let fileRefEncoder (f: FileRef) : JsonValue =");
    expect(app).toContain('    "url", Encode.string f.url');
    expect(app).toContain('    "key", Encode.string f.key');
    expect(app).toContain('    "contentType", Encode.string f.contentType');
    expect(app).toContain('    "size", Encode.int f.size');
    // The form entry ships that object (or JSON null when nothing was picked).
    expect(app).toContain(
      '      "attachment", (match form.attachment with | Some __f -> fileRefEncoder __f | None -> Encode.nil)',
    );
    // THE bug: a string body for a File field is a guaranteed 422.
    expect(app).not.toContain("Encode.string form.attachment");
    expect(app).not.toContain("Encode.string form.thumb");
  });

  it("renders a file picker, not a text input", async () => {
    const app = await formAppFs();
    expect(app).toContain(
      'prop.custom("data-testid", "attachments-new-input-attachment"); prop.className "file-input file-input-bordered w-full"; prop.type\'.file',
    );
    // A file input is uncontrolled — no `prop.value` bound to the cell (which is
    // a FileRef option, not a string), and no text placeholder.
    expect(app).not.toContain("prop.value model.AttachmentForm.attachment");
    expect(app).not.toContain('prop.placeholder "attachment"');
  });

  it("projects the pick + upload-result Msg pair per File field", async () => {
    const app = await formAppFs();
    expect(app).toContain("| SelectAttachmentFormAttachmentFile of Browser.Types.File");
    expect(app).toContain("| AttachmentFormAttachmentUploaded of Result<FileRef, string>");
    expect(app).toContain("| SelectAttachmentFormThumbFile of Browser.Types.File");
    expect(app).toContain("| AttachmentFormThumbUploaded of Result<FileRef, string>");
    // The string setter a text field would have contributed is NOT emitted.
    expect(app).not.toContain("| SetAttachmentFormAttachment of string");
  });

  it("uploads on pick and writes the FileRef into the form cell", async () => {
    const app = await formAppFs();
    expect(app).toContain(
      "  | SelectAttachmentFormAttachmentFile file -> model, Cmd.OfAsync.perform Api.uploadFile file AttachmentFormAttachmentUploaded",
    );
    expect(app).toContain(
      "  | AttachmentFormAttachmentUploaded (Ok fileRef) -> { model with AttachmentForm = { model.AttachmentForm with attachment = Some fileRef } }, Cmd.none",
    );
    expect(app).toContain("  | AttachmentFormAttachmentUploaded (Error _) -> model, Cmd.none");
  });

  it("guards submit on the OPTION, not on a string being non-blank", async () => {
    const app = await formAppFs();
    // `IsNullOrWhiteSpace` against a `FileRef option` would not even typecheck.
    expect(app).toContain(
      "    not (System.String.IsNullOrWhiteSpace form.title) && not (Option.isNone form.attachment)",
    );
    expect(app).toContain('    if Option.isNone form.attachment then Some "Required" else None');
    expect(app).not.toContain("IsNullOrWhiteSpace form.attachment");
    // The OPTIONAL File field contributes no required guard.
    expect(app).not.toContain("Option.isNone form.thumb");
  });

  it("ships the FileRef record + Api.uploadFile off the FORM alone", async () => {
    // This app has NO `File` page state and NO standalone FileUpload — the form
    // field is the only thing that needs the upload machinery, so it has to gate
    // it (the emission gates previously keyed only on state/wire File fields).
    const app = await formAppFs();
    expect(app).toContain("type FileRef =");
    expect(app).toContain("let fileRefDecoder : Decoder<FileRef> =");
    expect(app).toContain(
      "let uploadFile (file: Browser.Types.File) : Async<Result<FileRef, string>> =",
    );
    expect(app).toContain('Http.request "/files"');
    expect(app).toContain("open Fable.Core.JsInterop");
    expect(await formFsproj()).toContain('Include="Fable.Browser.Dom"');
    // The record must precede the form types that reference it (F# is
    // order-sensitive) and the encoder must precede the `Encoders` module.
    expect(app.indexOf("type FileRef =")).toBeLessThan(app.indexOf("type AttachmentForm ="));
    expect(app.indexOf("let fileRefEncoder")).toBeLessThan(app.indexOf("module Encoders ="));
  });
});
