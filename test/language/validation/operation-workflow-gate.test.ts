// AST validation of the `requires <expr>` authorization gate (authorization.md
// §11.3) on operations + workflow create/handle. The gate types to bool exactly
// like the in-body `requires` statement it lowers to; a non-bool gate is
// rejected, and a gate on a `private` operation (no HTTP entry point) warns.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const wrap = (body: string) => `
  system Sys {
    user { id: string  role: string }
    subdomain S {
      context Tickets {
        aggregate Ticket {
          subject: string  open: bool
          ${body}
        }
        repository Tickets for Ticket { }
      }
    }
  }
`;

const wrapWf = (createGate: string, handleGate: string) => `
  system Sys {
    user { id: string  role: string }
    subdomain S {
      context Tickets {
        aggregate Ticket { subject: string  open: bool }
        repository Tickets for Ticket { }
        workflow Triage {
          create open(subject: string) ${createGate} {
            precondition subject.length > 0
          }
          handle escalate(id: Ticket id) ${handleGate} {
            let t = Tickets.byId(id)
          }
        }
      }
    }
  }
`;

describe("operation / workflow requires gate — AST validation", () => {
  it("rejects a non-boolean operation gate", async () => {
    const { errors } = await parseString(
      wrap("operation close() requires subject { open := false }"),
    );
    expect(errors.some((e) => /'requires' must be of type 'bool'/.test(e))).toBe(true);
  });

  it("accepts a boolean operation gate referencing currentUser + params + this", async () => {
    const { errors } = await parseString(
      wrap(
        'operation reassign(to: string) requires currentUser.role == "admin" && to != subject { open := false }',
      ),
    );
    expect(errors).toEqual([]);
  });

  it("warns that a gate on a private operation has no effect", async () => {
    const { errors, warnings } = await parseString(
      wrap('private operation close() requires currentUser.role == "agent" { open := false }'),
    );
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /'requires' has no effect on private operation/.test(w))).toBe(
      true,
    );
  });

  it("rejects a non-boolean workflow create gate", async () => {
    const { errors } = await parseString(
      wrapWf("requires subject", 'requires currentUser.role == "agent"'),
    );
    expect(errors.some((e) => /'requires' must be of type 'bool'/.test(e))).toBe(true);
  });

  it("rejects a non-boolean workflow handle gate", async () => {
    const { errors } = await parseString(
      wrapWf('requires currentUser.role == "admin"', "requires id"),
    );
    expect(errors.some((e) => /'requires' must be of type 'bool'/.test(e))).toBe(true);
  });

  it("accepts boolean workflow create + handle gates", async () => {
    const { errors } = await parseString(
      wrapWf('requires currentUser.role == "admin"', 'requires currentUser.role == "agent"'),
    );
    expect(errors).toEqual([]);
  });
});
