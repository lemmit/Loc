// Feliz standalone `FileUpload(bind: <File state>)` (M-T1.2 slice — the Feliz
// sibling of the React/Vue/Svelte/Angular/HEEx file-upload).  Previously the
// primitive degraded to a `(* feliz pack: no renderer *)` comment (a no-op the
// bound field never received a file through); now it renders a real file input
// whose `onChange` dispatches the picked browser file, the MVU projection runs
// the multipart upload `Cmd` (`Api.uploadFile` → POST /files), and the returned
// `FileRef` lands on the `File` Model field.  The emitted F# is proven to
// compile via `dotnet fable` in the generated-feliz-build gate.

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
