import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Extern-component end-to-end gate (Tier 1).  Proves the escape hatch's
// whole point: the generated `<Name>.props.ts` is a REAL typed contract
// against the domain wire shape, so a hand-written component that reads
// the wrong field fails `tsc` — and a correct one compiles.
//
// Flow (mirrors generated-react-build.test.ts): generate a system with
// an `extern` component, npm-install the React project once, then run
// `tsc --noEmit` twice:
//   1. with a CORRECT hand-written widget (reads `order.customerId`) →
//      must type-check;
//   2. with a MISMATCHED widget (reads a field that isn't on the wire
//      DTO) → must fail, with the error naming the bad field.
//
// Opt-in like the sibling React-build suite — gated on LOOM_REACT_BUILD=1
// (network + a real npm install).  Skipped in the default `npm test`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_REACT_BUILD === "1";

const SOURCE = `
system Demo {
  subdomain M { context Sales {
    aggregate Order { customerId: string status: string }
  } }
  ui WebApp {
    component OrderCard(order: Order, caption: string) extern from "widgets/order-card"
    page Home { route: "/" body: Heading { "home" } }
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api { platform: hono, contexts: [Sales], dataSources: [salesState], port: 3000 }
  deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
}
`;

/** A correct hand-written widget: imports the generated props type and
 *  reads a field that exists on the wire DTO (`customerId`). */
const GOOD_WIDGET = `import type { OrderCardProps } from "../components/OrderCard.props";

export default function OrderCard({ order, caption }: OrderCardProps) {
  return (
    <div data-testid="order-card">
      {caption}: {order.customerId} ({order.status})
    </div>
  );
}
`;

/** Same widget reading a field that is NOT on \`OrderResponse\` — must
 *  be a type error, proving the props contract bites. */
const BAD_WIDGET = `import type { OrderCardProps } from "../components/OrderCard.props";

export default function OrderCard({ order, caption }: OrderCardProps) {
  // \`order.totalAmount\` does not exist on the Order wire shape.
  return <div>{caption}: {order.totalAmount}</div>;
}
`;

describe.skipIf(!ENABLED)("extern component end-to-end (LOOM_REACT_BUILD)", () => {
  it("a correct hand-written component type-checks; a field-mismatch one fails tsc", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-extern-tsc-"));
    try {
      const dddPath = path.join(outDir, "demo.ddd");
      fs.writeFileSync(dddPath, SOURCE);
      execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      const projectDir = path.join(outDir, "web");
      expect(fs.existsSync(projectDir), `expected React project at ${projectDir}`).toBe(true);

      // Loom emitted the shim + props but NOT the user's module — that's
      // the user-owned file.  We drop it in at the `from` path.
      const widgetPath = path.join(projectDir, "src", "widgets", "order-card.tsx");
      fs.mkdirSync(path.dirname(widgetPath), { recursive: true });
      fs.writeFileSync(widgetPath, GOOD_WIDGET);

      execSync(`npm install --silent --no-audit --no-fund`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 240_000,
      });

      // 1. Correct widget → tsc clean.
      execSync(`npx tsc --noEmit`, { cwd: projectDir, stdio: "inherit", timeout: 90_000 });

      // 2. Swap in the mismatched widget → tsc MUST fail, and the error
      //    must name the bad field (the contract bit).
      fs.writeFileSync(widgetPath, BAD_WIDGET);
      let stderr = "";
      let failed = false;
      try {
        execSync(`npx tsc --noEmit`, { cwd: projectDir, stdio: "pipe", timeout: 90_000 });
      } catch (e) {
        failed = true;
        const err = e as { stdout?: Buffer; stderr?: Buffer };
        stderr = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
      }
      expect(failed, "tsc should fail on the field-mismatch widget").toBe(true);
      expect(stderr).toMatch(/totalAmount/);
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 420_000);
});
