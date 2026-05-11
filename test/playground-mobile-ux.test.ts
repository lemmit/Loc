import { describe, it, expect } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateSystems } from "../src/system/index.js";
import { makePreviewHtml } from "../web/src/preview/iframe-html.js";
import type { Model } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Mobile UX regressions:
//
// 1. The mobile burger menu didn't auto-close after a route change.
//    Tapping a NavLink on a phone left the drawer/sidebar covering
//    the destination page — every pack ships the same bug because
//    the boilerplate is identical across mantine/shadcn/mui/chakra
//    app-shell templates.  All four now wire a `useEffect` against
//    `location.pathname` that closes the menu on navigation.
//
// 2. iOS Safari auto-zoomed when a form input gained focus, blowing
//    past whatever zoom level the user had pinched to.  Trigger is
//    `font-size < 16px` on the focused element.  `iframe-html.ts`
//    now ships a mobile-only `input { font-size: 16px !important }`
//    rule to suppress the heuristic.
//
// Both fixes are covered here because they're tiny and tightly
// coupled to the mobile preview surface.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc =
    await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(path.join(repoRoot, file)),
    );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return doc.parseResult.value as Model;
}

describe("mobile menu auto-close — App.tsx app-shell", () => {
  it("mantine: useEffect on location.pathname calls close()", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const app = files.get("web_app/src/App.tsx")!;
    expect(app).toMatch(/useDisclosure\(\)\s*;/);
    // Destructure `close` from useDisclosure so the effect has
    // something to call.
    expect(app).toMatch(/\[opened, \{ toggle, close \}\]/);
    // Effect fires on location.pathname change.
    expect(app).toMatch(
      /React\.useEffect\(\(\) => \{\s*close\(\);\s*[^}]*\}, \[location\.pathname\]\)/,
    );
  });

  it("shadcn: useEffect on location.pathname calls setOpened(false)", async () => {
    // The shadcn pack ships in the storybook example.
    const model = await buildModel("web/src/examples/storybook-shadcn.ddd");
    const { files } = generateSystems(model);
    const appKey = [...files.keys()].find((k) => k.endsWith("/src/App.tsx"));
    expect(appKey, "shadcn generator emits an App.tsx").toBeDefined();
    const app = files.get(appKey!)!;
    expect(app).toMatch(
      /React\.useEffect\(\(\) => \{\s*setOpened\(false\);\s*\}, \[location\.pathname\]\)/,
    );
  });
});

describe("iframe-html — iOS auto-zoom prevention", () => {
  it("injects a mobile-only input font-size override", () => {
    const html = makePreviewHtml({
      js: "/* bundle */",
      css: "/* css */",
      versions: { react: "18.3.1", "react-dom": "18.3.1" },
    });
    // @media guard so desktop typography isn't affected.
    expect(html).toMatch(/@media\s*\(max-width:\s*768px\)/);
    // Targets the trio iOS uses for the auto-zoom heuristic.  16 px
    // is the documented minimum that suppresses the zoom.
    expect(html).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*\{\s*input,\s*select,\s*textarea\s*\{\s*font-size:\s*16px\s*!important;\s*\}\s*\}/,
    );
  });
});
