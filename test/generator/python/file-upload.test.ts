import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — File upload/download (M-T1.2 slice 2a).  A `File` field
// stores its `FileRef` ({url,key,contentType,size}) in a JSONB column and the
// deployable serves the app-level `POST /files` / `GET /files/{key}` endpoints
// over the bound objectStore's bytes adapter (localDisk / s3).  Slice 1 shipped
// the type + wire; only Hono served the endpoints.  This is the Python leg —
// AND it completes File on Python (the domain/schema/repository never compiled
// with a File field before: `FileRef` was undefined and the column was Text).
// Statically proven by the `file-upload.ddd` build case (uv + mypy --strict).
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
    platform: python
    contexts: [Docs]
    dataSources: [docState, docFiles]
    serves: DocsApi
    port: 8000
  }
}
`;

async function build(src = SRC): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`source has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python File upload (slice 2a)", () => {
  it("emits the shared FileRef TypedDict", async () => {
    const files = await build();
    const model = files.get("api/app/domain/file_ref.py")!;
    expect(model).toContain("class FileRef(TypedDict):");
    expect(model).toContain("url: str");
    expect(model).toContain("key: str");
    expect(model).toContain("contentType: str");
    expect(model).toContain("size: int");
  });

  it("the domain aggregate types the File field as FileRef and imports it", async () => {
    const doc = (await build()).get("api/app/domain/doc.py")!;
    expect(doc).toContain("from app.domain.file_ref import FileRef");
    expect(doc).toContain("blob: FileRef");
  });

  it("the schema maps the File field to a JSONB column typed FileRef", async () => {
    const schema = (await build()).get("api/app/db/schema.py")!;
    expect(schema).toContain("from app.domain.file_ref import FileRef");
    expect(schema).toContain("blob: Mapped[FileRef] = mapped_column(JSONB)");
  });

  it("emits root /files upload + download routes over the objectStore bytes adapter", async () => {
    const files = await build();
    const routes = files.get("api/app/http/files_routes.py")!;
    expect(routes).toContain('router = APIRouter(prefix="/files"');
    expect(routes).toContain(
      "from app.resources.local_disk import doc_files_get_bytes, doc_files_put_bytes",
    );
    expect(routes).toContain("async def upload_file(file: UploadFile) -> Response:");
    expect(routes).toContain("await doc_files_put_bytes(key, body, content_type)");
    expect(routes).toContain('"contentType": content_type,');
    // `request` is load-bearing, not cosmetic: the absent-object 404 answers
    // RFC 7807 through `app.http.problem.problem`, which fills `instance` from
    // the request path (`files-absence-envelope-parity.test.ts`).
    expect(routes).toContain("async def download_file(key: str, request: Request) -> Response:");
    expect(routes).toContain("from app.http.problem import problem");
    expect(routes).toContain("obj = await doc_files_get_bytes(key)");
    expect(routes).toContain("return Response(content=body, media_type=content_type)");
  });

  it("mounts the files router at the root (no /api prefix), matching Hono + the client", async () => {
    const main = (await build()).get("api/app/main.py")!;
    expect(main).toContain("from app.http.files_routes import router as files_router");
    // Root mount — no `prefix=` kwarg (aggregate routers get prefix="/api").
    expect(main).toContain("app.include_router(files_router)");
    expect(main).not.toContain('app.include_router(files_router, prefix="/api")');
  });

  it("the localDisk adapter emits dependency-free bytes verbs + JSON parity verbs", async () => {
    const disk = (await build()).get("api/app/resources/local_disk.py")!;
    expect(disk).toContain("from pathlib import Path");
    expect(disk).toContain(
      "async def doc_files_put_bytes(key: str, body: bytes, content_type: str) -> None:",
    );
    expect(disk).toContain("async def doc_files_get_bytes(key: str) -> tuple[bytes, str] | None:");
    // JSON verb parity (blob capability) so workflow bodies keep working.
    expect(disk).toContain("async def doc_files_put(key: str, body: object) -> None:");
    expect(disk).toContain("async def doc_files_list(prefix: str) -> list[str]:");
  });

  it("the s3 adapter gains raw-bytes verbs alongside the JSON verbs", async () => {
    const s3src = SRC.replace("type: localDisk", 'type: s3, config: { bucket: "docs" }');
    const s3 = (await build(s3src)).get("api/app/resources/s3.py")!;
    expect(s3).toContain(
      "async def doc_files_put_bytes(key: str, body: bytes, content_type: str) -> None:",
    );
    expect(s3).toContain("async def doc_files_get_bytes(key: str) -> tuple[bytes, str] | None:");
    expect(s3).toContain("ContentType=content_type,");
  });

  it("a File-free project emits no files router (byte-identical gate)", async () => {
    const plain = SRC.replace("        blob: File\n", "")
      .replace("  storage disk { type: localDisk }\n", "")
      .replace("  resource docFiles { for: Docs, kind: objectStore, use: disk }\n", "")
      .replace("dataSources: [docState, docFiles]", "dataSources: [docState]");
    const files = await build(plain);
    expect(files.has("api/app/http/files_routes.py")).toBe(false);
    expect(files.has("api/app/domain/file_ref.py")).toBe(false);
    expect(files.get("api/app/main.py")!).not.toContain("files_router");
  });
});
