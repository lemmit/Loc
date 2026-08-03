// Structural pin: every behavioural runner that boots a server tears it down
// through `proc.mjs`.
//
// Its sibling (`behavioral-proc.test.ts`) proves the HELPERS are correct. This
// one proves they are USED — which is the half that actually regressed. The
// race lived for as long as it did because each runner carried its own private
// copy of the teardown, so fixing one said nothing about the other five; a
// seventh runner added tomorrow would reintroduce it by copy-paste from a
// sibling, and no runtime gate would notice until a leg lost the race.
//
// Deliberately a SOURCE check, not a behavioural one: what is being pinned is
// "no runner owns its own process lifecycle", and that is a property of the
// code's shape. It is the cheap structural guard that makes the expensive
// runtime guard sufficient.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BEHAVIORAL = join(dirname(fileURLToPath(import.meta.url)), "..", "behavioral");

/** Runner sources, minus the shared modules they import. */
function runners(): { name: string; src: string }[] {
  return readdirSync(BEHAVIORAL)
    .filter((f) => f.startsWith("run") && f.endsWith(".mjs"))
    .map((name) => ({ name, src: readFileSync(join(BEHAVIORAL, name), "utf8") }));
}

/** Does this runner spawn a long-lived server on a fixed port?  `run.mjs` boots
 *  Hono in-process on PGlite and `run-ui.mjs` shells out to Playwright, so
 *  neither owns a server lifecycle — the property under test does not apply. */
const bootsAServer = (src: string): boolean => /^\s*server = spawn\(/m.test(src);

describe("behavioural runners do not own their process lifecycle", () => {
  it("finds the runners at all", () => {
    // Guard against the whole suite silently passing because a rename made the
    // glob match nothing — the classic vacuous-green.
    const found = runners();
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found.filter((r) => bootsAServer(r.src)).length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, src } of runners().filter((r) => bootsAServer(r.src))) {
    describe(name, () => {
      it("tears down via stopServer, never a bare signal", () => {
        expect(src, "must import the shared lifecycle helpers").toContain('from "./proc.mjs"');
        expect(src).toMatch(/await stopServer\(server\)/);
        // A hand-rolled kill is the exact shape of the original defect: it
        // returns before the process is gone, and the port stays held.
        expect(src, "no direct process-group signal").not.toMatch(/process\.kill\(-/);
        expect(src, "no bare server.kill in teardown").not.toMatch(/server\.kill\(/);
      });

      it("waits for the port to be free before booting the next case", () => {
        expect(src).toMatch(/await waitForPortFree\(PORT\)/);
        // Ordering is the property, not mere presence: the check is worthless
        // after the server is already up.
        const free = src.search(/await waitForPortFree\(PORT\)/);
        const spawnAt = src.search(/^\s*server = spawn\(/m);
        expect(free).toBeGreaterThan(-1);
        expect(free, "waitForPortFree must precede the spawn").toBeLessThan(spawnAt);
      });

      it("spawns detached, so the group signal reaches the real listener", () => {
        // Every runner launches the server through a wrapper (`dotnet run`,
        // `uv run uvicorn`, `npm run dev`, `mix phx.server`); without its own
        // process group, killing the pid node owns leaves the listener alive.
        expect(src).toMatch(/detached:\s*true/);
      });

      it("does not keep a private copy of the helpers", () => {
        for (const fn of ["waitForPort", "waitForPortFree", "stopServer"]) {
          expect(src, `${fn} must come from proc.mjs`).not.toMatch(
            new RegExp(`^\\s*(?:async\\s+)?function ${fn}\\(`, "m"),
          );
        }
      });
    });
  }
});
