// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildShareUrl,
  decodeProject,
  decodeSource,
  encodeProject,
  encodeSource,
  readHash,
  readHashSource,
  writeHashProject,
  writeHashSource,
  type SharedProject,
} from "../../web/src/util/share.js";

const MAIN = "/workspace/main.ddd";

beforeEach(() => {
  // Each test starts from a clean hash so we're not poking at
  // residue from a previous case.
  window.location.hash = "";
});

describe("share.ts — base64url round-trip", () => {
  it("encodeSource/decodeSource round-trips arbitrary UTF-8", () => {
    const samples = [
      "",
      "hello world",
      "context X { aggregate A { sku: string } }",
      "💀 — non-ASCII — 漢字 — 🦊",
      "//\n// comment\nvalueobject Money { amount: decimal }\n",
    ];
    for (const s of samples) {
      expect(decodeSource(encodeSource(s))).toBe(s);
    }
  });

  it("decodeSource returns null on broken input", () => {
    expect(decodeSource("!!!not-base64!!!")).toBeNull();
  });

  it("encodeProject/decodeProject round-trips a multi-file payload", () => {
    const project: SharedProject = {
      files: {
        [MAIN]: "context S { aggregate A {} }",
        "/workspace/shared.ddd": "valueobject Money { amount: decimal }",
        "/workspace/sub/nested.ddd": "// nested",
      },
      active: "/workspace/shared.ddd",
    };
    const decoded = decodeProject(encodeProject(project));
    expect(decoded).toEqual(project);
  });

  it("decodeProject rejects malformed JSON / wrong shape", () => {
    expect(decodeProject(encodeSource("{not json"))).toBeNull();
    expect(decodeProject(encodeSource(JSON.stringify({ files: { a: 1 } })))).toBeNull();
    expect(decodeProject(encodeSource(JSON.stringify({ active: "x" })))).toBeNull();
    expect(decodeProject(encodeSource("null"))).toBeNull();
  });
});

describe("share.ts — hash read/write", () => {
  it("write+read a single-file project produces the legacy `s=` form", () => {
    writeHashProject({
      files: { [MAIN]: "ctx" },
      active: MAIN,
    });
    expect(window.location.hash.startsWith("#s=")).toBe(true);
    expect(window.location.hash.includes("p=")).toBe(false);
    expect(readHashSource()).toBe("ctx");
    const load = readHash();
    expect(load?.kind).toBe("single");
    if (load?.kind === "single") {
      expect(load.text).toBe("ctx");
    }
  });

  it("write+read a multi-file project uses the `p=` form", () => {
    const project: SharedProject = {
      files: {
        [MAIN]: "main body",
        "/workspace/shared.ddd": "shared body",
      },
      active: "/workspace/shared.ddd",
    };
    writeHashProject(project);
    expect(window.location.hash.startsWith("#p=")).toBe(true);
    const load = readHash();
    expect(load?.kind).toBe("project");
    if (load?.kind === "project") {
      expect(load.project).toEqual(project);
    }
  });

  it("readHashSource collapses a multi-file project to its active file", () => {
    writeHashProject({
      files: {
        [MAIN]: "main",
        "/workspace/other.ddd": "other",
      },
      active: "/workspace/other.ddd",
    });
    expect(readHashSource()).toBe("other");
  });

  it("readHashSource returns null when the hash has no shareable payload", () => {
    window.location.hash = "";
    expect(readHashSource()).toBeNull();
    expect(readHash()).toBeNull();
    window.location.hash = "#nothing-here=true";
    expect(readHashSource()).toBeNull();
    expect(readHash()).toBeNull();
  });

  it("legacy writeHashSource writes the legacy `s=` form (byte-compatible)", () => {
    writeHashSource("ctx");
    expect(window.location.hash.startsWith("#s=")).toBe(true);
    expect(readHashSource()).toBe("ctx");
  });

  it("a `p=` payload wins when both `p=` and `s=` are present", () => {
    // Synthesise a hash with both forms (defensive — we never write
    // this ourselves, but a hand-crafted URL might).
    const project: SharedProject = {
      files: { [MAIN]: "project main", "/workspace/x.ddd": "x" },
      active: MAIN,
    };
    const pVal = encodeProject(project);
    const sVal = encodeSource("legacy single");
    window.location.hash = `#s=${sVal}&p=${pVal}`;
    const load = readHash();
    expect(load?.kind).toBe("project");
    if (load?.kind === "project") {
      expect(load.project.files[MAIN]).toBe("project main");
    }
  });

  it("a broken `p=` falls back to `s=` if present", () => {
    const sVal = encodeSource("fallback content");
    window.location.hash = `#p=this-is-not-valid-base64-!!!&s=${sVal}`;
    expect(readHashSource()).toBe("fallback content");
  });
});

describe("share.ts — buildShareUrl", () => {
  beforeEach(() => {
    // Anchor URL so url.hash mutation has a base to work against.
    window.history.replaceState(null, "", "/");
  });

  it("builds a single-file URL from a string", () => {
    const url = buildShareUrl("hello");
    expect(url).toContain("#s=");
    expect(url).not.toContain("#p=");
  });

  it("builds a multi-file URL from a SharedProject", () => {
    const project: SharedProject = {
      files: {
        [MAIN]: "main",
        "/workspace/lib.ddd": "lib",
      },
      active: MAIN,
    };
    const url = buildShareUrl(project);
    expect(url).toContain("#p=");
    expect(url).not.toContain("#s=");
  });

  it("a SharedProject with only main.ddd collapses to the legacy form", () => {
    const project: SharedProject = {
      files: { [MAIN]: "main only" },
      active: MAIN,
    };
    const url = buildShareUrl(project);
    expect(url).toContain("#s=");
    expect(url).not.toContain("#p=");
  });
});
