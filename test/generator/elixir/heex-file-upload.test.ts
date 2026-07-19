import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx `FileUpload` (M-T1.2 slice 4c).  The JSX frontends POST the file to
// `/files` and bind the returned FileRef; Phoenix has no such endpoint, so the
// HEEx renderer uses the LiveView-native `allow_upload`/`<.live_file_input>`
// flow — the entry streams over the channel and a `handle_<field>_progress/3`
// consumer persists it and assigns the FileRef map into the bound page-state
// assign.  This is the closing of the last `heex-parity` gap.
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain M {
    context C {
      aggregate Doc { name: string  derived display: string = name }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    page Landing {
      route: "/"
      state {
        attachment: File
      }
      body: Stack {
        FileUpload("Attachment", bind: attachment)
      }
    }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [C], serves: DemoApi,
    ui: DemoUi, port: 4000
  }
}
`;

async function landingHeex(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/landing_live.ex")) return c;
  }
  throw new Error("landing_live.ex not found");
}

describe("HEEx FileUpload (slice 4c)", () => {
  it("renders a live_file_input inside a phx-change form bound to the upload", async () => {
    const heex = await landingHeex();
    expect(heex).toContain(`<.live_file_input upload={@uploads.attachment}`);
    expect(heex).toContain(`<form phx-change="validate_attachment"`);
    // associated label carries the FileUpload label text.
    expect(heex).toContain("Attachment");
  });

  it("seeds allow_upload in mount with an auto-upload progress consumer", async () => {
    const heex = await landingHeex();
    expect(heex).toMatch(
      /allow_upload\(:attachment, accept: :any, max_entries: 1, auto_upload: true, progress: &handle_attachment_progress\/3\)/,
    );
  });

  it("hoists the phx-change validate handler and the progress consumer", async () => {
    const heex = await landingHeex();
    expect(heex).toMatch(/def handle_event\("validate_attachment", _params, socket\) do/);
    expect(heex).toContain("defp handle_attachment_progress(:attachment, entry, socket) do");
    // The consumer builds the wire FileRef shape and assigns it into state.
    expect(heex).toContain("consume_uploaded_entry(socket, entry");
    expect(heex).toContain(`"contentType" => entry.client_type`);
    expect(heex).toContain("assign(socket, :attachment, file_ref)");
  });
});
