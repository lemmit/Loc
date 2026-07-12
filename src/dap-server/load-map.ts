// ---------------------------------------------------------------------------
// src/dap-server/load-map.ts — the ONLY `fs`-touching code in `src/dap-server/`
// (see `session.ts`'s module comment: the session class itself is `fs`-free
// so it stays unit-testable with in-memory fixtures).
//
// `loadSourceMap` parses `.loom/sourcemap.json` the exact same way
// `src/cli/main.ts`'s `runTrace` / `runBreakpoints` already do — there is no
// separate validating parser to reuse beyond that: the "parser" for this
// wire format IS `JSON.parse(fs.readFileSync(path, "utf8")) as SourceMap`
// (see `resolveMapPath`/the try/catch around `JSON.parse` in
// `src/cli/main.ts`). Reusing the `SourceMap` TYPE from `src/trace/` (rather
// than redeclaring it here) is what keeps this a genuine reuse and not a
// hand-rolled second JSON->SourceMap bridge.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import type { SourceMap } from "../trace/index.js";
import type { ReadSource } from "./session.js";

/** Parse a `.loom/sourcemap.json` file into a `SourceMap` — same shape, same
 *  `JSON.parse` call, as `ddd trace` / `ddd breakpoints` (`src/cli/
 *  main.ts`). Throws on a missing file or invalid JSON; the caller (`main.ts`)
 *  is responsible for a helpful error message, mirroring the CLI's own
 *  try/catch around this exact call. */
export function loadSourceMap(mapPath: string): SourceMap {
  const raw = fs.readFileSync(mapPath, "utf8");
  return JSON.parse(raw) as SourceMap;
}

/** A `ReadSource` backed by the real filesystem, with a per-path cache (a
 *  stack trace / breakpoint session re-reads the same few `.ddd` files
 *  repeatedly). Returns `undefined` for a missing/unreadable path — never
 *  guesses, mirroring `src/cli/main.ts`'s own `readSource` closures for
 *  `ddd trace` / `ddd breakpoints`. */
export function makeFsReadSource(): ReadSource {
  const cache = new Map<string, string | undefined>();
  return (path: string): string | undefined => {
    if (cache.has(path)) return cache.get(path);
    let text: string | undefined;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      text = undefined;
    }
    cache.set(path, text);
    return text;
  };
}
