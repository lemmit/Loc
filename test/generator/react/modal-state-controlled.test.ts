// Feature: state-controlled `Modal { open: <state> }` (a dialog whose
// visibility is a page `state` bool), distinct from the operation-form modal.
// See docs/old/proposals/state-controlled-modal.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (design: string) => `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order { sku: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Confirm {
      route: "/confirm"
      title: "Confirm"
      state { archiveOpen: bool = false }
      body: Stack {
        Button { "Archive", onClick: e => { archiveOpen := true } },
        Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }
      }
    }
  }
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api { platform: node contexts: [S] dataSources: [sState] serves: SalesApi port: 3001 }
  deployable web_app {
    platform: static
    targets: api
    ui: WebApp { Sales: api }
    port: 5173
    design: ${design}
  }
}
`;

describe("react Modal { open: <state> } — state-controlled dialog", () => {
  it("mantine renders a controlled <Modal opened/onClose> + useState for the flag", async () => {
    const files = await generateSystemFiles(SRC("mantine"));
    const page = [...files.entries()].find(([p]) => /pages\/confirm\.tsx$/.test(p))?.[1];
    expect(page, "confirm page").toBeDefined();
    // The `open:` ref drives a useState bool.
    expect(page).toMatch(/const \[archiveOpen, setArchiveOpen\] = useState<boolean>\(false\);/);
    // Controlled Mantine Modal — opened + onClose wired to the state setter.
    expect(page).toMatch(
      /<Modal opened=\{\s*archiveOpen\s*\} onClose=\{\(\) => setArchiveOpen\(false\)\} title="Archive">/,
    );
    expect(page).toContain("Confirm archive?");
    // No stub comment.
    expect(page).not.toContain("Modal: expects trigger");
  });

  it("shadcn renders a controlled Radix <Dialog open/onOpenChange>", async () => {
    const files = await generateSystemFiles(SRC("shadcn"));
    const page = [...files.entries()].find(([p]) => /pages\/confirm\.tsx$/.test(p))?.[1];
    expect(page, "confirm page").toBeDefined();
    expect(page).toMatch(/const \[archiveOpen, setArchiveOpen\] = useState<boolean>\(false\);/);
    expect(page).toMatch(
      /<Dialog open=\{\s*archiveOpen\s*\} onOpenChange=\{\s*setArchiveOpen\s*\}>/,
    );
    expect(page).toContain("Confirm archive?");
    expect(page).not.toContain("Modal: expects trigger");
  });

  it("MUI renders a controlled <Dialog open/onClose>", async () => {
    const files = await generateSystemFiles(SRC("mui"));
    const page = [...files.entries()].find(([p]) => /pages\/confirm\.tsx$/.test(p))?.[1];
    expect(page, "confirm page").toBeDefined();
    expect(page).toMatch(/const \[archiveOpen, setArchiveOpen\] = useState<boolean>\(false\);/);
    expect(page).toMatch(
      /<Dialog open=\{\s*archiveOpen\s*\} onClose=\{\(\) => setArchiveOpen\(false\)\}/,
    );
    expect(page).toContain("Confirm archive?");
    expect(page).not.toContain("Modal: expects trigger");
  });

  it("Chakra renders a controlled dialog driven by the state flag", async () => {
    const files = await generateSystemFiles(SRC("chakra"));
    const page = [...files.entries()].find(([p]) => /pages\/confirm\.tsx$/.test(p))?.[1];
    expect(page, "confirm page").toBeDefined();
    expect(page).toMatch(/const \[archiveOpen, setArchiveOpen\] = useState<boolean>\(false\);/);
    // Chakra v2 (<Modal isOpen>) or v3 (<Dialog.Root open>) — either is the
    // state flag wired to the controlled dialog.
    expect(page).toMatch(
      /<Modal isOpen=\{\s*archiveOpen\s*\}|<Dialog\.Root open=\{\s*archiveOpen\s*\}/,
    );
    expect(page).toContain("Confirm archive?");
    expect(page).not.toContain("Modal: expects trigger");
  });
});
