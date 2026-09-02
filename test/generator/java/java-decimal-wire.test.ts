// M-T6.46 — a RESPONSE `decimal` narrows to `double` at the Java wire boundary.
//
// RS-24 says a plain `decimal` is a JSON NUMBER (only `money` is a string), and
// the other four backends all carry that number through an IEEE-754 double —
// node `Number(...)`, python `float(...)`, elixir `Decimal.to_float`, and .NET's
// response-side `double` (#2563 / #2575).  Java's domain type is `BigDecimal`
// and a `derived` division renders through `MathContext.DECIMAL128`, so an
// un-narrowed response record serialized up to 34 significant digits against
// everyone else's ≤17 — invisible to the wire-golden differential, which
// JSON-parses both sides and so can never fail on EXCESS precision (audit F9 /
// F16, register #2644).
//
// The REQUEST side deliberately stays `BigDecimal`: #2575's reason, a `double`
// request component turns an out-of-range 400 into a conversion 500.
//
// Every site the narrowing has to reach is pinned here — the response record,
// its optional/masked (boxed) form, the `decimal[]` element mapper, the value
// object nested on a response, the JPQL projection aggregate + GROUP-BY key
// coercions, the SSE realtime frame, and the explicit-handler scalar return —
// because each one is an independent decimal→wire hop and the differential
// gate sees none of them.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Money {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }

      valueobject Rate { factor: decimal  label: string }

      event OrderRated { order: Order id, factor: decimal, at: datetime }

      aggregate Order with crudish {
        code: string
        lineCount: int
        total: money
        factor: decimal
        margin: decimal?
        samples: decimal[]
        rate: Rate
        status: OrderStatus
        derived unitFactor: decimal = factor / lineCount
        operation rate(newFactor: decimal) {
          factor := newFactor
          emit OrderRated { order: id, factor: newFactor, at: now() }
        }
      }
      repository Orders for Order { }

      channel Rates { carries: OrderRated  delivery: broadcast  retention: log  key: order }

      // Whole-table aggregation: sum/avg over a decimal column — the JPQL
      // arm (jpqlCoerce).  Only avg was ever double-parity before, and only by
      // the provider's accident of typing an average as a Double.
      projection FactorTotals {
        orders: int
        factorSum: decimal
        factorAvg: decimal
        from Order as o
        select orders = count(),
               factorSum = sum(o.factor),
               factorAvg = avg(o.factor)
      }

      // GROUP BY a decimal source column — the key arm (groupKeyCoerce).
      projection OrdersByFactor {
        factor: decimal
        orders: int
        from Order as o
        group by o.factor
        select factor = o.factor,
               orders = count()
      }

      queryHandler GetUnitFactor(orderId: Order id): decimal {
        let o = Orders.getById(orderId)
        return o.unitFactor
      }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/{orderId}/unit-factor" -> Orders.GetUnitFactor
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable api { platform: java, contexts: [Orders], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

// A second system for the two places a BigDecimal genuinely still crosses a
// wire after the response-side narrowing: the CloudEvents broker envelope
// (`ChannelCodec.toData` passes a plain decimal through raw) and the resource
// clients (an `Object` payload the caller supplies).
const BROKER_SRC = `
system Broker {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        code: string
        factor: decimal
        operation rate(newFactor: decimal) {
          factor := newFactor
          emit OrderRated { order: id, factor: newFactor, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderRated { order: Order id, factor: decimal, at: datetime }
      channel Rates { carries: OrderRated  delivery: broadcast  retention: log  key: order }
      workflow notify {
        create(code: string) {
          salesJobs.enqueue(code)
        }
      }
    }
  }
  storage pg { type: postgres }
  storage bus { type: kafka }
  storage jobs { type: rabbitmq }
  resource ordersState { for: Orders, kind: state, use: pg }
  resource salesJobs { for: Orders, kind: queue, use: jobs }
  channelSource ratesBus { for: Rates, use: bus }
  deployable api {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState, salesJobs]
    channels: [ratesBus]
    port: 5002
  }
}
`;

// A third system for the in-system api client: a java deployable calling a
// sibling deployable's api with a `decimal` param.  `javaParamType` types that
// param `BigDecimal`, and it goes straight into the outbound body.
const API_SRC = `
system Cross {
  subdomain Core {
    context Orders {
      aggregate Order with crudish { code: string  factor: decimal }
      repository Orders for Order { }
    }
    context Shipping {
      aggregate Shipment with crudish { orderCode: string }
      repository Shipments for Shipment { }
      workflow fulfil {
        create(orderId: Order id) {
          let o = orders.getOrderById(orderId)
          let s = Shipment.create({ orderCode: o.code })
        }
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: api,   use: OrdersApi }
  deployable ordersSvc   { platform: node contexts: [Orders]   dataSources: [ordersState] serves: OrdersApi port: 3000 }
  deployable shippingSvc { platform: java contexts: [Shipping] dataSources: [shippingState, orders] port: 3001 }
}
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

function file(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

describe("M-T6.46 — java response decimal narrows to double", () => {
  it("types a response record's decimal components as `double` and drops the BigDecimal import", async () => {
    const resp = file(await files(), "OrderResponse.java");
    // Bare decimal → the primitive.
    expect(resp).toMatch(/\bdouble factor\b/);
    // `derived` decimal is the worst case — MathContext.DECIMAL128 division.
    expect(resp).toMatch(/\bdouble unitFactor\b/);
    // Optional decimal must be BOXED so it can still be null.
    expect(resp).toMatch(/\bDouble margin\b/);
    // `decimal[]` → List<Double>, never List<BigDecimal>.
    expect(resp).toContain("List<Double> samples");
    // money is UNAFFECTED — RS-12 keeps it a fixed-scale string.
    expect(resp).toMatch(/\bString total\b/);
    // The record no longer names BigDecimal, so it must not import it.
    expect(resp).not.toContain("BigDecimal");
  });

  it("narrows at the domain→wire mapper, including the optional and array arms", async () => {
    const resp = file(await files(), "OrderResponse.java");
    expect(resp).toContain("value.factor().doubleValue()");
    expect(resp).toContain("value.unitFactor().doubleValue()");
    // Optional narrows behind a null guard (the component is `Double`).
    expect(resp).toContain("value.margin() == null ? null : (value.margin()).doubleValue()");
    // `decimal[]` narrows per element.
    expect(resp).toContain("value.samples().stream().map(__x -> __x.doubleValue()).toList()");
  });

  it("narrows a decimal on a value object nested in a response, not on its request twin", async () => {
    const m = await files();
    const voResp = file(m, "RateResponse.java");
    expect(voResp).toMatch(/\bdouble factor\b/);
    expect(voResp).toContain("value.factor().doubleValue()");
    expect(voResp).not.toContain("BigDecimal");

    const voReq = file(m, "RateRequest.java");
    expect(voReq).toContain("BigDecimal factor");
    expect(voReq).toContain("import java.math.BigDecimal;");
  });

  it("leaves the REQUEST direction on BigDecimal (an out-of-range value stays a 400, not a 500)", async () => {
    const m = await files();
    const create = file(m, "CreateOrderRequest.java");
    expect(create).toContain("import java.math.BigDecimal;");
    expect(create).toContain("BigDecimal factor");
    expect(create).not.toContain("double factor");
    // An operation param is a request slot too.
    const opReq = file(m, "RateOrderRequest.java");
    expect(opReq).toContain("BigDecimal newFactor");
    expect(opReq).toContain("import java.math.BigDecimal;");
  });

  it("coerces a JPQL decimal aggregate to a double instead of re-wrapping a BigDecimal", async () => {
    const m = await files();
    const row = file(m, "FactorTotalsRow.java");
    expect(row).toMatch(/\bdouble factorSum\b/);
    expect(row).toMatch(/\bdouble factorAvg\b/);
    expect(row).not.toContain("BigDecimal");

    const reads = file(m, "OrdersQueryProjections.java");
    // Still through `Number` (the provider picks BigDecimal for a sum, Double
    // for an avg) — but landing on a double, and zero-filling with 0.0.
    expect(reads).toContain(").doubleValue()");
    expect(reads).not.toContain("BigDecimal.ZERO");
    expect(reads).not.toMatch(/new BigDecimal\(r\[\d+\]\.toString\(\)\)/);
  });

  it("coerces a decimal GROUP-BY key to a double", async () => {
    const m = await files();
    const row = file(m, "OrdersByFactorRow.java");
    expect(row).toMatch(/\bdouble factor\b/);
    const reads = file(m, "OrdersQueryProjections.java");
    expect(reads).toContain("((Number) r[0]).doubleValue()");
  });

  it("narrows a decimal on the SSE realtime frame", async () => {
    const rt = file(await files(), "RealtimeController.java");
    expect(rt).toContain('m.put("factor", e.factor().doubleValue());');
  });

  it("narrows a decimal returned by an explicit handler route", async () => {
    const ctrl = file(await files(), "SalesApiRoutesController.java");
    expect(ctrl).toContain("ResponseEntity.ok(result.doubleValue())");
  });

  it("pins WRITE_BIGDECIMAL_AS_PLAIN on the CloudEvents envelope, where a BigDecimal still crosses a wire", async () => {
    // `ChannelCodec.toData` converts datetime/money/id/enum and passes a plain
    // `decimal` event field through RAW, so the broker envelope is one of the
    // few places a BigDecimal still reaches a serializer after the
    // response-side narrowing. Plain notation, never `1E+40`. (The broker's
    // numeric PRECISION contract is a separate cross-backend gap — .NET's
    // channel codec has the identical raw-decimal shape — and is deliberately
    // not redefined here.)
    const m = await generateSystemFiles(BROKER_SRC);
    const env = [...m.entries()].find(([k]) => k.endsWith("LoomEventEnvelope.java"))?.[1] ?? "";
    expect(env, "LoomEventEnvelope.java not emitted").not.toBe("");
    expect(env).toContain(
      ".enable(tools.jackson.core.StreamWriteFeature.WRITE_BIGDECIMAL_AS_PLAIN)",
    );
    // The raw pass-through this flag exists to make safe.
    const codec = [...m.entries()].find(([k]) => k.endsWith("ChannelCodec.java"))?.[1] ?? "";
    expect(codec).toContain('m.put("factor", e.factor());');
  });

  it("pins WRITE_BIGDECIMAL_AS_PLAIN on the resource clients, whose payload is a caller-supplied Object", async () => {
    // An `Object message` / `Object body` can carry a BigDecimal onto an
    // EXTERNAL wire (broker / third-party REST).
    const m = await generateSystemFiles(BROKER_SRC);
    const mq = [...m.entries()].find(([k]) => k.endsWith("RabbitmqResources.java"))?.[1] ?? "";
    expect(mq, "RabbitmqResources.java not emitted").not.toBe("");
    expect(mq).toContain(
      ".enable(tools.jackson.core.StreamWriteFeature.WRITE_BIGDECIMAL_AS_PLAIN)",
    );
  });

  it("pins WRITE_BIGDECIMAL_AS_PLAIN on the in-system api client, whose params stay BigDecimal", async () => {
    // `javaParamType` types a `decimal`/`money` call param `BigDecimal`, and it
    // goes straight into the outbound body — the callee is another Loom backend
    // whose ingress parses a JSON literal, so `1E+40` is not acceptable there.
    const m = await generateSystemFiles(API_SRC);
    const client = [...m.entries()].find(([k]) => k.endsWith("ApiClients.java"))?.[1] ?? "";
    expect(client, "ApiClients.java not emitted").not.toBe("");
    expect(client).toContain(
      ".enable(tools.jackson.core.StreamWriteFeature.WRITE_BIGDECIMAL_AS_PLAIN)",
    );
  });
});
