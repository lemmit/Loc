import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Event-sourced append → Dispatcher fan-out.  An event-sourced aggregate's
// appended events reach the in-process Dispatcher so workflow saga handlers
// fire (the ES analogue of the state path's emit→PubSub) — but only when the
// context actually emits a Dispatcher (i.e. has a resolvable subscription),
// since `<Ctx>.Dispatcher` is otherwise undefined.
// ---------------------------------------------------------------------------

const WITH_SAGA = `
system Sales {
  subdomain Core {
    context Orders {
      event OrderPlaced { order: Order id, at: datetime }
      event Fulfilled { order: Order id }
      aggregate Order persistedAs(eventLog) {
        status: string
        create place() { emit OrderPlaced { order: id, at: now() } }
        operation fulfill() { emit Fulfilled { order: id } }
        apply(e: OrderPlaced) { status := "placed" }
        apply(e: Fulfilled) { status := "fulfilled" }
      }
      repository Orders for Order { }
      channel Lifecycle { carries: OrderPlaced, Fulfilled  delivery: broadcast  retention: ephemeral }
      workflow Tracking {
        orderId: Order id
        attempts: int
        create(p: OrderPlaced) by p.order {
          let o = Orders.getById(p.order)
          o.fulfill()
        }
      }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource es { for: Orders, kind: eventLog, use: pg }
  deployable api { platform: elixir contexts: [Orders] dataSources: [es] serves: A port: 4000 }
}
`;

// No workflow subscribes to the aggregate's events → no Dispatcher is emitted.
const NO_SAGA = `
system L {
  subdomain Core {
    context Accounts {
      event Opened { account: Account id }
      aggregate Account persistedAs(eventLog) {
        owner: string
        create open() { emit Opened { account: id } }
        apply(e: Opened) { owner := "" }
      }
      repository Accounts for Account { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource es { for: Accounts, kind: eventLog, use: pg }
  deployable api { platform: elixir contexts: [Accounts] dataSources: [es] serves: A port: 4000 }
}
`;

const repoOf = (files: Map<string, string>, suffix: string) =>
  files.get([...files.keys()].find((k) => k.endsWith(suffix))!)!;

describe("vanilla — ES append → Dispatcher fan-out", () => {
  it("dispatches each appended event when the context has a saga subscription", async () => {
    const files = await generateSystemFiles(WITH_SAGA);
    const repo = repoOf(files, "/orders/order_repository.ex");
    expect(repo).toContain("Api.Orders.Dispatcher.dispatch(ev)");
    // …and the Dispatcher the call targets is actually emitted.
    expect([...files.keys()].some((k) => k.endsWith("/orders/dispatcher.ex"))).toBe(true);
  });

  it("omits the dispatch call when the context emits no Dispatcher", async () => {
    const files = await generateSystemFiles(NO_SAGA);
    const repo = repoOf(files, "/accounts/account_repository.ex");
    expect(repo).not.toContain("Dispatcher.dispatch");
    expect([...files.keys()].some((k) => k.endsWith("/accounts/dispatcher.ex"))).toBe(false);
  });
});
