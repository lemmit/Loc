// Dedicated unit coverage for the Python and Java domain-`test` emitters
// (`renderPyTestsFile` / `renderJavaTestsFile`) — the F4 backfill of
// docs/audits/test-parity-generated-backends.md.  The TS + .NET emitters have
// `create-in-test-emission.test.ts`; before this, Python and Java were only
// exercised incidentally if a build-gated corpus example happened to carry
// `test` blocks.  These pin their distinctive lowering directly.
//
// Both consume the same fixtures so the cross-backend divergences are visible:
//   - create({…}) → Python keyword args (provided fields only; the factory
//     defaults omitted optionals) vs Java POSITIONAL args (every canonical
//     create-input, omitted optional → `null`, defaulted field → its literal).
//   - typed coercion → `X id` brands (`CustomerId("…")`), value-object literals
//     construct in declared field order (`Money(9.99, "USD")` / `new Money(…)`),
//     datetime strings parse (Python `datetime.fromisoformat`; Java keeps the
//     ISO string for its own parser).
//   - matchers → Python `assert ==`; Java `assertEquals` / BigDecimal
//     `compareTo` for money-like comparisons.
//   - toThrow → Python `with pytest.raises(Exception):`; Java
//     `assertThrows(DomainException.class, () -> …)`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// A partial create (omits the optional `description`) + a money field read + a
// precondition-op rejection.
const CORE = `
system Demo {
  subdomain Projects {
    context Catalog {
      aggregate Project with crudish {
        name: string
        description: string?
        budget: decimal
        invariant name.length > 0
        operation rename(newName: string) {
          precondition newName.length > 0
          name := newName
        }
        test "partial create then rename rejects empty" {
          let p = Project.create({ name: "demo", budget: 0.0 })
          expect(p.budget).toBe(0.0)
          expect(p.rename("")).toThrow()
        }
      }
      repository ProjectRepo for Project { }
    }
  }
  api ProjectsApi from Projects
  deployable pyApi   { platform: python contexts: [Catalog] serves: ProjectsApi port: 8000 }
  deployable javaApi { platform: java   contexts: [Catalog] serves: ProjectsApi port: 8080 }
}
`;

// Typed create inputs (`X id`, value-object literal, datetime) + a
// currentUser-gated op invoked from the test body.
const TYPED = `
system Demo2 {
  user { id: guid role: string }
  subdomain Sales {
    context Orders {
      valueobject Money { amount: money currency: string }
      aggregate Customer with crudish { name: string }
      repository Customers for Customer { }
      aggregate Order with crudish {
        customerId: Customer id
        total: Money
        placedAt: datetime
        status: string = "open"
        operation cancel() {
          requires currentUser.role == "admin"
          precondition status == "open"
          status := "cancelled"
        }
        test "create coerces typed inputs" {
          let o = Order.create({ customerId: "c1", total: Money { amount: 9.99, currency: "USD" }, placedAt: "2024-01-01T00:00:00Z" })
          o.cancel()
          expect(o.status).toBe("cancelled")
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  deployable pyApi   { platform: python contexts: [Orders] serves: SalesApi port: 8000 }
  deployable javaApi { platform: java   contexts: [Orders] serves: SalesApi port: 8080 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}; have:\n${[...files.keys()].join("\n")}`);
}

function line(src: string, marker: RegExp): string {
  const l = src.split("\n").find((s) => marker.test(s));
  if (!l) throw new Error(`no line matching ${marker} in:\n${src}`);
  return l.trim();
}

describe("Python domain-test emitter (renderPyTestsFile)", () => {
  it("emits a pytest function with keyword-arg create + raises for toThrow", async () => {
    const files = await generateSystemFiles(CORE);
    const src = findFile(files, /py_api\/tests\/test_project\.py$/);

    expect(src).toContain("import pytest");
    expect(src).toContain("def test_partial_create_then_rename_rejects_empty() -> None:");
    // create renders keyword args (provided fields only) — not a dict literal.
    const create = line(src, /Project\.create\(/);
    expect(create).not.toMatch(/Project\.create\(\{/);
    expect(create).toMatch(/name="demo"/);
    expect(create).toMatch(/budget=0\.0/);
    expect(create).not.toMatch(/description=/); // omitted optional → factory default
    // value matcher → `assert ==`.
    expect(src).toContain("assert p.budget == 0.0");
    // toThrow → pytest.raises context manager wrapping the call.
    expect(src).toContain("    with pytest.raises(Exception):");
    expect(src).toContain('        p.rename("")');
  });

  it("coerces typed create inputs and threads a synthetic actor into a gated op", async () => {
    const files = await generateSystemFiles(TYPED);
    const src = findFile(files, /py_api\/tests\/test_order\.py$/);

    const create = line(src, /Order\.create\(/);
    expect(create).toContain('customer_id=CustomerId("c1")'); // `X id` brand
    expect(create).toContain('total=Money(9.99, "USD")'); // VO positional ctor, declared order
    expect(create).toContain('placed_at=datetime.fromisoformat("2024-01-01T00:00:00Z")'); // datetime
    // A currentUser-gated op gets the synthetic full-access actor as the
    // trailing arg (resolved via the let-binding type table — the receiver is
    // untyped in test position).
    expect(src).toContain("from app.auth.user import User");
    expect(src).toContain('SimpleNamespace(id="00000000-0000-0000-0000-000000000000"');
    expect(src).toContain("o.cancel(cast(User, SimpleNamespace(");
  });
});

describe("Java domain-test emitter (renderJavaTestsFile)", () => {
  it("emits a JUnit @Test with positional create (omitted optional → null) + assertThrows", async () => {
    const files = await generateSystemFiles(CORE);
    const src = findFile(files, /ProjectTests\.java$/);

    expect(src).toContain("public class ProjectTests {");
    expect(src).toContain("@Test");
    expect(src).toContain('@DisplayName("partial create then rename rejects empty")');
    // Positional factory call: every canonical create-input, omitted optional
    // filled with `null` — NOT a single anonymous object.
    const create = line(src, /Project\.create\(/);
    expect(create).not.toMatch(/Project\.create\(new\s/);
    expect(create).toContain('Project.create("demo", null, new BigDecimal("0.0"))');
    // money-like value matcher routes through BigDecimal.compareTo.
    expect(src).toContain('assertEquals(0, (p.budget()).compareTo(new BigDecimal("0.0")))');
    // toThrow → assertThrows(DomainException.class, …).
    expect(src).toContain('assertThrows(DomainException.class, () -> p.rename(""))');
  });

  it("fills a defaulted create-input with its literal and coerces typed inputs", async () => {
    const files = await generateSystemFiles(TYPED);
    const src = findFile(files, /OrderTests\.java$/);

    // Positional create: id string, `new Money(...)` VO ctor, ISO datetime
    // string, and the defaulted `status` filled with its literal ("open").
    const create = line(src, /Order\.create\(/);
    expect(create).toContain('Order.create("c1", new Money(new BigDecimal("9.99"), "USD")');
    expect(create).toContain('"2024-01-01T00:00:00Z"');
    expect(create).toContain('"open")'); // defaulted field filled
  });
});
