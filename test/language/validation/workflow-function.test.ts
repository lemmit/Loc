// Workflow `function` members — the aggregate-parity pure helper.  Both the
// expression form (`function f(...): T = expr`) and the pure block form
// (`{ let … precondition … return … }`) are accepted, exactly as on an
// aggregate; a workflow body is not a class, so each backend emits the helper as
// a per-workflow-scoped module/static helper.  Purity + the no-`this` rule are
// enforced at the IR layer (see test/ir/workflow-function.test.ts).

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const ctx = (members: string): string => `
  system S { subdomain M { context C {
    aggregate Order { total: int  priority: int }
    repository Orders for Order { }
    ${members}
  }}}`;

describe("workflow function(...) members — validation", () => {
  it("accepts an expression-bodied workflow function", async () => {
    const { errors } = await parseString(
      ctx(`workflow W {
        function slaDays(priority: int): int = priority > 5 ? 1 : 5
        create(priority: int) { let sla = slaDays(priority) }
      }`),
    );
    expect(errors).toEqual([]);
  });

  it("accepts a pure block-bodied workflow function (parity with aggregate fns)", async () => {
    const { errors } = await parseString(
      ctx(`workflow W {
        function slaDays(priority: int): int {
          let expedited = priority > 5
          precondition priority >= 0
          return expedited ? 1 : 5
        }
        create(priority: int) { let sla = slaDays(priority) }
      }`),
    );
    expect(errors).toEqual([]);
  });
});
