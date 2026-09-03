// An `extern` operation whose scaffold-once body was never filled in answers
// 501, carrying the message that names the file to write.
//
// The seam is a scaffold-once concrete subclass (`domain/<agg>.ts`,
// `src/generator/typescript/extern-builder.ts`) whose default `*Extern` bodies
// throw.  They used to throw a BARE `Error`, which no arm of the router's
// `onError` ladder recognises, so it fell into the generic 500 fallback and the
// wire got `"internal"` — the same answer a genuine crash gives, with the
// "write its body in src/domain/<agg>.ts" hint discarded on the way out.  An
// operator debugging a 500 has no way to tell "you forgot to implement this"
// from "the server broke".
//
// RFC 9110 §15.6.2: the route exists and the request was well-formed; the
// implementation is ABSENT.  That is 501, not 500.  The message is safe to serve
// because Loom GENERATES it — unlike the sibling `ExternHandlerError` arm, which
// wraps arbitrary user code and stays sanitized (RS-28).
//
// Both halves are asserted, because either alone is satisfiable while the bug
// stands: the throw could carry the right class with no arm to catch it, or the
// arm could exist with the stub still throwing a bare `Error`.
//
// Mutation-proved twice, each half independently:
//   * `throw new NotImplementedError(...)` -> `throw new Error(...)` in
//     `extern-builder.ts` fails "the stub throws NotImplementedError";
//   * deleting the `if (err instanceof NotImplementedError)` block in
//     `routes-builder.ts` fails "the router answers 501".

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const WITH_EXTERN = `
system ExternStatus {
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        riskScore: int
        operation flag(score: int) extern { precondition score >= 0 }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4201
  }
}`;

/** The same system with the `extern` keyword dropped — the strict-additivity
 *  control.  A project with no extern operation must be byte-identical to
 *  before, so none of the three emissions may appear. */
const WITHOUT_EXTERN = WITH_EXTERN.replace(
  "operation flag(score: int) extern { precondition score >= 0 }",
  "operation flag(score: int) { precondition score >= 0  riskScore := score }",
).replace("port: 4201", "port: 4202");

const fileEndingWith = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("an unimplemented `extern` operation answers 501, not 500 `internal`", () => {
  it("the domain error module declares NotImplementedError", async () => {
    const files = await generateSystemFiles(WITH_EXTERN);
    const errors = fileEndingWith(files, "domain/errors.ts");
    expect(errors).toContain("export class NotImplementedError extends Error {");
    expect(errors).toContain('this.name = "NotImplementedError";');
  });

  it("the scaffold-once stub throws NotImplementedError, naming the file to fill in", async () => {
    const files = await generateSystemFiles(WITH_EXTERN);
    const stub = fileEndingWith(files, "domain/order.ts");
    expect(stub).toContain('import { NotImplementedError } from "./errors";');
    expect(stub).toContain(
      "throw new NotImplementedError(\"extern operation 'flag' on Order is not implemented" +
        ' — write its body in src/domain/order.ts");',
    );
    // The class it must NOT be: a bare Error is what the generic 500 arm swallows.
    expect(stub).not.toContain("throw new Error(");
  });

  it("the router answers 501 with the stub's message", async () => {
    const files = await generateSystemFiles(WITH_EXTERN);
    const routes = fileEndingWith(files, "order.routes.ts");
    expect(routes).toContain("NotImplementedError");
    expect(routes).toContain("if (err instanceof NotImplementedError) {");
    expect(routes).toContain('return problem(501, "Not Implemented", err.message);');
    // …and 501 must be in the `problem()` helper's status union, or the emitted
    // project does not type-check.
    expect(routes).toMatch(/const problem = \(status: [^)]*\b501\b/);
    // Placed BEFORE the ExternHandlerError arm: both describe the extern seam,
    // and the later arm sanitizes its message to "internal".
    expect(routes.indexOf("if (err instanceof NotImplementedError)")).toBeLessThan(
      routes.indexOf("if (err instanceof ExternHandlerError)"),
    );
  });

  it("a project with no extern operation emits none of it", async () => {
    const files = await generateSystemFiles(WITHOUT_EXTERN);
    expect(fileEndingWith(files, "domain/errors.ts")).not.toContain("NotImplementedError");
    expect(fileEndingWith(files, "order.routes.ts")).not.toContain("NotImplementedError");
    expect(fileEndingWith(files, "order.routes.ts")).not.toContain("501");
  });
});
