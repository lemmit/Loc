import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Elixir/Phoenix backend — File upload/download (M-T1.2 slice 2d).  A `File`
// field stores its FileRef ({url,key,contentType,size}) in a `:map` (jsonb)
// column and the deployable serves the app-level `POST /files` /
// `GET /files/:key` HTTP endpoints (distinct from the HEEx LiveView
// `allow_upload` channel path) over the bound objectStore's raw-bytes adapter.
// Elixir is dynamically typed, so the domain rides the same `map()` path as
// `json` — the one real gap was the schema mapping File to `:string` (a
// load/cast mismatch against the jsonb migration column).  Statically proven by
// the `file-upload.ddd` build case (mix compile --warnings-as-errors).
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
    platform: elixir
    contexts: [Docs]
    dataSources: [docState, docFiles]
    serves: DocsApi
    port: 4000
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

describe("elixir File upload (slice 2d)", () => {
  it("maps the File field to a :map (jsonb) Ecto column", async () => {
    const schema = pick(await build(), "docs/doc.ex");
    expect(schema).toContain("field :blob, :map");
  });

  it("emits a root FilesController (POST /files + GET /files/:key) over localDisk", async () => {
    const ctrl = pick(await build(), "controllers/files_controller.ex");
    expect(ctrl).toContain(
      'def upload(conn, %{"file" => %Plug.Upload{path: path, content_type: content_type}})',
    );
    expect(ctrl).toContain("Api.Resources.LocalDisk.doc_files_put_bytes(key, body, ct)");
    expect(ctrl).toContain('"url" => "/files/" <> key');
    expect(ctrl).toContain('def download(conn, %{"key" => key})');
    expect(ctrl).toContain("Api.Resources.LocalDisk.doc_files_get_bytes(key)");
    expect(ctrl).toContain("put_resp_content_type(content_type)");
    expect(ctrl).toContain("send_resp(200, body)");
  });

  it("mounts /files at the router root (not under /api)", async () => {
    const router = pick(await build(), "_web/router.ex");
    expect(router).toContain('post "/files", ApiWeb.FilesController, :upload');
    expect(router).toContain('get "/files/:key", ApiWeb.FilesController, :download');
  });

  it("emits the localDisk resource module with raw-bytes + JSON parity verbs", async () => {
    const disk = pick(await build(), "resources/local_disk.ex");
    expect(disk).toContain("def doc_files_put_bytes(key, body, content_type) do");
    expect(disk).toContain("def doc_files_get_bytes(key) do");
    expect(disk).toContain("def doc_files_put(key, body) do");
    expect(disk).toContain("def doc_files_list(prefix) do");
  });

  it("adds raw-bytes verbs to the s3 resource module", async () => {
    const s3src = SRC.replace("type: localDisk", 'type: s3, config: { bucket: "docs" }');
    const s3 = pick(await build(s3src), "resources/s3.ex");
    expect(s3).toContain("def doc_files_put_bytes(key, body, content_type) do");
    expect(s3).toContain("def doc_files_get_bytes(key) do");
    expect(s3).toContain("content_type: content_type");
  });

  it("a File-free project emits no FilesController and no /files routes", async () => {
    const plain = SRC.replace("        blob: File\n", "")
      .replace("  storage disk { type: localDisk }\n", "")
      .replace("  resource docFiles { for: Docs, kind: objectStore, use: disk }\n", "")
      .replace("dataSources: [docState, docFiles]", "dataSources: [docState]");
    const files = await build(plain);
    expect([...files.keys()].some((p) => p.endsWith("files_controller.ex"))).toBe(false);
    expect(pick(files, "_web/router.ex")).not.toContain('"/files"');
  });
});
