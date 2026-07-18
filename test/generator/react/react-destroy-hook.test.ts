// React canonical-destroy consumption — the per-aggregate API module emits
// a `useDelete<Agg>` mutation hook, and the shared client gains an
// `api.delete` helper, ONLY when some served aggregate has a canonical
// (unnamed) destroy (declared or via `crudish`).  Plain aggregates'
// modules — and projects with no hard-delete at all — stay byte-identical.
// Mirrors the Hono / .NET destroy slices.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
  system S {
    subdomain Ops {
      context Ops {
        aggregate Widget with crudish {
          label: string
          size: int
        }
        aggregate Gadget { name: string }
        repository Widgets for Widget { }
        repository Gadgets for Gadget { }
      }
    }
    api OpsApi from Ops
    ui WebApp {
      api Ops: OpsApi
      page List {
        route: "/widgets"
        body: Stack {
          Heading { "Widgets" },
          Text { Ops.Widget.all.isLoading }
        }
      }
    }
    deployable api { platform: node, contexts: [Ops], port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("React canonical-destroy → useDelete hook", () => {
  it("emits useDelete<Agg> for the crudish aggregate", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("web/src/api/widget.ts");
    expect(mod, "widget.ts api module should be emitted").toBeDefined();
    expect(mod).toContain("export function useDeleteWidget()");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source that contains `${id}` as a template-literal interpolation
    expect(mod).toContain("await api.delete(`/widgets/${id}`);");
  });

  it("adds the api.delete helper to the shared client", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const client = files.get("web/src/api/client.ts");
    // Routes through `request` (aliased to rawFetch without auth: ui, the
    // 401-refresh wrapper under it) — same shape as get/post.
    expect(client).toContain('delete: (path: string) => request(path, { method: "DELETE" })');
    expect(client).toContain("const request = rawFetch;");
  });

  it("does NOT emit useDelete for a plain aggregate (gating)", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const mod = files.get("web/src/api/gadget.ts");
    if (mod) expect(mod).not.toContain("useDeleteGadget");
  });
});
