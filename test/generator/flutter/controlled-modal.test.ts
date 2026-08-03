// Flutter's state-controlled Modal — `Modal { …, open: <state bool> }`.
//
// This primitive had NO Dart renderer: Flutter's dialogs are imperative
// (`showDialog` pushes a route), so there is no widget to conditionally render,
// and the declarative `open:` shape fell through the target seam to a comment —
// silently dropping the dialog and everything inside it, while telling the
// author to write a shape they hadn't asked for.
//
// `LoomModalHost` (lib/modal.dart) is the bridge: a zero-size widget that drives
// `showDialog` on the flag's rising edge and reports the dismissal back so the
// page's state stays the single source of truth.  These tests pin the WIRING —
// the Dart itself is compiled by `generated-flutter-build` (`flutter analyze` +
// `flutter test` + `flutter build web`), which is a per-PR gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (body: string, state = `state { archiveOpen: bool = false }`): string => `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource s { for: Cat, kind: state, use: db }
  ui WebApp {
    framework: flutter
    api Shop: ShopApi
    page Home {
      route: "/"
      ${state}
      body: ${body}
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: WebApp { Shop: api } port: 3006 }
}`;

const CONTROLLED = `Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }`;

async function files(body: string, state?: string): Promise<Map<string, string>> {
  return generateSystemFiles(SRC(body, state));
}

const fileEndingWith = (fs: Map<string, string>, suffix: string): string | undefined =>
  [...fs].find(([p]) => p.endsWith(suffix))?.[1];

describe("flutter — state-controlled Modal", () => {
  it("renders LoomModalHost bound to the state flag and its Notifier setter", async () => {
    const page = fileEndingWith(await files(CONTROLLED), "home_page.dart")!;
    // No degradation comment: the primitive is rendered, not explained away.
    expect(page).not.toContain("/* Modal:");
    // Read through the projected state, released through the Notifier setter —
    // the same two seams every other Flutter state binding uses.
    expect(page).toContain("LoomModalHost(open: state.archiveOpen");
    expect(page).toContain("onClose: () => notifier.setArchiveOpen(false)");
  });

  it("the title is the translated modalTitle slot, and the body is the authored content", async () => {
    const page = fileEndingWith(await files(CONTROLLED), "home_page.dart")!;
    expect(page).toMatch(/title: Text\(t\('page\.Home\.modalTitle\.\w+', 'Archive'\)\)/);
    expect(page).toMatch(/child: Column\([^)]*children: <Widget>\[/);
    expect(page).toMatch(/t\('page\.Home\.text\.\w+', 'Confirm archive\?'\)/);
  });

  it("children are COMMA-separated — a Dart list, not juxtaposed JSX", async () => {
    // The shared `emitControlledModal` used to join children with a bare newline
    // (the JSX assumption), which is invalid inside a `<Widget>[…]` literal.
    const page = fileEndingWith(
      await files(`Modal { Text { "one" }, Text { "two" }, open: archiveOpen }`),
      "home_page.dart",
    )!;
    const list = /children: <Widget>\[([\s\S]*?)\]\)\)/.exec(page)?.[1] ?? "";
    expect(list).toContain("'one'");
    expect(list).toContain("'two'");
    expect(list.split("Text(").length - 1).toBeGreaterThan(1);
    // Every child but the last is comma-terminated.
    expect(list).toMatch(/'one'\)\),/);
  });

  it("emits lib/modal.dart and imports it — only where a Modal is used", async () => {
    const withModal = await files(CONTROLLED);
    expect(fileEndingWith(withModal, "lib/modal.dart")).toBeDefined();
    expect(fileEndingWith(withModal, "home_page.dart")).toContain("import '../modal.dart';");

    // An unused Dart import is an analyzer warning and `flutter analyze` gates
    // per-PR, so a page without a Modal must carry neither file nor import.
    const without = await files(`Text { "plain" }`);
    expect(fileEndingWith(without, "lib/modal.dart")).toBeUndefined();
    expect(fileEndingWith(without, "home_page.dart")).not.toContain("modal.dart");
  });

  it("the bridge latches, defers past the build, and reports dismissal", async () => {
    // The three details that make it correct rather than merely plausible.
    const runtime = fileEndingWith(await files(CONTROLLED), "lib/modal.dart")!;
    // 1. showDialog mutates the navigator — never during a build.
    expect(runtime).toContain("addPostFrameCallback");
    // 2. didUpdateWidget fires on every rebuild; without the latch a rebuild
    //    while open stacks a second dialog.
    expect(runtime).toContain("if (!widget.open || _shown) return;");
    // 3. A barrier tap / back button dismisses the route without touching the
    //    flag — the state would be stuck true and never reopen.
    expect(runtime).toMatch(/\.then\(\(_\) \{[\s\S]*widget\.onClose\(\);/);
    expect(runtime).toContain("if (!mounted) return;");
  });

  it("still renders the OP-DIALOG shape (the seam falls through, not away)", async () => {
    // Returning null from `renderModal` for the non-op shape must not cost the
    // op-dialog shape its own renderer.
    const src = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product { name: string  operation archive(reason: string) { } }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource s { for: Cat, kind: state, use: db }
  ui WebApp {
    framework: flutter
    api Shop: ShopApi
    page Detail(id: string) {
      route: "/p/:id"
      body: Modal { OperationForm { of: Product, op: archive }, title: "Arch", trigger: Button { "Go" } }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: WebApp { Shop: api } port: 3006 }
}`;
    const page = fileEndingWith(await generateSystemFiles(src), "detail_page.dart")!;
    expect(page).toContain("showDialog(context: context,");
    expect(page).toContain("AlertDialog(title: Text(");
    expect(page).not.toContain("LoomModalHost(");
  });
});
