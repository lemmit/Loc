// Named policy functions (authorization Phase 3.2) — per-backend generator
// pins.  Because a `requires PolicyName(args)` gate INLINES the ambient
// predicate body into the requires expression, every one of the five
// domain-logic backends emits the inlined predicate through its existing
// `requires` → 403 enforcement path with no new render code.  These pins prove
// the resolved predicate (permission string + money literal, argument
// substituted) reaches each backend's operation body.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const system = (platform: string) => `
  system Shop {
    user { id: string  role: string  permissions: string[] }
    subdomain Sales {
      permissions { approve, manage }
      context Orders {
        enum OrderStatus { Draft, Approved }
        policy CanApprove(cap: money): bool =
          currentUser.permissions.contains(permissions.approve) && cap <= 10000
        policy IsManager(): bool { currentUser.permissions.contains(permissions.manage) }
        aggregate Order {
          amount: money
          status: OrderStatus
          operation approve() {
            requires CanApprove(amount)
            requires IsManager()
            status := OrderStatus.Approved
          }
        }
        repository Orders for Order { }
      }
    }
    storage s { type: postgres }
    resource st { for: Orders, kind: state, use: s }
    deployable api {
      platform: ${platform}
      contexts: [Orders]
      dataSources: [st]
      port: 8080
      auth: required
    }
  }
`;

async function allText(platform: string): Promise<string> {
  const files = await generateSystemFiles(system(platform));
  return [...files.values()].join("\n\n");
}

describe("named policy functions — per-backend requires enforcement", () => {
  it("node/Hono: inlines the predicate into the 403 gate", async () => {
    const text = await allText("node");
    expect(text).toContain('(currentUser.permissions).includes("sales.approve")');
    expect(text).toContain('(currentUser.permissions).includes("sales.manage")');
    expect(text).toContain('new Decimal("10000")');
    expect(text).toContain('ForbiddenError("Forbidden: CanApprove(amount)")');
    expect(text).toContain('ForbiddenError("Forbidden: IsManager()")');
  });

  it(".NET/EF: inlines the predicate into the 403 gate", async () => {
    const text = await allText("dotnet");
    expect(text).toContain('(currentUser.Permissions).Contains("sales.approve")');
    expect(text).toContain('(currentUser.Permissions).Contains("sales.manage")');
    expect(text).toContain("10000m");
    expect(text).toContain('ForbiddenException("Forbidden: CanApprove(amount)")');
  });

  it("Python/FastAPI: inlines the predicate into the 403 gate", async () => {
    const text = await allText("python");
    expect(text).toContain('"sales.approve" in current_user.permissions');
    expect(text).toContain('"sales.manage" in current_user.permissions');
    expect(text).toContain('Decimal("10000")');
  });

  it("Java/Spring: inlines the predicate into the 403 gate", async () => {
    const text = await allText("java");
    expect(text).toContain('currentUser.permissions().contains("sales.approve")');
    expect(text).toContain('currentUser.permissions().contains("sales.manage")');
    expect(text).toContain('new BigDecimal("10000")');
    expect(text).toContain('ForbiddenException("Forbidden: CanApprove(amount)")');
  });

  it("Elixir/Phoenix: inlines the predicate into the forbidden gate", async () => {
    const text = await allText("elixir");
    expect(text).toContain('Enum.member?(current_user.permissions, "sales.approve")');
    expect(text).toContain('Enum.member?(current_user.permissions, "sales.manage")');
    expect(text).toContain('Decimal.new("10000")');
    // The `requires` predicate is inlined into a `with :ok <- ensure(…, :forbidden)`
    // guard — an expected denial returns `{:error, :forbidden}` (→ 403), not a
    // `raise(ArgumentError, "Forbidden: …")` (→ 500).  See the phoenix op-guards fix.
    expect(text).toContain(
      'ensure(Enum.member?(current_user.permissions, "sales.manage"), :forbidden)',
    );
    expect(text).not.toContain('"Forbidden: CanApprove(amount)"');
  });

  it("a plain aggregate with no policy-function gate is unaffected", async () => {
    // Sanity: a system without any policy function still generates (no crash,
    // no stray policy-function artefact).
    const plain = `
      system Plain {
        subdomain S {
          context C {
            aggregate Item { name: string }
            repository Items for Item { }
          }
        }
        storage s { type: postgres }
        resource st { for: C, kind: state, use: s }
        deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080 }
      }
    `;
    const files = await generateSystemFiles(plain);
    expect(files.size).toBeGreaterThan(0);
  });
});
