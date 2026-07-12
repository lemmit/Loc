import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DapStackFrame } from "../../src/dap/dap-protocol.js";
import { loadSourceMap } from "../../src/dap-server/load-map.js";
import { LoomDebugSession } from "../../src/dap-server/session.js";
import { generateSystems } from "../../src/system/index.js";
import type { SourceMap } from "../../src/trace/resolve.js";
import { parseValid } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// `LoomDebugSession` — the DAP protocol shell's REMAP LAYER (Milestone 27):
// `initialize`/`setBreakpoints`/`stackTrace` handlers wired over the two
// pure cores (`resolveSetBreakpoints`/`remapStackFrames`, already covered by
// test/dap/set-breakpoints.test.ts + test/dap/stack-trace.test.ts). These
// tests drive the (protected) request handlers directly with hand-built DAP
// response/args objects — the same headless-provable surface those two
// cores' own tests use, one layer up. NOT covered here (and out of scope for
// this slice): a live end-to-end DAP session against a real target debugger
// — see the module comment in src/dap-server/session.ts and
// docs/proposals/source-map-and-debugging.md §6E.
// ---------------------------------------------------------------------------

const DDD_SOURCE = [
  "system Demo {", // 1
  "  subdomain Sales {", // 2
  "    context Orders {", // 3
  "      aggregate Order {", // 4
  "        customerName: string", // 5
  "        operation confirm() { }", // 6
  "      }", // 7
  "    }", // 8
  "  }", // 9
  "}", // 10
].join("\n");

/** 0-based byte offset of 1-based line `line`'s first character — same
 *  convention the other test/dap/*.test.ts fixtures use. */
function startOfLine(line: number): number {
  if (line <= 1) return 0;
  return (
    DDD_SOURCE.split("\n")
      .slice(0, line - 1)
      .join("\n").length + 1
  );
}

const CONFIRM_LINE = 6;
const CONFIRM_LINE_TEXT = DDD_SOURCE.split("\n")[CONFIRM_LINE - 1]!;
const CONFIRM_OFFSET_IN_LINE = CONFIRM_LINE_TEXT.indexOf("confirm");
const CONFIRM_SPAN: [number, number] = [
  startOfLine(CONFIRM_LINE) + CONFIRM_OFFSET_IN_LINE,
  startOfLine(CONFIRM_LINE) + CONFIRM_OFFSET_IN_LINE + "confirm".length,
];

const NO_MATCH_LINE = 2; // "subdomain Sales {" — covered by no region

const GEN_FILE = "hono_api/domain/order.ts";
const DDD_PATH = "main.ddd";

const readSource = (p: string) => (p === DDD_PATH ? DDD_SOURCE : undefined);

function fixtureMap(): SourceMap {
  return {
    version: 1,
    sources: [DDD_PATH],
    files: {
      [GEN_FILE]: [
        {
          target: [55, 55],
          origin: { kind: "source", path: DDD_PATH, span: CONFIRM_SPAN },
          construct: "Orders.Order.confirm",
        },
      ],
    },
  };
}

/** Build a minimal fake DAP response the SDK's `dispatchRequest` would
 *  normally construct (and pre-populate `body = {}`, mirroring
 *  `dispatchRequest`'s own behavior before it calls the request handler —
 *  see `debugSession.js`'s `dispatchRequest`). */
function fakeResponse<T>(command: string): DebugProtocol.Response & { body: T } {
  return {
    seq: 0,
    type: "response",
    request_seq: 1,
    success: true,
    command,
    body: {} as T,
  };
}

describe("LoomDebugSession", () => {
  describe("initializeRequest", () => {
    it("advertises supportsConfigurationDoneRequest and sends an InitializedEvent", () => {
      const session = new LoomDebugSession(fixtureMap(), readSource);
      const sendEventSpy = vi.spyOn(session, "sendEvent");
      const response = fakeResponse<DebugProtocol.Capabilities>("initialize");

      // biome-ignore lint/suspicious/noExplicitAny: invoking a protected SDK handler directly, the headless-testable surface for this slice.
      (session as any).initializeRequest(response, { adapterID: "loom" });

      expect(response.body.supportsConfigurationDoneRequest).toBe(true);
      expect(sendEventSpy).toHaveBeenCalledTimes(1);
      expect(sendEventSpy.mock.calls[0]![0]).toMatchObject({ event: "initialized" });
    });
  });

  describe("setBreakPointsRequest", () => {
    it("verified: a known mapped .ddd line resolves to the generated line, delegating to resolveSetBreakpoints", () => {
      const session = new LoomDebugSession(fixtureMap(), readSource);
      const response = fakeResponse<DebugProtocol.SetBreakpointsResponse["body"]>("setBreakpoints");
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: DDD_PATH },
        breakpoints: [{ line: CONFIRM_LINE }],
      };

      // biome-ignore lint/suspicious/noExplicitAny: invoking a protected SDK handler directly.
      (session as any).setBreakPointsRequest(response, args);

      expect(response.body.breakpoints).toEqual([
        { verified: true, line: 55, source: { path: GEN_FILE } },
      ]);
    });

    it("unverified: a .ddd line covered by no region comes back unverified, keeping the requested line", () => {
      const session = new LoomDebugSession(fixtureMap(), readSource);
      const response = fakeResponse<DebugProtocol.SetBreakpointsResponse["body"]>("setBreakpoints");
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { path: DDD_PATH },
        breakpoints: [{ line: NO_MATCH_LINE }],
      };

      // biome-ignore lint/suspicious/noExplicitAny: invoking a protected SDK handler directly.
      (session as any).setBreakPointsRequest(response, args);

      expect(response.body.breakpoints).toHaveLength(1);
      expect(response.body.breakpoints[0]!.verified).toBe(false);
      expect(response.body.breakpoints[0]!.line).toBe(NO_MATCH_LINE);
    });
  });

  describe("stackTraceRequest (via the fetchRawFrames test seam)", () => {
    /** The full delegating adapter (out of scope for this slice) would feed
     *  `fetchRawFrames` from the target debugger's own reported stack; this
     *  test subclass overrides the seam directly to drive
     *  `stackTraceRequest`'s remap path with no live target debugger — see
     *  the seam's doc comment on `LoomDebugSession.fetchRawFrames`. */
    class TestSession extends LoomDebugSession {
      constructor(
        map: SourceMap,
        rs: (p: string) => string | undefined,
        private readonly rawFrames: DapStackFrame[],
      ) {
        super(map, rs);
      }
      protected override fetchRawFrames(): DapStackFrame[] {
        return this.rawFrames;
      }
    }

    it("remaps a mixed stack (resolved generated frame + <node_internals> passthrough), 1:1 length/order", () => {
      const internalFrame: DapStackFrame = {
        id: 10,
        name: "<anonymous>",
        source: { path: "<node_internals>/internal/timers.js" },
        line: 5,
        column: 1,
      };
      const resolvedFrame: DapStackFrame = {
        id: 11,
        name: "confirm",
        source: { path: GEN_FILE },
        line: 55,
        column: 1,
      };

      const session = new TestSession(fixtureMap(), readSource, [internalFrame, resolvedFrame]);
      const response = fakeResponse<DebugProtocol.StackTraceResponse["body"]>("stackTrace");
      const args: DebugProtocol.StackTraceArguments = { threadId: 1 };

      // biome-ignore lint/suspicious/noExplicitAny: invoking a protected SDK handler directly.
      (session as any).stackTraceRequest(response, args);

      expect(response.body.stackFrames).toHaveLength(2);
      expect(response.body.totalFrames).toBe(2);
      // The <node_internals> frame passes through unchanged (still generated coords).
      expect(response.body.stackFrames[0]).toEqual(internalFrame);
      // The resolved frame is rewritten to .ddd source (rewritten line/source, id/name kept).
      expect(response.body.stackFrames[1]).toEqual({
        id: 11,
        name: "confirm",
        source: { path: DDD_PATH },
        line: CONFIRM_LINE,
        column: CONFIRM_OFFSET_IN_LINE + 1,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// REAL round trip over examples/showcase.ddd, closing the loop through BOTH
// the fs loader (`load-map.ts`'s `loadSourceMap`, exercising the ONLY
// fs-touching code in src/dap-server/) and the session layer
// (`setBreakPointsRequest`) — the same round trip
// test/dap/set-breakpoints.test.ts pins one layer down, one layer up.
// ---------------------------------------------------------------------------

describe("LoomDebugSession — real round trip over examples/showcase.ddd (fs loader)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dap-session-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("load-map.ts parses the real generated --sourcemap map, and the session verifies a requires-guard breakpoint at the known generated site", async () => {
    const showcaseSource = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");
    const model = await parseValid(showcaseSource);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;

    // Write the REAL emitted sourcemap to disk and load it back through the
    // fs-touching loader — this is the code path `main.ts` uses at runtime.
    const mapDir = path.join(tmp, ".loom");
    fs.mkdirSync(mapDir, { recursive: true });
    const mapPath = path.join(mapDir, "sourcemap.json");
    fs.writeFileSync(mapPath, raw, "utf8");

    const map = loadSourceMap(mapPath);
    expect(map).toEqual(JSON.parse(raw));
    const dddPath = map.sources[0]!;

    // Locate a domain/*.ts region carrying a targetCol (the same
    // `requires currentUser.role == "admin"` guard construct
    // test/dap/set-breakpoints.test.ts's own showcase round trip scouts),
    // deriving everything from the emitted map rather than hardcoding.
    let found: { genFile: string; genLine: number; column: number } | undefined;
    for (const genFile of Object.keys(map.files)) {
      if (!/domain\/.*\.ts$/.test(genFile)) continue;
      for (const r of map.files[genFile]!) {
        if (r.targetCol === undefined) continue;
        found = { genFile, genLine: r.target[0], column: r.targetCol[0] };
        break;
      }
      if (found) break;
    }
    expect(found, "expected some domain/*.ts region carrying targetCol").toBeDefined();

    const anyRegion = map.files[found!.genFile]!.find(
      (r) => r.target[0] === found!.genLine && r.targetCol !== undefined,
    )!;
    if (anyRegion.origin.kind !== "source") throw new Error("expected a source origin");
    const dddLine = showcaseSource.slice(0, anyRegion.origin.span[0]).split("\n").length;

    const session = new LoomDebugSession(map, (p) => (p === dddPath ? showcaseSource : undefined));
    const response = fakeResponse<DebugProtocol.SetBreakpointsResponse["body"]>("setBreakpoints");
    const args: DebugProtocol.SetBreakpointsArguments = {
      source: { path: dddPath },
      breakpoints: [{ line: dddLine }],
    };

    // biome-ignore lint/suspicious/noExplicitAny: invoking a protected SDK handler directly.
    (session as any).setBreakPointsRequest(response, args);

    expect(response.body.breakpoints).toHaveLength(1);
    const bp = response.body.breakpoints[0]!;
    expect(bp.verified).toBe(true);
    expect(bp.source?.path).toMatch(/domain\/.*\.ts$/);
    expect(bp.column).toBeDefined();

    // genFile/genLine agree with the scouted region exactly; `column` is
    // deliberately NOT cross-checked against the scouted region's own
    // column here — `resolveSetBreakpoints` picks the NARROWEST
    // origin-span match for the requested .ddd line (see
    // src/dap/set-breakpoints.ts's pinned multi-target design decision),
    // which is not necessarily the first targetCol region this scan
    // happened to find, only ever that it resolves to the SAME line.
    expect({ dddLine, genFile: bp.source?.path, genLine: bp.line }).toEqual({
      dddLine,
      genFile: found!.genFile,
      genLine: found!.genLine,
    });

    // Concrete numbers for the report (also asserted, not just logged).
    expect(bp.column).toBeTypeOf("number");
  });
});
