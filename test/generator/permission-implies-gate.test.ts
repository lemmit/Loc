// `implies` gate expansion at emit (authorization.md §6, M-T3.2 item 7).
// A `contains(permissions.read)` gate on a catalogue where `read` is implied by
// `edit`/`approve` must emit an OR over read + its reverse closure, so holding
// a broader permission satisfies the narrower gate.  The check stays a flat
// membership test per term (no runtime graph walk).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const system = (gatePerm: string) => `
system P {
  user { id: string  permissions: string[] }
  subdomain M {
    permissions { read, edit implies read, approve implies edit }
    context C {
      aggregate Order with crudish {
        status: string
        operation act() requires currentUser.permissions.contains(permissions.${gatePerm}) { status := "x" }
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;

async function allText(gatePerm: string): Promise<string> {
  const files = await generateSystemFiles(system(gatePerm));
  return [...files.values()].join("\n\n");
}

describe("implies gate expansion — Hono", () => {
  it("expands a `read` gate to accept read || edit || approve", async () => {
    const text = await allText("read");
    expect(text).toContain('includes("m.read")');
    expect(text).toContain('includes("m.edit")');
    expect(text).toContain('includes("m.approve")');
  });

  it("does not over-expand a top permission (approve is implied by nothing)", async () => {
    const text = await allText("approve");
    expect(text).toContain('includes("m.approve")');
    // The `approve` gate must NOT accept the narrower `read`/`edit`.
    expect(text).not.toContain('includes("m.read")');
    expect(text).not.toContain('includes("m.edit")');
  });
});
