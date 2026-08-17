// `textDocument/implementation` ("go to generated code", M6 phase 3).
// Because map DISCOVERY reads the real filesystem (via
// `services.shared.workspace.FileSystemProvider`), this suite builds a
// REAL fixture on disk: parse `main.ddd` from an actual file (so
// `doc.uri.path` is the on-disk path the emitted `.loom/sourcemap.json`
// records under `sources`), generate with `--sourcemap`, write the
// emitted files under `tmp/out/…`, then invoke the provider directly —
// the same direct-invocation pattern as `lsp-code-actions.test.ts` /
// `unfold-action.test.ts`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

// Small fixture (copied from test/cli/generate-sourcemap.test.ts): single
// node deployable, `Order.confirm()` with 2 statements. A `Money`
// valueobject is added so there's a construct-free node to click on for
// the negative case below.
const SOURCE = `
system SmokeMap {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }
      event OrderPlaced { order: Order id }
      aggregate Order {
        customerName: string
        operation confirm() {
          let note = customerName
          emit OrderPlaced { order: id }
        }
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  ui WebApp {
    area Back {
      page OrderBoard {
        route: "/board"
        body: Text { "board" }
      }
    }
  }
  deployable honoApi { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3000 }
  deployable webApp { platform: react targets: honoApi ui: WebApp port: 3001 }
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lsp-implementation-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function positionOf(source: string, marker: string): { line: number; character: number } {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker "${marker}" not found`);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

/** Parse `text` from a REAL on-disk file (so `doc.uri.path` is the actual
 *  filesystem path that lands in the sourcemap's `sources`), run
 *  validation + linking through the standard `DocumentBuilder`, and
 *  return both the services and the built document. */
async function loadRealDocument(dir: string, filename: string, text: string) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, text);
  const services = createDddServices(NodeFileSystem);
  const uri = URI.file(filePath);
  const doc = services.shared.workspace.LangiumDocumentFactory.fromString<Model>(text, uri);
  services.shared.workspace.LangiumDocuments.addDocument(doc);
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return { services, doc, filePath };
}

/** Generate the fixture with `--sourcemap` and write every emitted file
 *  (including `.loom/sourcemap.json`) under `outDir`. */
function writeGeneratedTree(model: Model, sourceTexts: Map<string, string>, outDir: string): void {
  const { files } = generateSystems(model, { sourcemap: true, sourceTexts });
  for (const [rel, content] of files) {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe("DddImplementationProvider (textDocument/implementation)", () => {
  const projectDir = path.join(tmp, "project");
  const outDir = path.join(projectDir, "out");

  it("wires up a real generated tree and answers go-to-generated-code queries", async () => {
    const { services, doc } = await loadRealDocument(projectDir, "main.ddd", SOURCE);
    expect(doc.diagnostics?.filter((d) => d.severity === 1) ?? []).toEqual([]);
    const model = doc.parseResult.value;
    const sourceTexts = new Map([[doc.uri.path, SOURCE]]);
    writeGeneratedTree(model, sourceTexts, outDir);

    const map = JSON.parse(
      fs.readFileSync(path.join(outDir, ".loom", "sourcemap.json"), "utf8"),
    ) as {
      files: Record<string, { target: [number, number]; construct?: string }[]>;
    };

    const provider = services.Ddd.lsp.ImplementationProvider!;

    // (a) cursor inside confirm()'s `let` statement — expect a Location
    // whose uri ends `hono_api/domain/order.ts` matching the statement's
    // own recorded line range (cross-checked against the map itself).
    {
      const pos = positionOf(SOURCE, "customerName\n");
      const links = await provider.getImplementation(doc, {
        textDocument: { uri: doc.textDocument.uri },
        position: pos,
      });
      expect(links, "expected locations for the let-statement position").toBeDefined();
      expect(links!.length).toBeGreaterThan(0);
      for (const link of links!) {
        expect(link.targetUri.endsWith("hono_api/domain/order.ts")).toBe(true);
      }

      const stmtRegions = map.files["hono_api/domain/order.ts"]!.filter(
        (r) => r.construct === "Orders.Order.confirm",
      ).sort((x, y) => x.target[0] - y.target[0]);
      expect(stmtRegions.length).toBeGreaterThan(0);
      const letRegion = stmtRegions[0]!;
      const opLevelLink = links!.find(
        (l) =>
          l.targetRange.start.line === letRegion.target[0] - 1 &&
          l.targetRange.end.line === letRegion.target[1],
      );
      expect(
        opLevelLink,
        `no returned link matched the let-statement's own region ${JSON.stringify(letRegion)}; got ${JSON.stringify(links!.map((l) => l.targetRange))}`,
      ).toBeDefined();
    }

    // (b) cursor on the aggregate name `Order`, outside any operation —
    // expect the coarser construct-level locations spanning multiple
    // files (domain, routes, repository).
    {
      const pos = positionOf(SOURCE, "aggregate Order {");
      const aggPos = { line: pos.line, character: pos.character + "aggregate ".length };
      const links = await provider.getImplementation(doc, {
        textDocument: { uri: doc.textDocument.uri },
        position: aggPos,
      });
      expect(links, "expected locations for the aggregate-name position").toBeDefined();
      const files = new Set(links!.map((l) => l.targetUri.split("/").slice(-2).join("/")));
      expect(files.has("domain/order.ts")).toBe(true);
      expect(files.size).toBeGreaterThan(1);
    }

    // (5) negative — cursor on the `Money` valueobject: no construct
    // regions for value objects, so expect no result and no throw.
    {
      const pos = positionOf(SOURCE, "Money {");
      const links = await provider.getImplementation(doc, {
        textDocument: { uri: doc.textDocument.uri },
        position: pos,
      });
      expect(links ?? []).toEqual([]);
    }

    // (d) M9 end-to-end: cursor inside the HAND-WRITTEN page — the derived
    // area-qualified id (snake()d segments) must actually hit the region
    // the react frontend recorded, landing on the emitted page file. This
    // automates the manual probe that caught the Back vs back casing
    // divergence during M9.
    {
      const pos = positionOf(SOURCE, 'route: "/board"');
      const links = await provider.getImplementation(doc, {
        textDocument: { uri: doc.textDocument.uri },
        position: pos,
      });
      expect(links, "expected locations for the hand-written page position").toBeDefined();
      expect(links!.length).toBeGreaterThan(0);
      for (const link of links!) {
        expect(link.targetUri.endsWith("web_app/src/pages/back/order_board.tsx")).toBe(true);
      }
    }
  });

  // (c) a document with NO discoverable map (a second, isolated tmp dir
  // with no `out/` tree) — expect empty/undefined, no throw.
  //
  // NESTED FIVE DEEP ON PURPOSE, and it is the assertion as much as the setup.
  // This is the only case where discovery finds nothing, so it is the only one
  // that runs the ancestor walk to its `MAX_ANCESTOR_LEVELS` bound — and at each
  // ancestor it scans that ancestor's immediate children.  Rooted directly under
  // `tmp`, the walk therefore climbs OUT of the fixture and enumerates the shared
  // system temp dir, one `.loom/sourcemap.json` probe per entry.  Two costs, both
  // real: it is not hermetic (a stray map another suite leaves in os.tmpdir()
  // decides this assertion), and it is slow in proportion to how full /tmp is —
  // measured here at 238ms against 4ms nested, which is what made this the one
  // test in the file to time out under full-suite parallel load.
  //
  // Five levels of nesting keeps every one of the walk's six probes inside the
  // fixture, so the test now also PINS that the walk stays bounded.  The
  // neighbour case below already had this protection and says so; this one did
  // not.
  it("returns no result (and does not throw) when no sourcemap is discoverable", async () => {
    const otherDir = path.join(tmp, "no-map-project", "a", "b", "c", "d");
    const { services, doc } = await loadRealDocument(otherDir, "main.ddd", SOURCE);
    const provider = services.Ddd.lsp.ImplementationProvider!;
    const pos = positionOf(SOURCE, "customerName\n");
    const links = await provider.getImplementation(doc, {
      textDocument: { uri: doc.textDocument.uri },
      position: pos,
    });
    expect(links ?? []).toEqual([]);
  });

  // (c2) a NEIGHBOUR project's map must not be adopted.
  //
  // Discovery walks UP and, at every ancestor, also scans that ancestor's
  // immediate children — so a generated out-dir sitting BESIDE this project is
  // on the search path. `matchPath` is a longest-common-SUFFIX match that
  // accepts a single shared segment, and two independent projects that both
  // call their entry point `main.ddd` share exactly that one segment. Without a
  // strength floor the neighbour's map wins and "Go to Implementation" lands in
  // the WRONG project's generated files — silently, because the locations
  // returned are real files at real lines.
  //
  // The neighbour here is a REAL generated tree, not a stub: a hand-written map
  // with an empty `files` yields no regions, so the assertion would hold with or
  // without the fix and prove nothing. (It did, in the first draft of this test.)
  it("does not adopt a NEIGHBOUR project's map that matches only on the filename", async () => {
    // Both projects live under one workspace dir, so neither reaches for the
    // shared system temp dir — the collision is fully local to this fixture.
    const ws = path.join(tmp, "workspace");
    const subjectDir = path.join(ws, "app-a");
    const { services, doc } = await loadRealDocument(subjectDir, "main.ddd", SOURCE);

    // The neighbour: a different project, generated with `--sourcemap` into an
    // out-dir that sits beside the subject — exactly what `generate system -o`
    // produces, and exactly what the ancestor child-scan looks at.
    const neighbourSrcDir = path.join(ws, "app-b");
    const { doc: neighbourDoc } = await loadRealDocument(neighbourSrcDir, "main.ddd", SOURCE);
    writeGeneratedTree(
      neighbourDoc.parseResult.value,
      new Map([[neighbourDoc.uri.path, SOURCE]]),
      path.join(ws, "app-b-out"),
    );

    const provider = services.Ddd.lsp.ImplementationProvider!;
    const pos = positionOf(SOURCE, "customerName\n");
    const links = await provider.getImplementation(doc, {
      textDocument: { uri: doc.textDocument.uri },
      position: pos,
    });
    expect(
      (links ?? []).map((l) => l.targetUri),
      "app-b's map shares only the filename `main.ddd` with app-a's document — " +
        "adopting it navigates into ANOTHER project's generated output",
    ).toEqual([]);
  });

  // Discovery's ANCESTOR walk — the first test's doc sits right beside the
  // out dir (level-0 child scan). Here the doc is nested two directories
  // below the project root, so discovery must walk UP (src/orders →
  // src → project) before the child scan can see project/out/.loom.
  it("discovers a map two ancestor levels up from a nested document", async () => {
    const deepProject = path.join(tmp, "deep-project");
    const deepDocDir = path.join(deepProject, "src", "orders");
    const { services, doc } = await loadRealDocument(deepDocDir, "main.ddd", SOURCE);
    const model = doc.parseResult.value;
    writeGeneratedTree(model, new Map([[doc.uri.path, SOURCE]]), path.join(deepProject, "out"));

    const provider = services.Ddd.lsp.ImplementationProvider!;
    const pos = positionOf(SOURCE, "customerName\n");
    const links = await provider.getImplementation(doc, {
      textDocument: { uri: doc.textDocument.uri },
      position: pos,
    });
    expect(links, "expected the nested document to discover project/out").toBeDefined();
    expect(links!.length).toBeGreaterThan(0);
    for (const link of links!) {
      expect(link.targetUri.includes("/deep-project/out/")).toBe(true);
      expect(link.targetUri.endsWith("hono_api/domain/order.ts")).toBe(true);
    }
  });
});
