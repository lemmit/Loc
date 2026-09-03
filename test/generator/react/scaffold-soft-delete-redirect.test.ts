// End-to-end half of the scaffold's soft-delete break-out: the emitted Detail
// page leaves for the list once the record is gone.
//
// `test/macro/scaffold-body-builders.test.ts` proves the macro builds
// `Action(data.softDelete, then: navigate("/<plural>"))`; this proves the walker
// turns that into a real redirect on the page a user loads.  Both are needed —
// the AST could be right while `navigate("/…")` silently resolved to `"/"`,
// which is exactly what `tryRenderNavigateCall` did before this change: it
// handled a page REF and fell through to `"/"` for anything else.  A page ref
// cannot address one aggregate's list here, because the scaffold names EVERY
// aggregate's list page `List` inside its own `area` and `pageRoutes` is keyed
// by the bare name — so the literal path is the only unambiguous spelling.
//
// The fixture composes the real capability + macro (`softDeletable, softDelete`)
// rather than hand-writing `isDeleted := true`, so it also pins that the macro
// stdlib's own operation is the one classified.
//
// Mutation-proved:
//   * removing the string-literal arm from `tryRenderNavigateCall`
//     (`walker-core.ts`) → the redirect asserts `navigate("/")` and this fails;
//   * reverting `scaffoldOperations` to always emit the modal → the
//     `SoftDeleteOpModal` arm fails.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Soft {
  subdomain Work {
    context W {
      aggregate Project with crudish, softDeletable, softDelete {
        name: string
        derived display: string = name
        operation archive() { }
      }
      repository Projects for Project { }
    }
  }
  api WorkApi from Work
  ui WebApp with scaffold(subdomains: [Work]) { api Work: WorkApi }
  storage primary { type: postgres }
  resource wState { for: W, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [W]
    dataSources: [wState]
    serves: WorkApi
    port: 4501
  }
  deployable web_app {
    platform: react
    targets: api
    ui: WebApp { Work: api }
    port: 4502
  }
}
`;

describe("scaffolded Detail — a soft delete redirects to the list", () => {
  it("emits a direct Action that navigates to the aggregate's list route", async () => {
    const files = await generateSystemFiles(SRC);
    const detail = files.get("web_app/src/pages/projects/detail.tsx");
    expect(detail, "projects/detail.tsx was not emitted").toBeDefined();
    const src = detail!;

    // The mutation hook is hoisted, fired with no arguments, and followed by the
    // redirect — pinned as ONE expression so a redirect that lands on some other
    // handler cannot satisfy it.
    expect(src).toContain(
      'void softDeleteProject.mutateAsync({}).then(() => { navigate("/projects"); })',
    );
    // The redirect the pre-change `navigate` resolver produced for any
    // non-page-ref argument.  Its absence is the whole point.
    expect(src).not.toContain('navigate("/")');
    // `useNavigate` must actually be bound, or the emitted page is a TS2304.
    expect(src).toContain("const navigate = useNavigate();");
  });

  it("the soft delete no longer opens a modal that leaves the page mounted", async () => {
    const files = await generateSystemFiles(SRC);
    const src = files.get("web_app/src/pages/projects/detail.tsx")!;
    // Pinned on the op-form TESTID rather than the pack's component name: the
    // modal component is named by the design pack (`openSoftDeleteModal` on
    // mantine, `SoftDeleteOpModal` on shadcn), the testid is the walker's and is
    // the same on every pack.
    expect(src).not.toContain('data-testid="projects-op-softDelete-form"');
    // The control: `restore` and the ordinary `archive` keep their modals, so
    // this is "the removing op broke out", not "modals stopped being emitted".
    expect(src).toContain('data-testid="projects-op-restore-form"');
    expect(src).toContain('data-testid="projects-op-archive-form"');
    // …and the redirect is attached to the soft delete alone.
    expect(src.match(/navigate\("\/projects"\)/g)?.length).toBe(1);
  });
});
