import { describe, expect, it } from "vitest";
import { parsePositions, serializePositions } from "../../web/src/builder/system/positions.js";

describe("builder node-position persistence", () => {
  it("round-trips a position map through serialize → parse", () => {
    const map = new Map([
      ["aggregate:Order", { x: 10, y: 20 }],
      ["event:Placed", { x: -5, y: 0 }],
    ]);
    const back = parsePositions(serializePositions(map));
    expect(back).toEqual(map);
  });

  it("returns an empty map for null / empty / corrupt input", () => {
    expect(parsePositions(null).size).toBe(0);
    expect(parsePositions("").size).toBe(0);
    expect(parsePositions("{not json").size).toBe(0);
  });

  it("discards entries that aren't numeric x/y points", () => {
    const json = JSON.stringify({
      good: { x: 1, y: 2 },
      missingY: { x: 3 },
      stringy: { x: "1", y: "2" },
      nope: 42,
    });
    const map = parsePositions(json);
    expect([...map.keys()]).toEqual(["good"]);
    expect(map.get("good")).toEqual({ x: 1, y: 2 });
  });
});
