import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../_helpers/examples.js";
import { generateSystemFiles } from "../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Cross-frontend FEATURE-COMPLETENESS matrix — the frozen who-renders-what gate.
//
// `showcase-completeness.test.ts` proves `examples/showcase.ddd` exercises every
// language feature and every walker primitive — but only against the REACT
// registry. Each other frontend runs its own smaller, hand-picked example, so a
// feature React renders can silently fail to render on Vue / Svelte / Angular /
// Feliz, with nothing to catch it (their build gates never see `showcase.ddd`).
//
// This drives the WHOLE showcase UI surface — the hand-written `Console` (explicit
// api params + forms + operations + a slot/action user component), the scaffolded
// `Admin`, and the sugar-bound `Ops` — through EVERY frontend generator, in the
// fast suite (no docker / no framework compiler). Each `frontend × ui` cell must
// either render cleanly or be a FROZEN, reasoned gap in `GAPS` below.
//
// Two failure modes count as "does not render":
//   1. a THROW — the generator fails-fast on a construct it cannot emit
//      (e.g. Feliz's expr/action fail-fast, Vue's prop-kind guard);
//   2. a SILENT-FALLBACK marker — the shared walker emits a "not supported"
//      comment for an unrenderable primitive/seam.
//
// The freeze is BIDIRECTIONAL, exactly like `heex-parity.test.ts`:
//   - a cell that starts failing WITHOUT a `GAPS` entry fails CI (a new silent
//     gap — write the renderer or add a reasoned entry);
//   - a `GAPS` cell that now renders ALSO fails CI (the gap closed — delete the
//     entry, a welcome direction).
//
// Generation-level only; compiling each frontend's output stays the per-frontend
// build gate's job (`generated-{react,vue,svelte,angular,feliz}-build.yml`).
// ---------------------------------------------------------------------------

/** Frozen, reasoned gaps — `"<frontend>:<ui>"` → WHY it does not render today.
 *  Adding a NEW gap here is a reviewed decision; closing one means deleting the
 *  entry. Keep EMPTY-by-default discipline: an entry is debt, not a resting state. */
const GAPS: Record<string, string> = {
  // `Console` declares `component Panel(head: slot, onPick: action(Project))`.
  // The Vue component-props builder (src/generator/vue/walker/page-shell.ts)
  // throws on the `slot` (and `action`) prop kinds — user-component slot props
  // are unimplemented on Vue, though React/Svelte/Angular/Feliz all render them.
  // Parity follow-up (language-feature-developer); not a Vue-can't-express case.
  "vue:Console": "unsupported prop type kind 'slot' (user-component slot prop)",
};

const FRONTENDS = ["react", "vue", "svelte", "angular", "feliz"] as const;

/** The three showcase UIs, each with the api its shipped static deployable
 *  targets and the binding form Console needs (explicit api params). */
const UIS: Record<string, { bind: string; api: string }> = {
  Console: {
    bind: "ui: Console { Projects: dotnetApi, Delivery: dotnetApi, Accounts: dotnetApi }",
    api: "dotnetApi",
  },
  Ops: { bind: "ui: Ops", api: "honoApi" },
  Admin: { bind: "ui: Admin", api: "honoApi" },
};

/** Silent-degradation markers the shared/per-frontend walkers emit when they
 *  cannot render a construct (the fail-fast path THROWS instead). */
const FALLBACK_MARKERS = ["not supported", "unsupported expr", "unknown layout component"];

// Anchor the injected deployable on the last static frontend deployable
// (`adminWeb`) so it lands INSIDE the system, past the top-level
// requirement/solution/migration blocks that bracket it.
const ADMIN_WEB_ANCHOR = `        ui: Admin
        port: 3003
        design: shadcn
    }`;

const base = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");

function sourceFor(frontend: string, ui: string): string {
  const { bind, api } = UIS[ui]!;
  const dep = `    deployable feCell { platform: ${frontend} targets: ${api} ${bind} port: 3900 }`;
  const injected = base.replace(ADMIN_WEB_ANCHOR, `${ADMIN_WEB_ANCHOR}\n\n${dep}\n`);
  // Guard the anchor still matches — a showcase edit that moves it must fail
  // loudly here, not silently drop the whole matrix's coverage.
  if (injected === base) throw new Error("adminWeb anchor no longer matches showcase.ddd");
  return injected;
}

/** Render one cell; return the failure reason, or null when it renders clean. */
async function renderCell(frontend: string, ui: string): Promise<string | null> {
  let files: Map<string, string>;
  try {
    files = await generateSystemFiles(sourceFor(frontend, ui));
  } catch (e) {
    return `THROW: ${(e as Error).message}`;
  }
  const emitted = [...files].filter(([p]) => p.startsWith("fe_cell/"));
  for (const [p, content] of emitted) {
    for (const marker of FALLBACK_MARKERS) {
      if (content.includes(marker)) return `MARKER "${marker}" in ${p}`;
    }
  }
  if (emitted.length === 0) return "no files emitted for the frontend deployable";
  return null;
}

describe("frontend showcase render matrix", () => {
  for (const frontend of FRONTENDS) {
    for (const ui of Object.keys(UIS)) {
      const key = `${frontend}:${ui}`;
      const gap = GAPS[key];
      it(`${key} ${gap ? "is a frozen gap" : "renders cleanly"}`, async () => {
        const failure = await renderCell(frontend, ui);
        if (gap) {
          // A frozen gap must STILL fail — if it renders now, delete the entry.
          expect(failure, `${key} now renders — remove it from GAPS (was: ${gap})`).not.toBeNull();
        } else {
          // Every non-gap cell must render clean — a failure is a new silent gap.
          expect(failure, `${key} does not render: ${failure}`).toBeNull();
        }
      });
    }
  }
});
