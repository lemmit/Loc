// Feliz entity-history reads (docs/audit.md) — a `QueryView(of: X.history(id))`
// on a `:id`-param route projects to a page-entry-keyed `Remote<AuditEntry list>`
// Model field (fired by `pageCmd` off the route id like a byId read, but
// LIST-shaped — matched by `View.remoteList`), a `GET /<aggs>/{id}/history` Api
// fetch decoding the fixed `auditEntryDecoder`, and a native `Timeline` ordered
// list (`felizTarget.renderTimeline`).
//
// The load-bearing negative is asserted in both fixtures: the history read must
// bind its OWN `<Agg>History` field, never the `All<Plural>` list — the
// misbinding that kept feliz out of `HISTORY_CAPABLE_FRAMEWORKS` (a target that
// renders the primitive but binds the wrong read looks like it works, which is
// worse than rendering nothing).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// Hand-written detail page hosting BOTH page-entry reads — the record byId and
// the audit trail — so the shared-`Page`-case `pageCmd` batching is exercised.
// Bare-aggregate query roots (`Order.history(id)`, detector Pattern E), the
// same shape the scaffold macro emits — an api-param-rooted chain would trip
// `checkApiBodyRefs`, whose op list doesn't know the DERIVED history find.
const DETAIL = `
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Order audited with crudish { reference: string  quantity: int }
      repository Orders for Order { }
    }
  }
  storage db { type: postgres }
  resource salesState { for: Sales, kind: state, use: db }
  ui WebApp {
    page OrderDetail {
      route: "/orders/:id"
      body: Stack {
        Heading { "Order", level: 1 },
        QueryView {
          of: Order.byId(id),
          single: true,
          loading: Text { "Loading…" },
          error: Text { "Failed" },
          empty: Text { "Not found" },
          data: o => Card { o.reference }
        },
        QueryView {
          of: Order.history(id),
          loading: Text { "Loading…" },
          error: Text { "Couldn't load history" },
          empty: Text { "No history yet." },
          data: entries => Timeline { of: entries, testid: "orders-detail-history-timeline" }
        }
      }
    }
  }
  deployable api { platform: node contexts: [Sales] dataSources: [salesState] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

/** The scaffolded twin (the cross-target fixture's feliz cell) — the macro's
 *  History section reaches the same wiring end-to-end.  `audited` on/off is the
 *  only knob, so any output difference is attributable to the trail. */
const scaffoldSystem = (audited: boolean): string => `
  system HistoryDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order ${audited ? "audited " : ""}with crudish {
          reference: string
          quantity: int
        }
        repository Orders for Order { }
      }
    }
    ui Web with scaffold(subdomains: [Ordering]) { }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: node, contexts: [Ordering], dataSources: [orderingState], port: 3000
    }
    deployable web { platform: feliz, targets: api, ui: Web, port: 3001 }
  }
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz entity-history read — MVU projection", () => {
  it("projects the read to its own Remote<AuditEntry list> Model field + Msg", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain("OrderHistory: Remote<AuditEntry list>");
    expect(app).toContain("| OrderHistoryLoaded of Result<AuditEntry list, string>");
    // Never bound to the unfiltered list — the page has no `.all` read, so the
    // `All<Plural>` field must not exist AT ALL (the misbinding the old
    // `buildHookUse` fallback would have produced).
    expect(app).not.toContain("AllOrders");
  });

  it("emits the fixed AuditEntry records + Thoth decoders once", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain("type AuditEntry =");
    expect(app).toContain("type AuditFieldChange =");
    expect(app).toContain("let auditEntryDecoder : Decoder<AuditEntry> =");
    expect(app).toContain("let auditFieldChangeDecoder : Decoder<AuditFieldChange> =");
    expect(app).toContain(
      '      changes = get.Required.Field "changes" (Decode.list auditFieldChangeDecoder)',
    );
  });

  it("emits the history Api fetch — (id: string) over GET /<aggs>/{id}/history", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain(
      "let orderHistory (id: string) : Async<Result<AuditEntry list, string>> =",
    );
    expect(app).toContain('let! (status, body) = Http.get (sprintf "/api/orders/%s/history" id)');
    expect(app).toContain("match Decode.fromString (Decode.list auditEntryDecoder) body with");
  });

  it("fires on page entry — pageCmd BATCHES the byId + history reads on one Page case", async () => {
    const app = await appFs(DETAIL);
    // A second `| OrderDetail id ->` arm would be unreachable (FS0026) and its
    // fetch would silently never fire — the two page-entry reads share the case,
    // so they must share the arm.
    expect(app).toContain(
      "  | OrderDetail id -> Cmd.batch [ Cmd.OfAsync.perform Api.orderById id OrderByIdLoaded; " +
        "Cmd.OfAsync.perform Api.orderHistory id OrderHistoryLoaded ]",
    );
    // Init seeds it Loading; UrlChanged resets BOTH page-entry fields.
    expect(app).toContain("      OrderHistory = Loading");
    expect(app).toContain(
      "{ model with CurrentPage = page; OrderById = Loading; OrderHistory = Loading }, pageCmd page",
    );
  });

  it("renders the QueryView through View.remoteList over the history field", async () => {
    const app = await appFs(DETAIL);
    // LIST-shaped although page-entry keyed — the one read where the two facts
    // come apart (`FelizRead.history`).
    expect(app).toContain("(View.remoteList model.OrderHistory");
    expect(app).toContain("(fun orderHistory ->");
  });

  it("renders Timeline as a native ordered list mirroring the react markup", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain(
      'Html.orderedList [ prop.custom("data-testid", "orders-detail-history-timeline"); prop.className "loom-timeline";',
    );
    expect(app).toContain('prop.className "loom-timeline-entry"');
    expect(app).toContain('prop.className "loom-timeline-action"; prop.text __e.action');
    expect(app).toContain('Html.time [ prop.custom("dateTime", __e.at); prop.text __e.at ]');
    // Actor renders only when recorded.
    expect(app).toContain(
      'match __e.actor with Some __a -> Html.span [ prop.className "loom-timeline-actor"; prop.text __a ] | None -> Html.none',
    );
    // The changes <dl> is conditional; the entry header is not (a command that
    // touched only diff-excluded fields still happened).
    expect(app).toContain("if List.isEmpty __e.changes then Html.none else Html.dl");
    // Null before/after render an em-dash: a create has no before, a destroy no after.
    expect(app).toContain('match __c.before with Some __v -> string __v | None -> "—"');
  });

  // Reachability — the fixture must PARSE + VALIDATE cleanly (generator tests
  // bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(DETAIL, { validate: true });
    expect(errors).toEqual([]);
  });
});

describe("feliz entity-history read — scaffolded Detail page (end-to-end)", () => {
  it("the scaffolded History section renders the trail instead of a skip notice", async () => {
    const files = await generateSystemFiles(scaffoldSystem(true));
    const app = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
    // The section frame + the real Timeline, bound to the history field.
    expect(app).toContain("orders-detail-history");
    expect(app).toContain("orders-detail-history-timeline");
    expect(app).toContain("(View.remoteList model.OrderHistory");
    expect(app).toContain("No history yet.");
    // The honest-degradation notice is gone — feliz now serves the read.
    expect(app).not.toContain("History is not yet supported on feliz");
    expect(app).not.toContain("(* entity history");
  });

  it("a NON-audited aggregate's feliz output carries no trace of the trail", async () => {
    const files = await generateSystemFiles(scaffoldSystem(false));
    const web = [...files.entries()].filter(([p]) => p.startsWith("web/"));
    const markers = ["OrderHistory", "AuditEntry", "loom-timeline", "orders-detail-history"];
    const hits = web.flatMap(([p, c]) =>
      markers.filter((m) => c.includes(m)).map((m) => `${p}: ${m}`),
    );
    expect(hits).toEqual([]);
  });
});
