// Realtime SSE consumption — Flutter (Dart/Riverpod) frontend (channels.md
// Part I).
//
// Flutter had NO realtime path at all: `SSE_REALTIME_FRONTENDS` excluded it, so
// `on <channel>.<Event>` handlers on a Flutter-hosted ui compiled clean, emitted
// nothing, and warned (`loom.ui-realtime-unsupported#frontend-has-no-consumer`).
// The port emits one subscription against `/realtime/events`, a transient
// `SnackBar` per `toast(…)`, and a `ref.invalidate(<var>Provider)` per
// `refetch(<Agg>)`.
//
// Two things the assertions pin because they are the load-bearing Flutter
// decisions:
//
//   * the TRANSPORT is a conditional import — the browser's own `EventSource`
//     on the web (`package:http`'s browser client is XHR-backed and buffers the
//     whole body, so a never-ending stream never yields a frame) and a line
//     parser over a streamed `package:http` response natively;
//   * the REFETCH is `ref.invalidate`, which on a `.family` provider refetches
//     every live instance — so a server-paged table reloads the page the user is
//     actually on, without the `Refetch<Field>` Msg hop Feliz needs.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (backend = "node") => `
system RtFlutterShop {
  subdomain Shipping {
    context Fulfillment {
      aggregate Order { customerId: string  status: string  total: int }
      repository Orders for Order { }

      event OrderPlaced { order: Order id, at: datetime }

      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Fulfillment, kind: state, use: primary }
  api FulfillmentApi from Shipping
  ui WebApp {
    api Fulfillment: FulfillmentApi
    channel Live: Fulfillment.Lifecycle
    on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }
    page Home {
      route: "/"
      body: Stack {
        Heading { "Orders", level: 1 },
        QueryView {
          of: Fulfillment.Order.all,
          loading: Text { "…" }, error: Text { "err" }, empty: Text { "none" },
          data: rows => Stack { For { each: rows, o => Card { o.customerId } } }
        }
      }
    }
  }
  deployable backend {
    platform: ${backend}
    contexts: [Fulfillment]
    serves: FulfillmentApi
    dataSources: [st]
    port: 3000
  }
  deployable webApp {
    platform: flutter
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
  }
}`;

const gen = (backend?: string) => generateSystemFiles(SYS(backend));

describe("flutter realtime — the subscription", () => {
  it("mounts one subscription for as long as the app runs", async () => {
    const dart = (await gen()).get("web_app/lib/realtime.dart")!;
    expect(dart).toContain("const List<String> loomRealtimeEvents = <String>['OrderPlaced'];");
    expect(dart).toContain("class LoomRealtime extends ConsumerStatefulWidget {");
    expect(dart).toContain(
      "_subscription = loomEventSource(apiUri('/realtime/events'), loomRealtimeEvents)",
    );
    expect(dart).toContain("_subscription?.cancel();");
  });

  it("toasts the v1 message subset, reading the payload defensively", async () => {
    const dart = (await gen()).get("web_app/lib/realtime.dart")!;
    expect(dart).toContain("case 'OrderPlaced':");
    expect(dart).toContain("_toast('Order ' + '${payload['order']}' + ' placed');");
    // An undecodable frame degrades to an empty map — it never tears the
    // subscription down.
    expect(dart).toContain("Map<String, dynamic> payload = const <String, dynamic>{};");
    expect(dart).toContain("} catch (_) {}");
    expect(dart).toContain(
      "ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));",
    );
  });

  it("refetches by INVALIDATING the read provider, not by re-issuing the call", async () => {
    const dart = (await gen()).get("web_app/lib/realtime.dart")!;
    expect(dart).toContain("import 'reads.dart';");
    expect(dart).toContain("ref.invalidate(orderAllProvider);");
  });

  it("rides MaterialApp.builder so a toast has a ScaffoldMessenger ancestor", async () => {
    const main = (await gen()).get("web_app/lib/main.dart")!;
    expect(main).toContain("import 'realtime.dart';");
    expect(main).toContain("builder: (context, child) =>");
    expect(main).toContain("LoomRealtime(child: child ?? const SizedBox.shrink()),");
  });
});

describe("flutter realtime — the transport", () => {
  it("picks the implementation by compile-time conditional import", async () => {
    const out = await gen();
    expect(out.get("web_app/lib/realtime_source.dart")!).toContain(
      "export 'realtime_source_io.dart'\n    if (dart.library.js_interop) 'realtime_source_web.dart';",
    );
    // One event record both halves produce.
    expect(out.get("web_app/lib/realtime_event.dart")!).toContain("class LoomServerEvent {");
  });

  it("web uses the browser's own EventSource", async () => {
    const dart = (await gen()).get("web_app/lib/realtime_source_web.dart")!;
    expect(dart).toContain("import 'package:web/web.dart' as web;");
    expect(dart).toContain("final es = web.EventSource(uri.toString());");
    expect(dart).toContain("es.addEventListener(");
    expect(dart).toContain("source?.close();");
  });

  it("native parses SSE frames off a streamed package:http response", async () => {
    const dart = (await gen()).get("web_app/lib/realtime_source_io.dart")!;
    expect(dart).toContain("..headers['Accept'] = 'text/event-stream';");
    expect(dart).toContain(
      "response.stream.transform(utf8.decoder).transform(const LineSplitter())",
    );
    expect(dart).toContain("} else if (line.startsWith('event:')) {");
    expect(dart).toContain("if (data.isNotEmpty) yield LoomServerEvent(type, data.toString());");
    expect(dart).toContain("client.close();");
  });

  it("pulls package:web only when a handler exists", async () => {
    expect((await gen()).get("web_app/pubspec.yaml")!).toContain("web: ^1.1.0");
  });
});

describe("flutter realtime — the honest-gap half stays honest", () => {
  it("emits nothing when the target backend serves no SSE wire", async () => {
    // The elixir backend realizes realtime NATIVELY over its own socket, so it
    // does not serve `GET /realtime/events` — a flutter ui pointed at it must
    // not open a subscription to a route that isn't there.
    const out = await gen("elixir");
    expect(out.has("web_app/lib/realtime.dart")).toBe(false);
    expect(out.has("web_app/lib/realtime_source.dart")).toBe(false);
    expect(out.get("web_app/pubspec.yaml")!).not.toContain("web: ^1.1.0");
    expect(out.get("web_app/lib/main.dart")!).not.toContain("LoomRealtime");
  });
});
