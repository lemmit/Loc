// ---------------------------------------------------------------------------
// Adapter capability declarations must be READ by something.
//
// The defect this pins: an adapter contract declares a field that LOOKS like a
// capability gate — `supports()`, `supportedShapes`, `supportedStrategies`,
// `supportedKinds` — with a doc comment naming the validator that consumes it,
// and nothing consumes it.  The declaration then drifts free of reality at no
// cost, because the only thing reading it is a test asserting it equals
// itself.  `dapper` advertised `supportedShapes: ["relational"]` for the whole
// period in which it emitted document and embedded shapes, green throughout.
//
// So: every non-`name`, non-`emit*` member of an adapter contract must have a
// read site in `src/`, or be listed in INDIRECT below with the chain that
// carries it to its consumer.  A member reachable only from tests is exactly
// the failure mode above and does not count as live.
//
// Scope note — this checks the CAPABILITY half.  `emit*` members are the
// implementation surface: an adapter contract may legitimately declare one
// ahead of the orchestrator rewire that will call it, and `stubAdapter` makes
// the un-implemented case throw loudly rather than silently pass.  That is a
// different (and self-announcing) kind of unused.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADAPTERS_DIR = path.join(ROOT, "src/generator/_adapters");

/** Members with no direct `src/` read that are nonetheless LIVE, each with the
 *  chain that makes them so.  An entry here is a claim a reviewer can check —
 *  keep the chain concrete enough to re-verify. */
const INDIRECT: Record<string, string> = {
  // live adapter → adapter-metadata-consistency.test.ts pins it against →
  // `styleSupportedLayouts` in platform/adapter-metadata.ts → the validator's
  // `resolveStyleLayoutCompat` → `loom.platform-knob-style-layout-mismatch`.
  // The D-ADAPTER-HOME mirror exists precisely so the validator does NOT have
  // to import the live generator surface, so a direct read cannot appear.
  "StyleAdapter.supportedLayouts": "reaches the validator via the adapter-metadata mirror",
};

/** Contract interfaces to check, by the file that declares them. */
const SURFACES = [
  "persistence-surface.ts",
  "style-surface.ts",
  "resource-surface.ts",
  "layout-surface.ts",
] as const;

/** Members of `interface <Name>Adapter { … }`, ignoring comments. */
function declaredMembers(file: string): { iface: string; member: string; isEmit: boolean }[] {
  const src = fs
    .readFileSync(path.join(ADAPTERS_DIR, file), "utf8")
    // strip block + line comments so a member NAMED in prose is not counted
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const out: { iface: string; member: string; isEmit: boolean }[] = [];
  const ifaceRe = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const m of src.matchAll(ifaceRe)) {
    const [, iface, body] = m;
    for (const line of body!.split("\n")) {
      // `readonly foo: T;` | `foo(...)` | `foo?(...)` — top level of the body only
      const decl = /^ {2}(?:readonly )?(\w+)\??[(:]/.exec(line);
      if (!decl) continue;
      const member = decl[1]!;
      out.push({ iface: iface!, member, isEmit: member.startsWith("emit") });
    }
  }
  return out;
}

/** Does anything in `src/` read `.<member>`, outside the contract declarations
 *  themselves and outside the adapter implementations that merely SET it? */
function hasSrcRead(member: string): boolean {
  let hits: string;
  try {
    hits = execFileSync(
      "grep",
      ["-rn", "--include=*.ts", `\\.${member}\\b`, path.join(ROOT, "src")],
      { encoding: "utf8" },
    );
  } catch {
    return false; // grep exit 1 = no matches
  }
  return hits
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const [file, , ...rest] = line.split(":");
      const text = rest.join(":");
      if (file?.includes("/_adapters/")) return false; // the contract itself
      if (/^\s*(\/\/|\*)/.test(text)) return false; // a comment mentioning it
      return true;
    });
}

describe("adapter capability declarations are live", () => {
  const members = SURFACES.flatMap(declaredMembers);

  it("reads the contracts at all (guards against a vacuous pass)", () => {
    // If the parser silently matched nothing, every assertion below would
    // pass for free — the exact failure mode this file exists to prevent.
    expect(members.length).toBeGreaterThan(8);
    expect(members.map((m) => `${m.iface}.${m.member}`)).toContain("PersistenceAdapter.name");
    expect(members.some((m) => m.isEmit)).toBe(true);
  });

  it.each(
    members
      .filter((m) => !m.isEmit && m.member !== "name")
      .map((m) => [`${m.iface}.${m.member}`] as const),
  )("%s is read by src/, or declares the chain that reads it", (key) => {
    const member = key.split(".")[1]!;
    if (INDIRECT[key]) {
      // Listed as indirect — then it must NOT also have a direct read (that
      // would mean the note is stale and the entry should go).
      expect(hasSrcRead(member)).toBe(false);
      return;
    }
    expect(
      hasSrcRead(member),
      `${key} is declared on an adapter contract but nothing in src/ reads it.\n` +
        `A capability declaration nothing consumes drifts free of reality at no cost — ` +
        `that is how dapper came to advertise supportedShapes: ["relational"] while ` +
        `emitting document and embedded shapes.\n` +
        `Either wire it to a real consumer, delete it, or add it to INDIRECT in ` +
        `${path.relative(ROOT, fileURLToPath(import.meta.url))} with the chain that carries it.`,
    ).toBe(true);
  });
});
