import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// .NET backend — File upload/download (M-T1.2 slice 2b).  A `File` field stores
// its `FileRef` ({url,key,contentType,size}) in a jsonb column (EF value
// converter / Dapper System.Text.Json) and the deployable serves app-level
// `POST /files` / `GET /files/{key}` over the bound objectStore's bytes adapter.
// Slice 1 shipped the type + wire; only Hono served the endpoints.  This is the
// .NET leg — AND it completes File on .NET: the FileRef record was never emitted
// before, so a File-bearing project didn't compile.  Statically proven by the
// `file-upload.ddd` build case (dotnet build /warnaserror).
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
    platform: dotnet
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

describe("dotnet File upload (slice 2b)", () => {
  it("emits the shared FileRef record in Domain.Common", async () => {
    const common = pick(await build(), "Domain/Common/DomainException.cs");
    expect(common).toContain(
      "public sealed record FileRef(string Url, string Key, string ContentType, long Size);",
    );
  });

  it("maps the File field to a jsonb column via a FileRef value converter (EF)", async () => {
    const files = await build();
    let cfg = "";
    for (const [p, c] of files) if (p.includes("/Configurations/") && p.endsWith(".cs")) cfg = c;
    expect(cfg).toContain("using Api.Domain.Common;");
    expect(cfg).toContain('.HasColumnName("blob").HasColumnType("jsonb")');
    expect(cfg).toContain("JsonSerializer.Deserialize<FileRef>");
  });

  it("emits root POST /files + GET /files/{key} over the localDisk bytes adapter", async () => {
    const program = pick(await build(), "Program.cs");
    expect(program).toContain('app.MapPost("/files"');
    expect(program).toContain("async (IFormFile file)");
    expect(program).toContain(
      "Api.Resources.LocalDiskResources.DocFiles_PutBytes(key, bytes, contentType)",
    );
    expect(program).toContain(
      'Results.Json(new { url = "/files/" + key, key, contentType, size = bytes.Length }, statusCode: 201)',
    );
    expect(program).toContain('app.MapGet("/files/{key}"');
    expect(program).toContain("Api.Resources.LocalDiskResources.DocFiles_GetBytes(key)");
    expect(program).toContain("Results.File(obj.Value.Bytes, obj.Value.ContentType)");
  });

  it("emits the localDisk resource class with raw-bytes + JSON parity verbs", async () => {
    const disk = pick(await build(), "Resources/LocalDiskResources.cs");
    expect(disk).toContain(
      "public static async Task DocFiles_PutBytes(string key, byte[] body, string contentType)",
    );
    expect(disk).toContain(
      "public static async Task<(byte[] Bytes, string ContentType)?> DocFiles_GetBytes(string key)",
    );
    expect(disk).toContain("public static async Task DocFiles_Put(string key, string body)");
  });

  it("adds raw-bytes verbs to the s3 resource class", async () => {
    const s3src = SRC.replace("type: localDisk", 'type: s3, config: { bucket: "docs" }');
    const s3 = pick(await build(s3src), "Resources/S3Resources.cs");
    expect(s3).toContain(
      "public static async Task DocFiles_PutBytes(string key, byte[] body, string contentType)",
    );
    expect(s3).toContain(
      "public static async Task<(byte[] Bytes, string ContentType)?> DocFiles_GetBytes(string key)",
    );
    expect(s3).toContain("ContentType = contentType,");
  });

  it("persists the File field as jsonb on the Dapper path too", async () => {
    const dsrc = SRC.replace("platform: dotnet", "platform: dotnet { persistence: dapper }");
    const files = await build(dsrc);
    let repo = "";
    for (const [p, c] of files) if (p.includes("/Repositories/") && p.endsWith(".cs")) repo = c;
    expect(repo).toContain("JsonSerializer.Deserialize<FileRef>(r.blob)!");
    expect(repo).toContain("blob::jsonb");
    expect(repo).toContain("JsonSerializer.Serialize(aggregate.Blob)");
  });

  it("a File-free project emits no FileRef record and no /files routes (byte-identical)", async () => {
    const plain = SRC.replace("        blob: File\n", "")
      .replace("  storage disk { type: localDisk }\n", "")
      .replace("  resource docFiles { for: Docs, kind: objectStore, use: disk }\n", "")
      .replace("dataSources: [docState, docFiles]", "dataSources: [docState]");
    const files = await build(plain);
    expect(pick(files, "Domain/Common/DomainException.cs")).not.toContain("record FileRef");
    expect(pick(files, "Program.cs")).not.toContain('MapPost("/files"');
  });
});
