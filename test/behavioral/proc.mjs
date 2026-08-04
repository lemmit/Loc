// Process/port lifecycle for the behavioural runners — the ONE place that knows
// how a per-case server is waited on and torn down.
//
// WHY THIS MODULE EXISTS.  Every runner that boots a real backend does it the
// same way: generate the case, reset the database, spawn ONE server on ONE fixed
// port, run the emitted suite, kill it, repeat.  The port is reused across
// cases, and that makes teardown a CORRECTNESS concern, not a tidiness one:
//
//   1. teardown SIGTERMs the server and returns immediately;
//   2. the next case drops every schema (`resetDatabase` in cases.mjs);
//   3. the next case calls `waitForPort`, which connects — to the PREVIOUS
//      case's server, still listening;
//   4. `/ready` answers 200, because readiness reports that a pool is healthy,
//      not WHICH application is behind the socket;
//   5. the new case's requests run against the old case's app, whose schema was
//      just dropped underneath it → `relation "…" does not exist` → 500 on the
//      first write.
//
// That shipped as a real failure on the Elixir leg (#2379): 11 failing cases on
// one run and 13 on the next, overlapping but not equal, with byte-identical
// generated code — a failure set that moves while the input does not. Which
// cases lose the race depends only on how fast the runtime shuts down, so the
// legs whose runtime exits quickly (.NET, JVM, uvicorn, tsx) were carrying the
// same bug unfired.
//
// No amount of polling the NEW server can distinguish it from the old one, so
// the guard has to be on the teardown side — hence `stopServer` awaiting the
// exit and `waitForPortFree` proving the socket is actually released.
//
// Dependency-free ON PURPOSE (`node:net` + `node:child_process` types only, no
// `pg`/`esbuild` like cases.mjs): that keeps it importable from the main vitest
// suite, so `test/harness/behavioral-proc.test.ts` gates this behaviour on every
// PR instead of only when one of the slow booted legs happens to lose the race.

import net from "node:net";

/** Default deadline for `waitForPort`.  Runners with a faster boot pass their
 *  own (python 60s, mikroorm 90s) — the value is theirs, not this module's. */
const DEFAULT_LISTEN_TIMEOUT_MS = 180_000;

/** Resolve when TCP :port ACCEPTS a connection, or reject after the deadline. */
export function waitForPort(port, timeoutMs = DEFAULT_LISTEN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        res();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) rej(new Error(`port ${port} never listened`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/** Resolve when TCP :port REFUSES a connection — nothing is listening any more.
 *  The mirror of `waitForPort`, and the precondition for booting the next case
 *  on the same port (see the module header for what happens without it).
 *
 *  Rejects rather than resolving on timeout: a port that never frees means some
 *  earlier server survived its kill, and booting on top of that is precisely the
 *  silent-wrong-app failure this exists to prevent. Loud beats subtle. */
export function waitForPortFree(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        if (Date.now() > deadline) rej(new Error(`port ${port} still in use`));
        else setTimeout(tick, 100);
      });
      sock.once("error", () => {
        sock.destroy();
        res();
      });
    };
    tick();
  });
}

/** SIGTERM the server's process GROUP, then WAIT for it to actually exit,
 *  escalating to SIGKILL if it does not go down within `graceMs`.  Returns only
 *  once the process is reaped.
 *
 *  The process group matters as much as the awaiting: every runner spawns the
 *  server through a launcher (`dotnet run`, `uv run uvicorn`, `npm run dev`,
 *  `mix phx.server`), so the process holding the port is a CHILD of the pid node
 *  knows about. Signalling only that pid leaves the real listener alive — which
 *  is why every caller spawns with `detached: true`, giving the server its own
 *  process group for `kill(-pid)` to reach.
 *
 *  The fallback is not decorative: for a child that is NOT detached there is no
 *  process group whose id equals its pid, so `kill(-pid)` raises ESRCH and the
 *  direct `server.kill` behind it does the work. Correct either way, so a caller
 *  that forgets `detached` degrades to the old behaviour rather than throwing.
 *
 *  Never throws: teardown runs in a `finally`, and masking the real error with a
 *  kill failure would lose the actual diagnosis. */
export function stopServer(server, { graceMs = 15_000 } = {}) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  const signal = (sig) => {
    try {
      process.kill(-server.pid, sig);
    } catch {
      // ESRCH (already reaped) or EPERM — fall back to the direct pid, and if
      // that fails too the process is gone, which is the outcome we wanted.
      try {
        server.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  return new Promise((res) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      res();
    };
    server.once("exit", done);
    server.once("close", done);
    signal("SIGTERM");
    const hard = setTimeout(() => signal("SIGKILL"), graceMs);
    // A process that was already dead before we attached the listeners emits
    // nothing — check once more so teardown cannot hang on a reaped child.
    if (server.exitCode !== null || server.signalCode !== null) done();
  });
}
