// `FileUpload` UI primitive (M-T1.2 slice 4a, React) — the two surfaces the
// React generator emits:
//   (a) an in-form `File` field → the pack's `field-input-file` template
//       (RHF `<Controller>` whose `onChange` uploads via `api.upload` and
//       binds the returned `FileRef` with `field.onChange`), and
//   (b) a standalone `FileUpload { bind: … }` → the `primitive-file-upload`
//       template (uploads via `api.upload`, writes back through the setter).
// Plus the shared `api.upload` multipart helper in the generated client.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (design: string) => `
system Docs {
  api DocsApi from Media
  subdomain Media {
    context Documents {
      aggregate Attachment with crudish {
        title: string
        attachment: File
      }
      repository Attachments for Attachment { }
    }
  }
  storage db { type: postgres }
  storage blobs { type: localDisk }
  resource docState { for: Documents, kind: state, use: db }
  resource docFiles { for: Documents, kind: objectStore, use: blobs }
  ui WebApp {
    api Docs: DocsApi
    page NewAttachment {
      route: "/new"
      body: Stack { Heading { "New", level: 1 }, CreateForm { of: Attachment } }
    }
    page Uploader {
      route: "/upload"
      state { doc: File }
      body: Stack { Heading { "Upload", level: 1 }, FileUpload { "Doc", bind: doc } }
    }
  }
  deployable api { platform: node contexts: [Documents] dataSources: [docState, docFiles] serves: DocsApi port: 3000 }
  deployable web { platform: react targets: api ui: WebApp { Docs: api } port: 3005 design: ${design} }
}
`;

async function files(design: string): Promise<Map<string, string>> {
  return generateSystemFiles(SRC(design));
}

describe("react FileUpload — surface (a): in-form File field", () => {
  it("emits a Controller-wrapped file input that uploads + binds the FileRef", async () => {
    const tsx = (await files("mantine")).get("web/src/pages/new_attachment.tsx")!;
    // Wrapped in a Controller bound to the `attachment` field.
    expect(tsx).toContain("<Controller");
    expect(tsx).toContain('name="attachment"');
    // Uploads through the multipart helper and binds the returned FileRef.
    expect(tsx).toContain('api.upload("/files", fd)');
    expect(tsx).toContain("field.onChange(await api.upload");
    // The null default (no file yet) seeds the RHF form.
    expect(tsx).toContain("attachment: null");
    // Controller import is forced (File is a compound, non-DOM-event value).
    expect(tsx).toMatch(/import \{[^}]*\bController\b[^}]*\} from "react-hook-form"/);
  });

  it("uploads to /files across every React pack", async () => {
    for (const design of ["mantine", "shadcn", "mui", "chakra"]) {
      const tsx = (await files(design)).get("web/src/pages/new_attachment.tsx")!;
      expect(tsx, design).toContain('api.upload("/files", fd)');
    }
  });
});

describe("react FileUpload — surface (b): standalone primitive", () => {
  it("emits a bound file input that uploads + writes back through the setter", async () => {
    const tsx = (await files("mantine")).get("web/src/pages/uploader.tsx")!;
    expect(tsx).toContain('api.upload("/files", fd)');
    expect(tsx).toContain("setDoc(await api.upload");
    expect(tsx).toContain('import { api } from "../api/client"');
  });
});

describe("react FileUpload — multipart client helper", () => {
  it("emits `api.upload` + a `rawUpload` that omits content-type", async () => {
    const client = (await files("mantine")).get("web/src/api/client.ts")!;
    expect(client).toContain("upload:");
    expect(client).toContain("async function rawUpload(path: string, form: FormData)");
    // The browser sets the multipart boundary — no hardcoded content-type.
    expect(client).toContain("body: form,");
  });
});
