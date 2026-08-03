// The behavioural runners' process/port lifecycle (test/behavioral/proc.mjs).
//
// This is gated HERE, in the fast per-PR suite, rather than only inside the slow
// booted legs that consume it — because the defect it guards is a RACE, and a
// race only fails when it loses. On the Elixir leg it produced 11 failing cases
// on one run and 13 on the next with byte-identical generated code (#2379); the
// other five legs carried the same bug and never fired, purely because .NET, the
// JVM, uvicorn and tsx shut down faster than the BEAM. "Green" there was luck,
// not evidence, so the property is asserted directly against a process that
// deliberately refuses to die.
//
// Every test spawns a REAL listener and observes REAL sockets. Nothing here
// asserts on source text: the bug being prevented is a timing property, and the
// code that had it read perfectly.

import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs harness module, deliberately dependency-free JS.
import { stopServer, waitForPort, waitForPortFree } from "../behavioral/proc.mjs";

/** A port unlikely to collide with anything else on the box or in the suite. */
const PORT = 8399;

const alive: ChildProcess[] = [];

afterEach(async () => {
  for (const c of alive.splice(0)) {
    try {
      process.kill(-(c.pid as number), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Never leak a listener into the next test — it would make a later assertion
  // pass or fail for a reason that has nothing to do with what it tests.
  await waitForPortFree(PORT, 10_000).catch(() => undefined);
});

/** Spawn a listener on PORT in its own process group.
 *  `ignoreTermMs > 0` makes it swallow SIGTERM for that long — the slow-shutdown
 *  runtime (the BEAM) that exposed the race. `child` adds a grandchild holding
 *  the socket, mirroring `uv run uvicorn` / `dotnet run` / `npm run dev`, where
 *  the process node knows about is a launcher, not the listener. */
function spawnListener(opts: { ignoreTermMs?: number; child?: boolean } = {}): ChildProcess {
  const { ignoreTermMs = 0, child = false } = opts;
  const listen = `require("net").createServer((s) => s.end()).listen(${PORT}, "127.0.0.1");`;
  const term =
    ignoreTermMs > 0
      ? `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${ignoreTermMs}));`
      : "";
  const src = child
    ? // A launcher that holds the port in a GRANDCHILD and itself ignores
      // SIGTERM, so only a process-group signal takes the listener down.
      `const { spawn } = require("child_process");
       process.on("SIGTERM", () => {});
       spawn(process.execPath, ["-e", ${JSON.stringify(`${term}${listen}setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
       setInterval(() => {}, 1000);`
    : `${term}${listen}setInterval(() => {}, 1000);`;
  const cp = spawn(process.execPath, ["-e", src], { detached: true, stdio: "ignore" });
  alive.push(cp);
  return cp;
}

/** One connect attempt — true if something accepts on PORT right now. */
function listening(port = PORT): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => {
      s.destroy();
      res(false);
    });
  });
}

describe("behavioural runner process lifecycle", () => {
  it("waitForPort resolves once the server accepts, and rejects if it never does", async () => {
    const cp = spawnListener();
    await waitForPort(PORT, 20_000);
    expect(await listening()).toBe(true);
    expect(cp.exitCode).toBeNull();

    // The negative half: an unused port must not resolve. Without this, a
    // waitForPort that resolved unconditionally would pass the assertion above.
    await expect(waitForPort(PORT + 1, 600)).rejects.toThrow(/never listened/);
  });

  it("stopServer does not return until the port is actually free", async () => {
    // The whole defect in one assertion. The old teardown returned in ~0ms with
    // the socket still open; the next case then booted "successfully" against
    // the corpse. Here the server ignores SIGTERM for 2s, so a teardown that
    // fails to wait is measurably distinguishable from one that waits.
    spawnListener({ ignoreTermMs: 2000 });
    await waitForPort(PORT, 20_000);

    const t0 = Date.now();
    await stopServer(alive[0]);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(await listening()).toBe(false);
  });

  it("kills the whole process group, not just the launcher", async () => {
    // `uv run uvicorn`, `dotnet run`, `npm run dev` and `mix phx.server` all hold
    // the port in a CHILD. Signalling only the pid node owns leaves the real
    // listener alive and the port occupied — the same wrong-app outcome by a
    // different route.
    spawnListener({ child: true });
    await waitForPort(PORT, 20_000);

    await stopServer(alive[0]);
    expect(await listening()).toBe(false);
  });

  it("escalates to SIGKILL when the process refuses to exit", async () => {
    // A runtime wedged on shutdown must not hang the whole run: the grace period
    // bounds the wait, and the port still ends up free.
    spawnListener({ ignoreTermMs: 60_000 });
    await waitForPort(PORT, 20_000);

    const t0 = Date.now();
    await stopServer(alive[0], { graceMs: 500 });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(20_000);
    expect(await listening()).toBe(false);
  });

  it("is a no-op on an already-exited process instead of hanging", async () => {
    // Boot failures reject through the `exited` promise, so teardown routinely
    // runs against a process that is already gone. Waiting for an "exit" event
    // that will never be emitted again would deadlock the `finally`.
    const cp = spawnListener();
    await waitForPort(PORT, 20_000);
    await stopServer(cp);
    await expect(stopServer(cp)).resolves.toBeUndefined();
  });

  it("tolerates a missing/undefined server handle", async () => {
    // `server` is `let server` declared before the boot block: an infra failure
    // before spawn leaves it undefined, and the `finally` still runs.
    await expect(stopServer(undefined)).resolves.toBeUndefined();
    await expect(stopServer({} as ChildProcess)).resolves.toBeUndefined();
  });

  it("waitForPortFree resolves only once nothing is listening", async () => {
    spawnListener();
    await waitForPort(PORT, 20_000);

    // Occupied → must NOT resolve; it reports the leftover loudly instead of
    // letting the next case boot on top of it.
    await expect(waitForPortFree(PORT, 600)).rejects.toThrow(/still in use/);

    await stopServer(alive[0]);
    await expect(waitForPortFree(PORT, 10_000)).resolves.toBeUndefined();
  });
});
