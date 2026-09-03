// `src/util/edit-distance.ts` — the metric behind every "did you mean".
//
// The one property worth a test of its own is the reason the metric is
// optimal string alignment rather than plain Levenshtein: a TRANSPOSITION is
// the commonest typo in a keyword the author already knows, and Levenshtein
// scores it 2 — the same as two unrelated substitutions — so any threshold
// tight enough to keep suggestions relevant throws the swap away.

import { describe, expect, it } from "vitest";
import { editDistance, nearestName, withinTypoDistance } from "../../src/util/edit-distance.js";

describe("editDistance", () => {
  it("is 0 for equal strings and the length for an empty one", () => {
    expect(editDistance("react", "react")).toBe(0);
    expect(editDistance("", "react")).toBe(5);
    expect(editDistance("react", "")).toBe(5);
  });

  it("scores an adjacent transposition 1, not 2", () => {
    expect(editDistance("reakt", "react")).toBe(1);
    expect(editDistance("pyhton", "python")).toBe(1);
  });

  it("scores insert / delete / substitute 1 each", () => {
    expect(editDistance("mantinee", "mantine")).toBe(1);
    expect(editDistance("mantin", "mantine")).toBe(1);
    expect(editDistance("mantone", "mantine")).toBe(1);
  });

  it("is symmetric", () => {
    expect(editDistance("svelte", "svlete")).toBe(editDistance("svlete", "svelte"));
  });

  it("counts two independent edits as 2", () => {
    expect(editDistance("angolarr", "angular")).toBe(2);
  });
});

describe("withinTypoDistance", () => {
  it("allows one edit on a short name and two once there is word left", () => {
    expect(withinTypoDistance("vue", "vve", 1)).toBe(true);
    expect(withinTypoDistance("vue", "abc", 2)).toBe(false);
    expect(withinTypoDistance("angular", "angolarr", 2)).toBe(true);
    expect(withinTypoDistance("angular", "flutter", 3)).toBe(false);
  });
});

describe("nearestName", () => {
  const PLATFORMS = ["dotnet", "node", "react", "svelte", "vue", "angular", "flutter"];

  it("finds the intended keyword across a transposition", () => {
    expect(nearestName("reakt", PLATFORMS)).toBe("react");
  });

  it("still finds it in a SHORT name, where the budget is one edit", () => {
    // This is where the metric earns its keep.  `veu` → `vue` is one swap;
    // plain Levenshtein scores it 2, and a three-letter name only gets a
    // one-edit budget (two edits in three letters is a different word), so
    // under Levenshtein the suggestion is dropped entirely.
    expect(editDistance("veu", "vue")).toBe(1);
    expect(nearestName("veu", PLATFORMS)).toBe("vue");
  });

  it("returns nothing when nothing is close", () => {
    expect(nearestName("kotlin", PLATFORMS)).toBeUndefined();
  });

  it("never suggests the word itself", () => {
    expect(nearestName("react", PLATFORMS)).toBeUndefined();
  });

  it("prefers a pure case slip over any one-edit rival", () => {
    // `Vue` differs from `vue` by case only and from `node`/`react` by much
    // more — but a one-edit rival earlier in the list must not win it.
    expect(nearestName("Vue", ["due", "vue"])).toBe("vue");
  });

  it("keeps the first candidate on a tie, so suggestions are stable", () => {
    expect(nearestName("aa", ["ab", "ac"])).toBe("ab");
  });

  it("handles an empty word and empty candidates", () => {
    expect(nearestName("", PLATFORMS)).toBeUndefined();
    expect(nearestName("react", [])).toBeUndefined();
  });
});
