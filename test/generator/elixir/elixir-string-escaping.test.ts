// ---------------------------------------------------------------------------
// The Elixir `#{` escaping funnel, reached through the EMITTERS (F2-ELX-ESCAPE-
// FUNNEL).
//
// `test/generator/hostile-inputs.test.ts` names this hazard in its header ("a
// value like `\"hi#{System.cmd(...)}\"` executes at Elixir compile time") but
// only exercises `renderElixirExpr` / `elixirString` directly — so four emit
// sites that spliced a `.ddd` string with a bare `JSON.stringify` were never
// reached by it (the `experience_gathered.md` §59/§63 "check that never reaches
// the thing it names" shape):
//
//   1. the Ecto schema `default:`      — `schema-emit.ts` `renderEctoDefault`
//      (interpolates in the module BODY, i.e. at `mix compile` time)
//   2. the wire-validation 422 entry   — `denial.ts` `wireValidationTerm`
//   3. the residual-invariant message  — `changeset-invariant-emit.ts`
//   4. the realtime LiveView toast     — `realtime-liveview.ts`
//
// Wave 1 (packet 1d) re-swept the emitter for the same shape and found FOUR
// MORE bare-`JSON.stringify` splices of `.ddd`-authored text, each proven by
// generation:
//
//   5. the VALUE-OBJECT invariant validators — `changeset-validators.ts`, both
//      carriers: the code-point `validate_change` error tuple and the
//      `validate_number` / `validate_format` `message:` option.  (A value
//      object has no residual `add_error` carrier, so an author `message "…"`
//      rides the native Ecto validator — the one path site 3 does not reach.)
//   6. the page `state` string initialiser — `heex-walker-core.ts`
//      `elixirLiteral`, spliced into the LiveView `mount/3` assigns
//   7. the page-handler `requires` / `precondition` flash — same file, which
//      splices `stmt.source` (verbatim `.ddd` text, so it can carry a literal)
//   8. the OIDC config literals — `auth-emit.ts` `elixirAuthValue` /
//      `envOrDeclared`, i.e. a declared `issuer:` / `clientId:` string, read on
//      every request by the emitted auth module and controller
//   9. the declared CLAIM PATH — `auth-emit.ts` (`claims: { role: "…" }`),
//      spliced into every principal projection's `get_claim/2`
//
// and two same-shape ones fixed alongside without a fixture here
// (`store-emit.ts` `renderStoreLiteral`, `tests-emit.ts` `renderLiteral`).
//
// This suite asserts on the GENERATED Elixir, so it fails if any one of them
// stops routing through `elixirString`.  Fixtures carry a real payload
// (`:erlang.halt/1`, `System.halt/1`) so the failure mode is unambiguous.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** No `#{` may appear unescaped (i.e. not preceded by a backslash). */
function expectNoLiveInterpolation(line: string): void {
  expect(line).toMatch(/#\{/); // the payload really is in the line under test
  expect(line).not.toMatch(/(^|[^\\])#\{/);
}

// Default + residual invariant message + wire-translatable precondition message,
// all on one elixir deployable.
const HOSTILE = `system Hostile {
  subdomain Catalog {
    context Catalog {
      aggregate Product with crudish {
        name: string
        stock: int
        note: string = "boot #{:erlang.halt(3)} end"
        invariant name != "safe" message "bad #{:erlang.halt()} name"
        operation restock(amount: int) {
          precondition amount >= 1 message "at least 1 - #{System.halt(1)}"
          stock := stock + amount
        }
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable d { platform: elixir  contexts: [Catalog]  dataSources: [catalogState]  serves: CatalogApi  port: 4000 }
}`;

// A realtime channel subscription with a `toast(...)` whose literal carries the
// payload — the LiveView `handle_info` → `put_flash` path.
const HOSTILE_TOAST = `system HostileToast {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string = "Draft"
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Live { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
    }
  }
  api OrdersApi from Sales
  ui Admin with scaffold(subdomains: [Sales]) {
    api Orders: OrdersApi
    channel Live: Orders.Live
    on Live.OrderPlaced(e) { toast("Order placed #{System.halt(9)}") }
  }
  storage pg { type: postgres }
  storage bus { type: redis }
  resource ordersState { for: Orders, kind: state, use: pg }
  channelSource liveBus { for: Live, use: bus }
  deployable d {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    channels: [liveBus]
    serves: OrdersApi
    ui: Admin { Orders: d }
    port: 4000
  }
}`;

// A VALUE OBJECT's messaged invariants: no residual `add_error` carrier exists
// for a VO, so the author text rides Ecto's own validators — the arm the
// aggregate fixture above never reaches.
const HOSTILE_VO = `system HostileVo {
  subdomain Catalog {
    context Catalog {
      valueobject Label {
        text: string
        weight: int
        invariant text.length >= 3 message "short #{:erlang.halt(1)} label"
        invariant weight >= 0 message "neg #{:erlang.halt(2)} weight"
      }
      aggregate Product with crudish {
        name: string
        tag: Label
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable d { platform: elixir  contexts: [Catalog]  dataSources: [catalogState]  serves: CatalogApi  port: 4000 }
}`;

// The page half: a `state` string initialiser (spliced into `mount/3`) and a
// handler guard whose flash carries the verbatim `.ddd` source of its predicate.
const HOSTILE_PAGE = `system HostilePage {
  subdomain Catalog {
    context Catalog {
      aggregate Product with crudish {
        name: string
        stock: int
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  ui Admin {
    api Catalog: CatalogApi
    page Home {
      route: "/"
      state {
        note: string = "boot #{:erlang.halt(3)} end"
      }
      action bump() {
        precondition note != "guard #{:erlang.halt(4)} end"
        note := "ok"
      }
      body: Stack { Text { note } }
    }
  }
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    ui: Admin { Catalog: d }
    port: 4000
  }
}`;

// A declared (non-`env(...)`) OIDC issuer / clientId: `.ddd` text that lands as
// the `System.get_env/2` default in the emitted auth module AND controller.
const HOSTILE_AUTH = `system HostileAuth {
  user {
    id: string
    role: string
  }
  auth {
    provider: keycloak
    oidc {
      issuer: "https://idp.example/#{:erlang.halt(7)}"
      clientId: "cid#{:erlang.halt(8)}"
    }
    sessions: cookie
    claims: { role: "realm_access#{:erlang.halt(9)}.roles" }
  }
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish {
        subject: string
        open: bool
        operation close() {
          requires currentUser.role == "agent"
          open := false
        }
      }
      repository Tickets for Ticket { }
    }
  }
  api SupportApi from Support
  storage primary { type: postgres }
  resource ticketState { for: Tickets, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Tickets]
    dataSources: [ticketState]
    serves: SupportApi
    auth: required
    port: 4000
  }
}`;

function findLine(files: Map<string, string>, suffix: string, needle: string): string {
  const path = [...files.keys()].find((p) => p.endsWith(suffix));
  expect(path, `no emitted file ends with ${suffix}`).toBeTruthy();
  const line = (files.get(path as string) as string).split("\n").find((l) => l.includes(needle));
  expect(line, `no line containing '${needle}' in ${suffix}`).toBeTruthy();
  return line as string;
}

describe("Elixir emitters route `.ddd` strings through the escaping funnel", () => {
  it("the Ecto schema `default:` does not interpolate at compile time", async () => {
    const files = await generateSystemFiles(HOSTILE);
    const line = findLine(files, "lib/d/catalog/product.ex", "field :note");
    expectNoLiveInterpolation(line);
  });

  it("the residual-invariant `add_error` message does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE);
    const line = findLine(
      files,
      "lib/d/catalog/product_changeset.ex",
      "add_error(changeset, :name",
    );
    expectNoLiveInterpolation(line);
  });

  it("the wire-validation 422 message does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE);
    const line = findLine(files, "lib/d/catalog.ex", ":validation_failed");
    expectNoLiveInterpolation(line);
  });

  it("the realtime LiveView toast does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_TOAST);
    const line = findLine(files, "lib/d_web/live/home_live.ex", "put_flash(:info,");
    expectNoLiveInterpolation(line);
  });

  it("the value-object length validator's error tuple does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_VO);
    const line = findLine(files, "lib/d/catalog/label.ex", "validation: :length");
    expectNoLiveInterpolation(line);
  });

  it("the value-object `validate_number` message option does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_VO);
    const line = findLine(files, "lib/d/catalog/label.ex", "validate_number(:weight");
    expectNoLiveInterpolation(line);
  });

  it("the page `state` string initialiser does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_PAGE);
    const line = findLine(files, "lib/d_web/live/home_live.ex", "assign(:note,");
    expectNoLiveInterpolation(line);
  });

  it("the page-handler guard flash does not interpolate its `.ddd` source text", async () => {
    const files = await generateSystemFiles(HOSTILE_PAGE);
    const line = findLine(files, "lib/d_web/live/home_live.ex", "put_flash(socket, :error,");
    expectNoLiveInterpolation(line);
  });

  it("a declared OIDC issuer / clientId does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_AUTH);
    // Both emit sites: the auth module and the auth controller read the same
    // declared literal through their own copy of the `System.get_env/2` default.
    expectNoLiveInterpolation(findLine(files, "lib/d_web/auth.ex", "def issuer,"));
    expectNoLiveInterpolation(
      findLine(files, "lib/d_web/controllers/auth_controller.ex", "defp client_id,"),
    );
  });

  it("a declared claim PATH does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_AUTH);
    expectNoLiveInterpolation(findLine(files, "lib/d_web/auth.ex", "role: get_claim(claims,"));
  });
});
