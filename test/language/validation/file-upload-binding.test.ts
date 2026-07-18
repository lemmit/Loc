import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// `FileUpload` UI primitive (M-T1.2 slice 4a) — a standalone bindable input
// that uploads a file and binds the returned `FileRef` into a `File`-typed
// page-state field.  Two concerns here:
//   1. PARSING — `FileUpload { "…", bind: <File state> }` parses as a walker
//      primitive; a `File` aggregate field + a `CreateForm` over it parses.
//   2. VALIDATE — binding a non-`File` state field is
//      `loom.file-upload-not-file-field`.

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    codes: diags.filter((d) => d.severity === 1).map((d) => d.code),
  };
}

// A File-bearing context needs an `objectStore` data source bound to its host
// deployable (`loom.file-field-needs-object-storage`), so the harness ships one.
const sys = (opts: { state: string; body: string }) => `
system S {
  subdomain M {
    context C {
      aggregate Doc with crudish {
        title: string
        blob: File
      }
      repository Docs for Doc { }
    }
  }
  api A from M
  storage db { type: postgres }
  storage blobs { type: localDisk }
  resource st { for: C, kind: state, use: db }
  resource fl { for: C, kind: objectStore, use: blobs }
  ui WebApp {
    api Api: A
    page P {
      route: "/p"
      state { ${opts.state} }
      body: ${opts.body}
    }
  }
  deployable api { platform: node contexts: [C] dataSources: [st, fl] serves: A port: 3000 }
  deployable web { platform: react targets: api ui: WebApp { Api: api } port: 3001 design: mantine }
}
`;

describe("FileUpload primitive — parsing", () => {
  it("`FileUpload { …, bind: <File state> }` parses cleanly", async () => {
    const { errors } = await parse(
      sys({ state: "doc: File", body: `Stack { FileUpload { "Attachment", bind: doc } }` }),
    );
    expect(errors).toEqual([]);
  });

  it("a `File` aggregate field + a `CreateForm` over it parses", async () => {
    const { errors } = await parse(
      sys({ state: "doc: File", body: `Stack { CreateForm { of: Doc } }` }),
    );
    expect(errors).toEqual([]);
  });
});

describe("FileUpload primitive — bind-type validation", () => {
  it("binding a non-`File` state field errors `loom.file-upload-not-file-field`", async () => {
    const { errors, codes } = await parse(
      sys({ state: `doc: string = ""`, body: `Stack { FileUpload { "Attachment", bind: doc } }` }),
    );
    expect(codes).toContain("loom.file-upload-not-file-field");
    expect(errors.some((m) => /FileUpload.*must bind a 'File'/.test(m))).toBe(true);
  });

  it("binding a `File` state field does not error", async () => {
    const { codes } = await parse(
      sys({ state: "doc: File", body: `Stack { FileUpload { "Attachment", bind: doc } }` }),
    );
    expect(codes).not.toContain("loom.file-upload-not-file-field");
  });
});
