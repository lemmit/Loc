import { describe, expect, it } from "vitest";
import { parseFrames } from "../../src/trace/frames.js";

describe("parseFrames", () => {
  it("parses a V8/Node frame with a function name", () => {
    const [frame] = parseFrames(
      "    at LoginSession.start (/repo/out/hono_api/src/domain/LoginSession.ts:47:12)",
    );
    expect(frame).toEqual({
      lineIndex: 0,
      file: "/repo/out/hono_api/src/domain/LoginSession.ts",
      line: 47,
    });
  });

  it("parses a bare V8/Node frame (no function name)", () => {
    const [frame] = parseFrames("    at /repo/out/hono_api/src/domain/order.ts:88:3");
    expect(frame).toEqual({
      lineIndex: 0,
      file: "/repo/out/hono_api/src/domain/order.ts",
      line: 88,
    });
  });

  it("parses a .NET frame", () => {
    const [frame] = parseFrames(
      "   at Orders.OrderService.Confirm() in /repo/out/dotnet_api/Domain/OrderService.cs:line 47",
    );
    expect(frame).toEqual({
      lineIndex: 0,
      file: "/repo/out/dotnet_api/Domain/OrderService.cs",
      line: 47,
    });
  });

  it("parses a Java frame, carrying the FQN", () => {
    const [frame] = parseFrames("\tat com.acme.app.features.order.Order.confirm(Order.java:47)");
    expect(frame).toEqual({
      lineIndex: 0,
      file: "Order.java",
      line: 47,
      javaFqn: "com.acme.app.features.order.Order.confirm",
    });
  });

  it("parses a Python frame", () => {
    const [frame] = parseFrames(
      '  File "/repo/out/python_api/app/domain/order.py", line 47, in confirm',
    );
    expect(frame).toEqual({
      lineIndex: 0,
      file: "/repo/out/python_api/app/domain/order.py",
      line: 47,
    });
  });

  it("parses a Python frame with no trailing `in fn`", () => {
    const [frame] = parseFrames('  File "/repo/out/python_api/app/domain/order.py", line 47');
    expect(frame).toEqual({
      lineIndex: 0,
      file: "/repo/out/python_api/app/domain/order.py",
      line: 47,
    });
  });

  it("parses an Elixir frame with the (app vsn) prefix", () => {
    const [frame] = parseFrames(
      "(phoenix_api 0.1.0) lib/phoenix_api/order.ex:47: PhoenixApi.Order.confirm/2",
    );
    expect(frame).toEqual({ lineIndex: 0, file: "lib/phoenix_api/order.ex", line: 47 });
  });

  it("parses a bare Elixir frame (no app/vsn prefix)", () => {
    const [frame] = parseFrames("lib/phoenix_api/order.ex:47: PhoenixApi.Order.confirm/2");
    expect(frame).toEqual({ lineIndex: 0, file: "lib/phoenix_api/order.ex", line: 47 });
  });

  it("assigns the correct lineIndex per frame across a multi-line log", () => {
    const log = [
      "Error: boom",
      "    at LoginSession.start (/p/file.ts:47:12)",
      "    at repository.ts:88:3",
    ].join("\n");
    const frames = parseFrames(log);
    expect(frames.map((f) => f.lineIndex)).toEqual([1, 2]);
  });

  it("does not parse a line with no recognized frame shape", () => {
    expect(parseFrames("Error: something went wrong")).toEqual([]);
    expect(parseFrames("")).toEqual([]);
  });

  // Every format's line-number group is `\d+`, which cannot consume a
  // leading `-` — a negative line number is simply not a frame.
  it("does not parse negative line numbers, in any format", () => {
    expect(parseFrames("    at /p/file.ts:-47:12")).toEqual([]);
    expect(parseFrames("   at Orders.OrderService.Confirm() in /p/File.cs:line -47")).toEqual([]);
    expect(parseFrames("\tat com.acme.app.Foo.bar(Foo.java:-47)")).toEqual([]);
    expect(parseFrames('  File "/p/file.py", line -47, in fn')).toEqual([]);
    expect(parseFrames("(app 0.1.0) lib/app/foo.ex:-47: Mod.fun/2")).toEqual([]);
    expect(parseFrames("lib/app/foo.ex:-47: Mod.fun/2")).toEqual([]);
  });
});
