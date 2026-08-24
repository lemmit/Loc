import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Java/Spring backend — File upload/download (M-T1.2 slice 2c).  A `File` field
// stores its `FileRef` ({url,key,contentType,size}) in a jsonb column
// (@JdbcTypeCode) and the deployable serves app-level `POST /files` /
// `GET /files/{key}` over the bound objectStore's raw-bytes adapter.  Slice 1
// shipped the type + wire; only Hono served the endpoints.  This is the Java leg
// — AND it completes File on Java: the FileRef record was never emitted and the
// wire mapper fell through to `Object`, so a File-bearing project didn't compile.
// Statically proven by the `file-upload.ddd` build case (gradle testClasses).
// ---------------------------------------------------------------------------

const SRC = `
system FileSys {
  subdomain Docs {
    context Docs {
      aggregate Doc {
        title: string
        blob: File
      }
      repository Docs for Doc { }
    }
  }
  api DocsApi from Docs

  storage pg   { type: postgres }
  storage disk { type: localDisk }

  resource docState { for: Docs, kind: state,       use: pg }
  resource docFiles { for: Docs, kind: objectStore, use: disk }

  deployable api {
    platform: java
    contexts: [Docs]
    dataSources: [docState, docFiles]
    serves: DocsApi
    port: 8080
  }
}
`;

async function build(src = SRC): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`source has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function pick(files: Map<string, string>, suffix: string): string {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no generated file ending in ${suffix}`);
}

describe("java File upload (slice 2c)", () => {
  it("emits the shared FileRef record in domain.common", async () => {
    const fileRef = pick(await build(), "domain/common/FileRef.java");
    expect(fileRef).toContain(
      "public record FileRef(String url, String key, String contentType, long size)",
    );
  });

  it("maps the File field to a jsonb column via @JdbcTypeCode", async () => {
    const entity = pick(await build(), "docs/Doc.java");
    expect(entity).toContain("@JdbcTypeCode(SqlTypes.JSON)");
    expect(entity).toContain("FileRef blob");
  });

  it("types the File DTO component as FileRef (not Object) + imports it", async () => {
    const files = await build();
    let resp = "";
    for (const [p, c] of files) if (p.endsWith("DocResponse.java")) resp = c;
    expect(resp).toContain("import com.loom.api.domain.common.FileRef;");
    expect(resp).toContain("FileRef blob");
    expect(resp).not.toContain("Object blob");
  });

  it("emits a root FilesController (POST /files + GET /files/{key}) over localDisk", async () => {
    const ctrl = pick(await build(), "api/FilesController.java");
    expect(ctrl).toContain('@PostMapping("/files")');
    expect(ctrl).toContain("MultipartFile file");
    expect(ctrl).toContain("LocalDiskResources.docFilesPutBytes(key, bytes, contentType)");
    expect(ctrl).toContain('new FileRef("/files/" + key, key, contentType, bytes.length)');
    expect(ctrl).toContain('@GetMapping("/files/{key}")');
    expect(ctrl).toContain("ResponseEntity<byte[]>");
    expect(ctrl).toContain("LocalDiskResources.docFilesGetBytes(key)");
  });

  it("emits the localDisk resource class with raw-bytes + JSON parity verbs", async () => {
    const disk = pick(await build(), "resources/LocalDiskResources.java");
    expect(disk).toContain("public record ObjectBytes(byte[] bytes, String contentType)");
    expect(disk).toContain(
      "public static void docFilesPutBytes(String key, byte[] body, String contentType)",
    );
    expect(disk).toContain("public static ObjectBytes docFilesGetBytes(String key)");
    expect(disk).toContain("public static void docFilesPut(String key, String body)");
  });

  it("adds raw-bytes verbs to the s3 resource class", async () => {
    const s3src = SRC.replace("type: localDisk", 'type: s3, config: { bucket: "docs" }');
    const s3 = pick(await build(s3src), "resources/S3Resources.java");
    expect(s3).toContain(
      "public static void docFilesPutBytes(String key, byte[] body, String contentType)",
    );
    expect(s3).toContain("public static ObjectBytes docFilesGetBytes(String key)");
    expect(s3).toContain("RequestBody.fromBytes(body)");
  });

  it("a File-free project emits no FileRef record and no FilesController", async () => {
    const plain = SRC.replace("        blob: File\n", "")
      .replace("  storage disk { type: localDisk }\n", "")
      .replace("  resource docFiles { for: Docs, kind: objectStore, use: disk }\n", "")
      .replace("dataSources: [docState, docFiles]", "dataSources: [docState]");
    const files = await build(plain);
    expect([...files.keys()].some((p) => p.endsWith("FileRef.java"))).toBe(false);
    expect([...files.keys()].some((p) => p.endsWith("FilesController.java"))).toBe(false);
  });
});
