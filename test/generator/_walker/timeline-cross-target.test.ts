// ---------------------------------------------------------------------------
// `Timeline(of: <entries>)` — the entity audit trail, cross-frontend render gate.
//
// Consumes the `AuditEntry[]` a backend serves at `GET /<agg>/{id}/history`
// (docs/audit.md).  Native `<ol>`/`<li>`/`<time>`/`<dl>` on every frontend —
// no design-pack component, no client state — so this asserts the markup
// through the real generators rather than an emitter unit.
//
// The HEEx arm is the one that matters most: Phoenix serves the history
// endpoint too, so a TSX-only Timeline would be exactly the silent LiveView
// degradation `heex-parity.test.ts` exists to catch.  It is implemented, not
// waived.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A hand-written page rendering the trail.  The entries are bound as page
 *  state rather than fetched, so this gate exercises the PRIMITIVE without also
 *  depending on the API-client `history()` method (which is a separate piece —
 *  the frontend clients iterate `finds`, and `historyFind` sits beside it). */
const timelineSystem = (frontend: string): string => `
  system TimelineDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order audited with crudish {
          reference: string
          quantity: int
          derived display: string = reference
        }
        repository Orders for Order { }
      }
    }
    ui Web {
      area Ordering {
        page History {
          route: "/history"
          state { entries: string[] }
          body: Stack {
            Timeline { of: entries, testid: "order-history" }
          }
        }
      }
    }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: node, contexts: [Ordering], dataSources: [orderingState], port: 3000
    }
    deployable web { platform: ${frontend}, targets: api, ui: Web, port: 3001 }
  }
`;

const allFiles = (files: Map<string, string>): string => {
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
};

describe("Timeline — ordered-list markup on every JSX frontend", () => {
  it.each([
    ["react", "loom-timeline"],
    ["vue", "loom-timeline"],
    ["svelte", "loom-timeline"],
    ["angular", "loom-timeline"],
  ])("%s renders an <ol> of entries", async (frontend, cls) => {
    const out = allFiles(await generateSystemFiles(timelineSystem(frontend)));
    expect(out).toContain(cls);
    // A timeline IS an ordered list — the semantics come from the element, not
    // from ARIA bolted onto a <div>.
    expect(out).toMatch(/<ol[^>]*loom-timeline/);
    expect(out).toContain("loom-timeline-entry");
    // Each entry surfaces what changed, when, and (when recorded) by whom.
    expect(out).toContain("loom-timeline-changes");
    expect(out).toContain("loom-timeline-actor");
    expect(out).toContain("order-history");
  });

  it("guards the in-flight list on react — the query has not resolved on first render", async () => {
    const out = allFiles(await generateSystemFiles(timelineSystem("react")));
    // An unguarded `.map` throws before the response lands.
    expect(out).toMatch(/\?\? \[\]\)\.map\(\(__e\)/);
  });

  it("keys entries by auditId and changes by field", async () => {
    const out = allFiles(await generateSystemFiles(timelineSystem("react")));
    expect(out).toContain("key={__e.auditId}");
    expect(out).toContain("key={__c.field}");
  });

  it("renders an entry header even when its changes list is empty", async () => {
    const out = allFiles(await generateSystemFiles(timelineSystem("react")));
    // A command that touched only diff-excluded fields still happened, and
    // "someone ran it at 14:02" is information.  So the `changes` <dl> is
    // conditional, the <li> is not.
    expect(out).toContain("__e.changes.length > 0");
    expect(out).toMatch(/<li[^>]*loom-timeline-entry/);
  });
});

describe("Timeline — HEEx is implemented, not waived", () => {
  it("renders the same ordered list on Phoenix", async () => {
    const out = allFiles(await generateSystemFiles(timelineSystem("elixir")));
    expect(out).toContain("loom-timeline");
    expect(out).toContain("loom-timeline-entry");
    // Entries cross the wire as string-keyed maps.
    expect(out).toContain('e["action"]');
    expect(out).toContain('c["field"]');
    // Comprehension over a nil-safe list, matching the JSX `?? []` guard.
    expect(out).toMatch(/for e <- .*\|\| \[\]/);
  });
});
