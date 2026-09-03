import { describe, expect, it } from "vitest";
import { collectBodies } from "../../../web/src/builder/page/bodies.js";
import {
  listScaffoldedPages,
  mayHaveScaffoldedPages,
  unfoldScaffoldedPage,
} from "../../../web/src/builder/page/scaffold.js";
import { addPage } from "../../../web/src/builder/page/ui-decl.js";
import { parseDdd } from "../../../web/src/builder/parse.js";

// The Builder's scaffold awareness (M-T8.21 slice 1, audit H6): the pages a
// `ui … with scaffold(...)` synthesises are LISTED (with the edits that eject
// each one), an ejection produces a real `page` the builder can mount, and
// "Add a page" always yields one editable page — even with no `ui` at all.

const SCAFFOLDED = `system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        subject: string
        total: int
      }
      aggregate Customer {
        name: string
      }
    }
  }
  ui WebApp with scaffold(subdomains: [Sales]) {
  }
  deployable api {
    platform: node
    contexts: [Orders]
  }
}
`;

const HAND_WRITTEN = `system Shop {
  ui WebApp {
    page Landing {
      route: "/"
      body: Stack { Heading("Hi") }
    }
  }
}
`;

describe("scaffold awareness", () => {
  it("the cheap pre-check says whether a ui carries a macro call", () => {
    expect(mayHaveScaffoldedPages(parseDdd(SCAFFOLDED).ast)).toBe(true);
    expect(mayHaveScaffoldedPages(parseDdd(HAND_WRITTEN).ast)).toBe(false);
  });

  it("the raw parse sees NO page bodies for a scaffolded ui — the gap this closes", () => {
    expect(collectBodies(parseDdd(SCAFFOLDED).ast)).toEqual([]);
  });

  it("lists every page the scaffold produces, area-qualified, with its ui + macro", async () => {
    const pages = await listScaffoldedPages(SCAFFOLDED);
    const keys = pages.map((p) => p.key);
    expect(keys).toContain("Orders/List");
    expect(keys).toContain("Orders/Detail");
    expect(keys).toContain("Customers/New");
    expect(keys).toContain("Home");
    const list = pages.find((p) => p.key === "Orders/List")!;
    expect(list.label).toBe("Orders / List");
    expect(list.pageName).toBe("List");
    expect(list.areaName).toBe("Orders");
    expect(list.uiName).toBe("WebApp");
    expect(list.macroName).toBe("scaffold");
    expect(list.edits.length).toBeGreaterThan(0);
  });

  it("lists nothing for a hand-written ui", async () => {
    expect(await listScaffoldedPages(HAND_WRITTEN)).toEqual([]);
  });

  it("unfolding one page yields source with a real `page List` inside `area Orders`, and the builder sees it", async () => {
    const pages = await listScaffoldedPages(SCAFFOLDED);
    const list = pages.find((p) => p.key === "Orders/List")!;
    const next = unfoldScaffoldedPage(SCAFFOLDED, list);
    expect(next).not.toBeNull();
    expect(next).toMatch(/area Orders \{[\s\S]*page List \{/);
    // The macro call stays — its siblings remain generated.
    expect(next).toContain("with scaffold(subdomains: [Sales])");
    const bodies = collectBodies(parseDdd(next!).ast);
    expect(bodies.map((b) => b.name)).toEqual(["List"]);
    // Still scaffolded afterwards: the OTHER pages are still offered.
    const after = await listScaffoldedPages(next!);
    expect(after.map((p) => p.key)).toContain("Orders/Detail");
  });
});

describe("addPage", () => {
  it("adds a Home page to an existing ui and reports its name", () => {
    const r = addPage(`system S {\n  ui App {\n  }\n}\n`);
    expect(r).not.toBeNull();
    expect(r!.page).toBe("Home");
    expect(r!.source).toContain("page Home {");
    expect(r!.source).toContain('route: "/"');
    expect(collectBodies(parseDdd(r!.source).ast).map((b) => b.name)).toEqual(["Home"]);
  });

  it("picks a fresh name when Home is taken", () => {
    const r = addPage(
      `system S {\n  ui App {\n    page Home {\n      route: "/"\n      body: Stack { }\n    }\n  }\n}\n`,
    );
    expect(r!.page).toBe("Page1");
  });

  it("declares a ui first when the source has none — the model builder's + UI entry", () => {
    const r = addPage(`system S {\n}\n`);
    expect(r).not.toBeNull();
    expect(r!.source).toMatch(/ui \w+ \{[\s\S]*page Home \{/);
    expect(collectBodies(parseDdd(r!.source).ast).map((b) => b.name)).toEqual(["Home"]);
  });

  it("refuses a named ui that does not exist", () => {
    expect(addPage(`system S {\n}\n`, "Nope")).toBeNull();
  });
});
