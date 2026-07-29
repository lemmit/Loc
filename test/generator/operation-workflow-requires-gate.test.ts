// Cross-backend emission of the `requires <expr>` authorization gate
// (authorization.md §11.3) on an aggregate `operation` and a workflow `create`
// starter. The header gate lowers to a front-of-body `requires` statement, so
// every backend emits its existing 403 pre-check (ForbiddenError /
// ForbiddenException / :forbidden) before the domain body runs — no new emitter.
//
// (Workflow `handle` gates lower identically but are inert at emit today: no
// backend surfaces `handle` command handlers as HTTP routes yet — a pre-existing
// gap covered structurally by test/ir/operation-workflow-gate-lower.test.ts.)

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

const src = (plat: string) => `
  system Sys {
    user { id: string role: string }
    subdomain S {
      context Tickets {
        aggregate Ticket {
          subject: string  open: bool
          create newT(subject: string) { subject := subject  open := true }
          operation close() requires currentUser.role == "agent" { open := false }
        }
        repository Tickets for Ticket { }
        workflow Triage {
          create open(subject: string) requires currentUser.role == "admin" {
            precondition subject.length > 0
            let t = Ticket.newT(subject)
          }
        }
      }
    }
    storage primary { type: postgres }
    resource st { for: Tickets, kind: state, use: primary }
    api Api from S
    deployable api { platform: ${plat}  contexts: [Tickets]  serves: Api  dataSources: [st]  port: 3000  auth: required }
  }`;

async function generate(plat: string): Promise<string> {
  const { model, errors } = await parseString(src(plat), { validate: true });
  expect(errors, `validation errors for ${plat}`).toEqual([]);
  // Concatenate every emitted file; the assertions are backend-specific
  // substrings, so pooling avoids per-backend path bookkeeping.
  return [...generateSystems(model).files.values()].join("\n\n");
}

describe("operation + workflow-create requires gate — cross-backend 403 emission", () => {
  it("node/Hono: ForbiddenError guard before the operation + workflow body", async () => {
    const out = await generate("node");
    expect(out).toContain(
      'if (!(currentUser.role === "agent")) throw new ForbiddenError("Forbidden: currentUser.role == \\"agent\\"");',
    );
    expect(out).toContain(
      'if (!(currentUser.role === "admin")) throw new ForbiddenError("Forbidden: currentUser.role == \\"admin\\"");',
    );
  });

  it(".NET: ForbiddenException guard (403 via DomainExceptionFilter)", async () => {
    const out = await generate("dotnet");
    expect(out).toContain(
      'if (!(currentUser.Role == "agent")) throw new ForbiddenException("Forbidden: currentUser.role == \\"agent\\"");',
    );
    expect(out).toContain(
      'if (!(currentUser.Role == "admin")) throw new ForbiddenException("Forbidden: currentUser.role == \\"admin\\"");',
    );
  });

  it("Java/Spring: ForbiddenException guard (403 via controller advice)", async () => {
    const out = await generate("java");
    expect(out).toContain(
      'if (!(Objects.equals(currentUser.role(), "agent"))) throw new ForbiddenException("Forbidden: currentUser.role == \\"agent\\"");',
    );
    expect(out).toContain(
      'if (!(Objects.equals(currentUser.role(), "admin"))) throw new ForbiddenException("Forbidden: currentUser.role == \\"admin\\"");',
    );
  });

  it("Python/FastAPI: ForbiddenError raise before the body", async () => {
    const out = await generate("python");
    expect(out).toContain('if not (current_user.role == "agent"):');
    expect(out).toContain('raise ForbiddenError("Forbidden: currentUser.role == \\"agent\\"")');
    expect(out).toContain('if not (current_user.role == "admin"):');
  });

  it("Elixir/Phoenix: `ensure(_, {:forbidden, msg})` guard (403 via ProblemDetails)", async () => {
    const out = await generate("elixir");
    expect(out).toContain('ensure(current_user.role == "agent", {:forbidden, ');
    // Workflow create renders the guard inline in the workflow module.
    expect(out).toContain('current_user.role == "admin"');
    expect(out).toContain(":forbidden");
  });
});
