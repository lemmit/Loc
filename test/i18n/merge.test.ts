// Golden tests for the pure three-way merge core (i18n.md §"The four cases").
// Keyed on THEIRS (live source) for which keys exist; OURS (translation) for
// values; BASE (lock) lags to give the merge information.

import { describe, expect, it } from "vitest";
import {
  conflictMarker,
  hasConflictMarkers,
  isTodo,
  mergeCatalog,
  reportHasPending,
  TODO_PREFIX,
} from "../../src/i18n/merge.js";

describe("mergeCatalog — the four cases", () => {
  it("new key → TODO placeholder in the locale, reported as added", () => {
    const { merged, report } = mergeCatalog(
      {}, // BASE
      {}, // OURS (fr)
      { "page.P.heading.a1b2c3": "Shipments" }, // THEIRS
    );
    expect(merged["page.P.heading.a1b2c3"]).toBe(`${TODO_PREFIX}Shipments`);
    expect(isTodo(merged["page.P.heading.a1b2c3"])).toBe(true);
    expect(report.added).toEqual(["page.P.heading.a1b2c3"]);
    expect(report.kept).toEqual([]);
  });

  it("deleted key → dropped from the locale, reported as dropped", () => {
    const { merged, report } = mergeCatalog(
      { "page.P.heading.old111": "Orders" }, // BASE
      { "page.P.heading.old111": "Commandes" }, // OURS
      {}, // THEIRS — key gone from source
    );
    expect(merged).toEqual({});
    expect(report.dropped).toEqual(["page.P.heading.old111"]);
  });

  it("deleted key with --keepStale → parked under _stale.<key>", () => {
    const { merged, report } = mergeCatalog(
      { "page.P.heading.old111": "Orders" },
      { "page.P.heading.old111": "Commandes" },
      {},
      { keepStale: true },
    );
    expect(merged).toEqual({ "_stale.page.P.heading.old111": "Commandes" });
    expect(report.dropped).toEqual(["page.P.heading.old111"]);
  });

  it("unchanged + translated → keeps the human translation untouched", () => {
    const { merged, report } = mergeCatalog(
      { "page.P.heading.k1": "Orders" }, // BASE
      { "page.P.heading.k1": "Commandes" }, // OURS
      { "page.P.heading.k1": "Orders" }, // THEIRS — same source
    );
    expect(merged["page.P.heading.k1"]).toBe("Commandes");
    expect(report.kept).toEqual(["page.P.heading.k1"]);
    expect(report.added).toEqual([]);
  });

  it("source changed (hashed keys) → clean delete-old + add-new TODO", () => {
    // Rephrasing re-hashes the key: old key vanishes from THEIRS, new key
    // appears.  No same-key conflict; the translator gets a fresh TODO.
    const { merged, report } = mergeCatalog(
      { "page.P.heading.old": "Orders" }, // BASE
      { "page.P.heading.old": "Commandes" }, // OURS (translated the old wording)
      { "page.P.heading.new": "Order management" }, // THEIRS (rephrased)
    );
    expect(merged).toEqual({ "page.P.heading.new": `${TODO_PREFIX}Order management` });
    expect(report.added).toEqual(["page.P.heading.new"]);
    expect(report.dropped).toEqual(["page.P.heading.old"]);
  });

  it("source changed on a STABLE key over a translation → conflict markers", () => {
    const { merged, report } = mergeCatalog(
      { "text.Sales.orderNotFound": "Order not found" }, // BASE
      { "text.Sales.orderNotFound": "Commande introuvable" }, // OURS
      { "text.Sales.orderNotFound": "We couldn't find that order" }, // THEIRS
    );
    const value = merged["text.Sales.orderNotFound"];
    expect(hasConflictMarkers(value)).toBe(true);
    expect(value).toContain("Commande introuvable");
    expect(value).toContain("Order not found");
    expect(value).toContain("We couldn't find that order");
    expect(report.conflicted).toEqual(["text.Sales.orderNotFound"]);
  });
});

describe("merge helpers", () => {
  it("output is key-sorted for a clean diff", () => {
    const { merged } = mergeCatalog({}, {}, { "b.k": "B", "a.k": "A" });
    expect(Object.keys(merged)).toEqual(["a.k", "b.k"]);
  });

  it("reportHasPending is true for added / dropped / conflicted, false when only kept", () => {
    expect(reportHasPending({ added: ["x"], kept: [], dropped: [], conflicted: [] })).toBe(true);
    expect(reportHasPending({ added: [], kept: [], dropped: ["x"], conflicted: [] })).toBe(true);
    expect(reportHasPending({ added: [], kept: [], dropped: [], conflicted: ["x"] })).toBe(true);
    expect(reportHasPending({ added: [], kept: ["x"], dropped: [], conflicted: [] })).toBe(false);
  });

  it("conflictMarker embeds all three sides in diff3 order", () => {
    const m = conflictMarker("ours", "base", "theirs");
    expect(m).toBe("<<<<<<< OURS\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> THEIRS");
  });
});
