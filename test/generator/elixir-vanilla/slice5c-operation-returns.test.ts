import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// T2.c — operation `or`-union returns on the elixir vanilla foundation
// (exception-less.md A3).  `operation reserve(): Order or NotFound` produces a
// tagged result the controller translates to HTTP: success → 200, error variant
// → RFC-7807 ProblemDetails at the variant's mapped status.  Any returning op
// is accepted on vanilla (the only foundation).
// ---------------------------------------------------------------------------

const source = () => `
system L {
  subdomain Core {
    context Orders {
      error NotFound { resource: string }
      aggregate Order {
        code: string
        operation reserve(): Order or NotFound { return NotFound { resource: code } }
      }
      repository Orders for Order { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [st]
    serves: A
    port: 4000
  }
}
`;

const RET_GATE = "loom.operation-return-unsupported";

async function diagnostics() {
  const { model } = await parseString(source(), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

describe("vanilla — T2.c operation-return gate", () => {
  it("accepts an `or`-union operation return on foundation: vanilla", async () => {
    const diags = await diagnostics();
    expect(diags.find((d) => d.code === RET_GATE)).toBeUndefined();
  });
});

describe("vanilla — T2.c operation-return emit", () => {
  const files = () => generateSystemFiles(source());
  const get = (m: Map<string, string>, suffix: string) =>
    m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

  it("context fn returns a tagged result; error variant carries its fields", async () => {
    const ctx = get(await files(), "lib/api/orders.ex");
    expect(ctx).toContain(
      "def reserve_order(%Api.Orders.Order{} = record, params) when is_map(params) do",
    );
    expect(ctx).toContain('{:error, "NotFound", %{resource: record.code}}');
    // typed result spec
    expect(ctx).toContain("{:ok, term()} | {:error, binary(), map()}");
  });

  it("controller translates the tagged result to HTTP (200 / ProblemDetails)", async () => {
    const ctl = get(await files(), "/controllers/order_controller.ex");
    expect(ctl).toContain('def reserve(conn, %{"id" => id} = params) do');
    expect(ctl).toContain("reserve_order_result(conn, Orders.reserve_order(record, attrs))");
    expect(ctl).toContain("def reserve_order_result(conn, {:ok, success})");
    // NotFound → 404 ProblemDetails via the shared responder
    expect(ctl).toContain('problem_variant(conn, 404, "/errors/not-found", "Not Found", data)');
    expect(ctl).toContain("defp problem_variant(conn, status, type, title, data) do");
    expect(ctl).toContain('put_resp_content_type("application/problem+json")');
  });

  it("mounts the POST member route for the returning op", async () => {
    const router = get(await files(), "/router.ex");
    expect(router).toContain('post "/orders/:id/reserve", OrderController, :reserve');
  });

  it("does not emit the unused problem_variant helper without a returning op", async () => {
    // A context with only a plain (void) operation must not carry the helper.
    const plain = `
system P {
  subdomain Core {
    context Tasks {
      aggregate Task with crudish {
        title: string
        operation rename(title: string) { }
      }
      repository Tasks for Task { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Tasks, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Tasks] dataSources: [st] serves: A port: 4000 }
}
`;
    const f = await generateSystemFiles(plain);
    const ctl = f.get([...f.keys()].find((k) => k.endsWith("/controllers/task_controller.ex"))!)!;
    expect(ctl).not.toContain("defp problem_variant");
  });

  it("does not emit the unused problem_variant helper for an error-free returning op", async () => {
    // A returning op with a scalar (non-union) return takes the `{:ok, …}` path
    // exclusively — it never calls `problem_variant/5`, so emitting the helper
    // would be an unused `defp` that trips `mix compile --warnings-as-errors`.
    const scalar = `
system P {
  subdomain Core {
    context Tasks {
      aggregate Task with crudish {
        title: string
        operation describe(): string { return title }
      }
      repository Tasks for Task { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Tasks, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Tasks] dataSources: [st] serves: A port: 4000 }
}
`;
    const f = await generateSystemFiles(scalar);
    const ctl = f.get([...f.keys()].find((k) => k.endsWith("/controllers/task_controller.ex"))!)!;
    // the returning op IS emitted (its result dispatch + {:ok, …} clause)...
    expect(ctl).toContain("describe_task_result(conn, {:ok, success})");
    // ...but the error-variant responder is NOT (no error variant calls it).
    expect(ctl).not.toContain("defp problem_variant");
  });
});
