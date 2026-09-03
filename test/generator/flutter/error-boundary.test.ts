// M-T1.8 — global error boundary + failure sink, flutter arm.
//
// Flutter has no `componentDidCatch`-style class-component hook to wrap the
// way the JSX frontends' `ErrorBoundary` does, so `main.dart` sets three of
// the framework's own hooks instead:
//
//   - `ErrorWidget.builder` — replaces a crashed widget subtree with a
//     readable fallback instead of the framework's default grey error box
//     (the render-time half, the direct analogue of `componentDidCatch`).
//   - `FlutterError.onError` — the framework's own uncaught-error terminus
//     (a gesture callback / layout-pass exception outside `build()`).
//   - `runZonedGuarded` — the failure sink for a bare `async` callback with
//     no `try`/`catch`, the mobile analogue of an unhandled-promise-
//     rejection handler ("Unhandled-`await` terminus", M-T1.8's own wording).
//
// Fable — sorry, Flutter — compile-verified via `flutter analyze` in the
// `ghcr.io/cirruslabs/flutter:stable` container (docs/tools.md).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (extraPage = "") => `
system Shop {
  subdomain Sales { context Orders {
    aggregate Order { customerId: string }
    repository Orders for Order { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    api Shop: ShopApi
    page CartPage {
      route: "/cart"
      body: Stack { Heading { "Cart", level: 1 } }
    }
    ${extraPage}
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

async function mainDart(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const key = [...files.keys()].find((p) => p.endsWith("lib/main.dart"));
  expect(key, "main.dart emitted").toBeDefined();
  return files.get(key!)!;
}

describe("flutter error boundary + failure sink (M-T1.8)", () => {
  it("imports dart:async for runZonedGuarded", async () => {
    const main = await mainDart(SYS());
    expect(main).toContain("import 'dart:async';");
  });

  it("sets ErrorWidget.builder — a crashed subtree renders a readable fallback", async () => {
    const main = await mainDart(SYS());
    expect(main).toContain("ErrorWidget.builder = (FlutterErrorDetails details) {");
    expect(main).toContain("debugPrint('Uncaught render error: ${details.exception}');");
    expect(main).toContain("'Something went wrong.',");
  });

  it("sets FlutterError.onError as the framework's own uncaught-error terminus", async () => {
    const main = await mainDart(SYS());
    expect(main).toContain("FlutterError.onError = (FlutterErrorDetails details) {");
    expect(main).toContain("FlutterError.presentError(details);");
  });

  it("wraps runApp in runZonedGuarded with a logging onError callback", async () => {
    const main = await mainDart(SYS());
    expect(main).toContain("runZonedGuarded(() {");
    expect(main).toContain("runApp(const App());");
    expect(main).toContain("}, (Object error, StackTrace stack) {");
    expect(main).toContain("debugPrint('Unhandled error: $error');");
  });

  it("main() stays a plain sync function — the boundary setup runs before the zone, not inside an async main", async () => {
    const main = await mainDart(SYS());
    expect(main).toContain("void main() {");
    expect(main).not.toContain("Future<void> main() async {");
  });
});
