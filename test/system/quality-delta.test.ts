// The quality-delta classifier, pinned against REAL merge subjects.
//
// `scripts/quality-delta.mjs` turns the 2026-08-02 audit's hand-reconstructed
// §3 table into a weekly series (M-T9.31 lane 1).  Its whole value rests on one
// judgement call — is this landed merge a FIX, and if so was it discovered by a
// GATE or by an AUDIT — so that judgement is pinned here against a fixture of
// subjects taken verbatim from this repo's `main`, not invented.
//
// Two properties matter more than raw accuracy, and both are asserted below:
//
//   1. THE CLASSIFIER MUST NOT INFLATE ITS OWN SUCCESS METRIC.  R11 pins the
//      metric "gate-discovery share overtakes audit-discovery share".  A gate
//      marker that fires on subjects which merely NAME a gate would score
//      audit-born work (which is what builds gates) as gate-born and walk the
//      number to success on its own.  The `does not credit "gate"` block below
//      is the guard: real subjects that build/extend gates must NOT land in the
//      gate bucket.
//   2. AN UNREADABLE SUBJECT IS UNATTRIBUTED, NEVER A DEFAULT BUCKET.  The
//      audit's own §4 warning is that a confident number from a blind
//      instrument is worse than no number.

import { describe, expect, it } from "vitest";
import {
  arrow,
  BASELINE,
  countCompileSkips,
  countHeexPins,
  countOpenGaps,
  countWireWaivers,
  discoverySource,
  duplicateHeads,
  isFixShaped,
  isMerge,
  parseLog,
  renderReport,
  staleDrafts,
  summarize,
} from "../../scripts/quality-delta.mjs";

// ---------------------------------------------------------------------------
// The fixture: 32 subjects, verbatim from `git log --first-parent` on main.
//
// `fix` = should count as fix-shaped.  `src` = expected discovery bucket.
// Where a subject is genuinely a fix but says nothing about how it was found,
// the expectation is "unattributed" — that is the honest answer, and pinning it
// keeps anyone from "improving" recall by guessing.
// ---------------------------------------------------------------------------

interface Case {
  subject: string;
  fix: boolean;
  src: "gate" | "audit" | "unattributed";
}

const REAL_SUBJECTS: Case[] = [
  // --- conventional-commit fixes -------------------------------------------
  {
    subject:
      "fix(flutter): a parameterless `find` emitted `({})` — Dart's empty record is `()` (#2491)",
    fix: true,
    src: "unattributed",
  },
  {
    subject:
      "fix(hono/v5): pin around the @hono/zod-openapi 1.5.2 type regression — corpus tsc is red on main (#2470)",
    fix: true,
    src: "gate",
  },
  {
    subject:
      'fix(channels): "subscribed" must mean the broker said yes — the readiness defect across all five backends, plus its kafka twin (#2386)',
    fix: true,
    src: "unattributed",
  },
  // --- narrative fixes (this repo's dominant idiom) ------------------------
  {
    subject:
      "M-T6.29: `policy { deny }` crashed codegen on `persistence: dapper`, and the write scope was absent (#2492)",
    fix: true,
    src: "unattributed",
  },
  {
    subject:
      "A wrong verb answers 404 on node/elixir — and nothing BOOTED proved the framework-error contract (#2485)",
    fix: true,
    src: "unattributed",
  },
  {
    subject: "`loom.unknown-page-element` — a typo'd name silently deletes page content (#2360)",
    fix: true,
    src: "unattributed",
  },
  {
    subject:
      "Authorization placement + two read-surface leaks: hoist `requires` out of the entity, close the `join` mask bypass, and make default-deny see explicit handlers (#2443)",
    fix: true,
    src: "unattributed",
  },
  {
    subject:
      "M-T3.7(c): a malformed tenant claim answers 500 instead of empty — port .NET's TryParse-to-null to the other four backends (#2442)",
    fix: true,
    src: "unattributed",
  },
  {
    subject:
      "Frontend walker: exhaustive expression dispatch — no more silent placeholders (#2355)",
    fix: true,
    src: "unattributed",
  },
  {
    subject: "pr-gate: the cron sweep was cancelling itself (#2501)",
    fix: false, // "cancelling itself" names no fix marker — an honest miss, pinned.
    src: "unattributed",
  },
  // --- gate-discovered ------------------------------------------------------
  {
    subject:
      "`elixir-vanilla-build` has been red on main — a fixture naming an api handle it never declared (#2419)",
    fix: true,
    src: "gate",
  },
  {
    subject:
      "api-call-e2e was red on 100% of its main pushes — and the alarm was not listening (#2434)",
    fix: true,
    src: "gate",
  },
  {
    subject:
      "`mask unless` + `audited` did not compile — .NET CS0128, and a Python F821 the same fixture found (#2412)",
    fix: false, // no fix marker in the subject; the discovery signal is still readable.
    src: "gate",
  },
  {
    subject: "Playground e2e: two races on refs that had to agree with pipeline state (#2445)",
    fix: false,
    src: "unattributed",
  },
  // --- audit-discovered -----------------------------------------------------
  {
    subject:
      "Audit R4+R5: gate-mutation policy + API-operation caller census; audited main-red fixes; elixir pull hardening (#2380)",
    fix: false,
    src: "audit",
  },
  {
    subject:
      "Census drains: 210 → 13 pins — every generated route now has a runtime caller, and the nine bugs the callers found (#2448)",
    fix: false,
    src: "audit",
  },
  {
    subject:
      "M-T3.3 ships but nothing built it — a corpus fixture for `deny`, and the python import bug it found (#2451)",
    fix: false,
    src: "audit",
  },
  {
    subject:
      "The e2e-less corpus fixtures get runtime callers — and the ten bugs they found (#2468)",
    fix: false,
    src: "audit",
  },
  {
    subject:
      'Language-size review: the callable fork (M-T5.21) and the 27 "gaps" that were never gaps (M-T9.27) (#2444)',
    fix: false,
    src: "audit",
  },
  {
    subject:
      "M-T9.25: four census probes, four RS-rules, and three defects in rules this PR itself shipped (#2340)",
    fix: false,
    src: "audit",
  },
  {
    subject:
      "retro(§80): an emitted attribute can enforce on one seam and only document on the other (#2415)",
    fix: false,
    src: "audit",
  },
  {
    subject:
      'The "extracted ⇒ rendered" gate — and the dropped/ignored user-visible strings it found (#2395)',
    fix: false,
    src: "audit",
  },
  {
    subject:
      "e2e destroy + all reach their real routes; RS-27 — three backends bypassed their 404 producer on the by-id read (#2429)",
    fix: true,
    src: "unattributed",
  },
  // --- feature work: not fixes, not discoveries ----------------------------
  {
    subject: "M-T1.3 Phase 1: port the ui→projection read path to Angular (#2376)",
    fix: false,
    src: "unattributed",
  },
  {
    subject: "Chart on Svelte — one shared template, both packs (#2503)",
    fix: false,
    src: "unattributed",
  },
  {
    subject:
      "Route-builder unification PR 3: Java renders its route surface from the derivation (#2460)",
    fix: false,
    src: "unattributed",
  },
  {
    subject: "M-T1.11: emit the message CATALOG on all five backends (#2480)",
    fix: false,
    src: "unattributed",
  },
  {
    subject: "M-T3.9: the `Timeline` primitive — make the audit trail visible (#2400)",
    fix: false,
    // Honest miss in the OTHER direction: "audit trail" is a domain feature,
    // not a discovery exercise.  Pinned so a future marker edit that fixes it
    // has to acknowledge this case rather than silently changing the series.
    src: "audit",
  },
  {
    subject: "Remove LikeC4 from the playground (#2431)",
    fix: false,
    src: "unattributed",
  },
  {
    subject: "CI: pr-gate v2 — event-driven, no polling, no parked slot, no timeout (#2463)",
    fix: false,
    src: "unattributed",
  },
  {
    subject:
      "docs(new-plan): 2026-08-10 refresh — reconcile 48 merges, open-PR set, gap trackers; re-rank gaps+bugs first (#2495)",
    fix: false,
    src: "unattributed",
  },
  {
    subject: "CLAUDE.md: catch up with the i18n layer and the CI gates the file predates (#2494)",
    fix: false,
    src: "unattributed",
  },
];

describe("quality-delta — merge detection", () => {
  it("every fixture subject is a merge (they all came from squash-merged PRs)", () => {
    const notMerges = REAL_SUBJECTS.filter((c) => !isMerge(c.subject));
    expect(notMerges.map((c) => c.subject)).toEqual([]);
  });

  it("a direct push (no PR number) is not a merge", () => {
    expect(isMerge("M-T9.31 lane 1: weekly quality-delta cron (claim)")).toBe(false);
    expect(isMerge("wip")).toBe(false);
  });

  it("the PR number must terminate the subject, not merely appear in it", () => {
    // "reconcile 48 merges" and a mid-subject "(#2118)" reference are not
    // merge markers; only the trailing squash suffix is.
    expect(isMerge("Revert (#2118) — the follow-up that re-broke it")).toBe(false);
  });
});

describe("quality-delta — fix-shape classification", () => {
  for (const c of REAL_SUBJECTS) {
    it(`${c.fix ? "fix" : "not a fix"}: ${c.subject.slice(0, 64)}…`, () => {
      expect(isFixShaped(c.subject)).toBe(c.fix);
    });
  }

  it("catches the conventional prefix and the narrative markers alike", () => {
    expect(isFixShaped("fix(java): whatever (#1)")).toBe(true);
    expect(isFixShaped("The scope silently widened (#1)")).toBe(true);
    expect(isFixShaped("A tenant LEAK across the registry (#1)")).toBe(true);
    expect(isFixShaped("codegen CRASHED on an empty body (#1)")).toBe(true);
  });

  it("does not fire on ordinary feature work", () => {
    expect(isFixShaped("Add the Chart primitive to Vue (#1)")).toBe(false);
    expect(isFixShaped("docs: refresh the tracker (#1)")).toBe(false);
  });
});

describe("quality-delta — discovery attribution", () => {
  for (const c of REAL_SUBJECTS) {
    it(`${c.src}: ${c.subject.slice(0, 64)}…`, () => {
      expect(discoverySource({ subject: c.subject })).toBe(c.src);
    });
  }

  it("falls back to the body only when the subject is silent", () => {
    const subject = "The optional find answers 200-null (#1)";
    expect(discoverySource({ subject })).toBe("unattributed");
    expect(
      discoverySource({ subject, body: "Caught because behavioral-e2e-java was red on main." }),
    ).toBe("gate");
  });

  it("the SUBJECT outranks the body — a fix that ADDS a gate is not gate-discovered", () => {
    // The exact confusion the bias guards against: an audit finds a bug and
    // ships the gate for it, and the body then talks about that gate.
    expect(
      discoverySource({
        subject: "Census drains: the nine bugs the callers found (#1)",
        body: "Adds a corpus leg so the class is caught. Previously red on main.",
      }),
    ).toBe("audit");
  });

  it("audit outranks gate within one text — the audit is why the gate exists", () => {
    expect(
      discoverySource({ subject: "audit sweep: elixir-vanilla-build was red on main (#1)" }),
    ).toBe("audit");
  });
});

// ---------------------------------------------------------------------------
// The anti-inflation guard.  See the header, property 1.
// ---------------------------------------------------------------------------

describe("quality-delta — the classifier does not inflate its own success metric", () => {
  // Real subjects that BUILD, EXTEND or REFACTOR a gate.  Under the naive
  // marker list ("corpus", "behavioral", "e2e", "conformance", "gradle") every
  // one of these scores as gate-DISCOVERED, which would walk the R11 metric to
  // "met" without a single extra bug having been caught by CI.
  const BUILDS_A_GATE = [
    "The e2e-less corpus fixtures get runtime callers — and the ten bugs they found (#2468)",
    "M-T1.3 Phase 4: Chart on Feliz and Flutter — the two targets with no pack matrix (#2486)",
    "Widen every heavy gate's `paths:` filter to the five pipeline dirs (#2397)",
    "CI: draft-gate the per-PR fan-out + slot trims (runner-queue relief) (#2449)",
    "docs: the CI-gate -> local-command reverse index, completeness-pinned (#2452)",
    "The chrome gate covered React only — extend it to all 11 packs, and prove it (#2441)",
    "Behavioral e2e — Java (Spring Boot + JPA): promote the leg to per-PR (#1)",
    "corpus-build.yml: shard the elixir leg (#1)",
  ];

  for (const subject of BUILDS_A_GATE) {
    it(`does not credit "gate": ${subject.slice(0, 56)}…`, () => {
      expect(discoverySource({ subject })).not.toBe("gate");
    });
  }

  // REGRESSION.  Both of these were misclassified by the first marker list,
  // and both are SYSTEMATIC rather than one-off: `audited`/`auditable` is a
  // Loom capability that appears in dozens of subjects, and "sweep" is a
  // pr-gate component.  Unqualified, each would have credited a stream of
  // ordinary work to the `audit` bucket — the one the gate share has to
  // overtake — quietly moving the R11 metric away from its target forever.
  it("`audited` the CAPABILITY is not `audit` the methodology", () => {
    expect(
      discoverySource({
        subject: "`mask unless` + `audited` did not compile — .NET CS0128 (#1)",
      }),
    ).toBe("gate");
    expect(discoverySource({ subject: "the auditable mixin stamps twice (#1)" })).toBe(
      "unattributed",
    );
    // …while the methodology word still reads as one.
    expect(discoverySource({ subject: "Audit R4+R5: gate-mutation policy (#1)" })).toBe("audit");
    expect(discoverySource({ subject: "auditing the walker registry (#1)" })).toBe("audit");
  });

  it("a cron `sweep` is a component, not a discovery exercise", () => {
    expect(discoverySource({ subject: "pr-gate: the cron sweep was cancelling itself (#1)" })).toBe(
      "unattributed",
    );
  });

  it("a firing phrase still reads as a gate — the guard is not just 'never say gate'", () => {
    expect(discoverySource({ subject: "corpus-build was red on main for two days (#1)" })).toBe(
      "gate",
    );
    expect(
      discoverySource({ subject: "the java leg did not compile under /warnaserror (#1)" }),
    ).toBe("gate");
    expect(discoverySource({ subject: "the redis channels leg is flaky (#1)" })).toBe("gate");
  });
});

// ---------------------------------------------------------------------------

describe("quality-delta — rollup", () => {
  const commits = REAL_SUBJECTS.map((c) => ({ subject: c.subject, body: "" }));

  it("counts merges, fixes and the discovery split off the real fixture", () => {
    const s = summarize(commits);
    expect(s.merges).toBe(REAL_SUBJECTS.length);
    expect(s.fixes).toBe(REAL_SUBJECTS.filter((c) => c.fix).length);
    expect(s.gate + s.audit + s.unattributed).toBe(s.fixes);
    expect(s.attributed).toBe(s.gate + s.audit);
  });

  it("discovery shares are over ATTRIBUTED fixes, so they total 100", () => {
    const s = summarize(commits);
    if (s.attributed > 0) expect(s.gateShare + s.auditShare).toBe(100);
  });

  it("non-merge commits are excluded from every figure", () => {
    const s = summarize([
      { subject: "fix(x): a crash (#1)", body: "" },
      { subject: "fix(y): another crash, pushed straight to main", body: "" },
    ]);
    expect(s.merges).toBe(1);
    expect(s.fixes).toBe(1);
  });

  it("an empty window divides by zero nowhere", () => {
    const s = summarize([]);
    expect(s).toMatchObject({ merges: 0, fixes: 0, fixShare: 0, gateShare: 0, auditShare: 0 });
  });
});

describe("quality-delta — git log reader", () => {
  const NUL = "\u0000";
  const RS = "\u001e";

  it("splits NUL-delimited fields and RS-delimited records, bodies included", () => {
    const raw = `abc${NUL}subject one (#1)${NUL}body line${RS}def${NUL}subject two (#2)${NUL}${RS}`;
    expect(parseLog(raw)).toEqual([
      { sha: "abc", subject: "subject one (#1)", body: "body line" },
      { sha: "def", subject: "subject two (#2)", body: "" },
    ]);
  });

  it("survives a body containing newlines and parentheses", () => {
    // The separators are the two bytes a git subject/body cannot contain —
    // splitting on anything a commit CAN contain (a newline, a pipe) would
    // shred exactly the multi-paragraph bodies the attribution reads.
    const raw = `abc${NUL}s (#1)${NUL}line1\n\nline2 (#99)`;
    const [c] = parseLog(raw);
    expect(c.body).toContain("line2 (#99)");
    expect(c.subject).toBe("s (#1)");
  });

  it("an empty log is an empty list, not one blank commit", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog(`${RS}${RS}\n`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R12 — claim hygiene.
// ---------------------------------------------------------------------------

describe("quality-delta — R12 duplicate claims", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 7, n)).toISOString();
  const now = Date.UTC(2026, 7, 20);

  it("flags two open PRs on one head branch (the #2349/#2351 shape)", () => {
    const dupes = duplicateHeads([
      { number: 2349, title: "draft", draft: true, headRef: "claude/x", headCommittedAt: day(1) },
      { number: 2351, title: "ready", draft: false, headRef: "claude/x", headCommittedAt: day(1) },
      { number: 2360, title: "other", draft: false, headRef: "claude/y", headCommittedAt: day(1) },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].headRef).toBe("claude/x");
    expect(dupes[0].prs.map((p) => p.number)).toEqual([2349, 2351]);
  });

  it("a healthy PR list yields no findings", () => {
    expect(
      duplicateHeads([
        { number: 1, title: "a", draft: false, headRef: "claude/a", headCommittedAt: day(1) },
        { number: 2, title: "b", draft: false, headRef: "claude/b", headCommittedAt: day(1) },
      ]),
    ).toEqual([]);
  });

  it("stale drafts are keyed on the HEAD COMMIT, not on PR activity", () => {
    const prs = [
      // Parked 19 days — a comment or a label would have bumped `updated_at`,
      // which is exactly why that field is not what this reads.
      { number: 10, title: "parked", draft: true, headRef: "a", headCommittedAt: day(1) },
      { number: 11, title: "fresh", draft: true, headRef: "b", headCommittedAt: day(19) },
      // Ready PRs never go stale by this rule — they are not claims in flight.
      { number: 12, title: "ready+old", draft: false, headRef: "c", headCommittedAt: day(1) },
    ];
    const stale = staleDrafts(prs, { now, days: 10 });
    expect(stale.map((p) => p.number)).toEqual([10]);
    expect(stale[0].idleDays).toBe(19);
  });

  it("sorts the stalest first", () => {
    const stale = staleDrafts(
      [
        { number: 1, title: "a", draft: true, headRef: "a", headCommittedAt: day(5) },
        { number: 2, title: "b", draft: true, headRef: "b", headCommittedAt: day(1) },
      ],
      { now, days: 3 },
    );
    expect(stale.map((p) => p.number)).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Register readers.  These are line readers over hand-maintained literals, so
// the risk is not a wrong count — it is a SILENT ZERO after someone reformats
// the file.  Each reader must throw rather than report a comforting 0.
// ---------------------------------------------------------------------------

describe("quality-delta — register readers", () => {
  it("counts wire waivers by their mandatory `reason:` field", () => {
    const src = [
      "export const WIRE_WAIVERS: readonly WireWaiver[] = [",
      "  // a comment mentioning reason: not at four spaces",
      "  {",
      '    backends: ["java"],',
      '    reason: "RS-20 — something",',
      "  },",
      "  {",
      '    backends: ["python"],',
      '    reason: "RS-21 — something else",',
      "  },",
      "];",
    ].join("\n");
    expect(countWireWaivers(src)).toBe(2);
  });

  it("an empty waiver registry reads 0 — the target state, not an error", () => {
    expect(countWireWaivers("export const WIRE_WAIVERS: readonly WireWaiver[] = [];")).toBe(0);
  });

  it("throws rather than reporting 0 when the waiver array is gone", () => {
    expect(() => countWireWaivers("const SOMETHING_ELSE = [];")).toThrow(/WIRE_WAIVERS/);
  });

  it("splits the unsupported register into open gaps and by-design scope rows", () => {
    const src = [
      "export const UNSUPPORTED_REGISTER: readonly UnsupportedEntry[] = [",
      "  {",
      '    code: "loom.a-unsupported",',
      '    kind: "gap",',
      "  },",
      "  {",
      '    code: "loom.b-unsupported",',
      '    kind: "gap",',
      "  },",
      "  {",
      '    code: "loom.c-unsupported",',
      '    kind: "scope",',
      "  },",
      "];",
    ].join("\n");
    expect(countOpenGaps(src)).toEqual({ gaps: 2, scope: 1, rows: 3 });
  });

  it("throws rather than reporting 0 gaps when the register format moves", () => {
    expect(() =>
      countOpenGaps("export const UNSUPPORTED_REGISTER: readonly UnsupportedEntry[] = [];"),
    ).toThrow(/no rows read/);
  });

  it("reads HEEx pins as object keys, skipping the comment lines around them", () => {
    const src = [
      "const KNOWN_HEEX_GAPS: Record<string, string> = {",
      "  // DEFERRED — a paragraph about why: it is deferred",
      '  DataGrid: "no LiveView analogue",',
      '  "Odd-Name": "quoted key",',
      "};",
    ].join("\n");
    expect(countHeexPins(src)).toEqual(["DataGrid", "Odd-Name"]);
  });

  it("reads a comment-only COMPILE_SKIP map as empty — the drained state", () => {
    const drained = [
      "const JAVA_COMPILE_SKIP: Record<string, string> = {",
      "  // (empty — M-T6.19 closed the last java compile-tier skip.)",
      "};",
    ].join("\n");
    const withSkips = [
      "const DAPPER_COMPILE_SKIP: Record<string, string> = {",
      '  "projection-aggregation":',
      '    "query-time projection handlers are EF-LINQ",',
      '  "projection-groupby": "same as above",',
      "};",
    ].join("\n");
    expect(countCompileSkips({ java: drained, dapper: withSkips })).toEqual({
      java: [],
      dapper: ["projection-aggregation", "projection-groupby"],
    });
  });

  it("throws rather than reporting 0 skips when the map is renamed away", () => {
    expect(() => countCompileSkips({ java: "const NOTHING = {};" })).toThrow(/COMPILE_SKIP/);
  });
});

// ---------------------------------------------------------------------------
// Against the REAL repo files — the readers must actually reach them.  A
// fixture-only test would pass while the live paths were wrong (§59: "a check
// that never reaches the thing it names").
// ---------------------------------------------------------------------------

describe("quality-delta — the readers reach the live repo files", async () => {
  const { readRegisters } = await import("../../scripts/quality-delta.mjs");
  const registers = readRegisters();

  it("reads a plausible unsupported register (the population, not a zero)", () => {
    expect(registers.register.rows).toBeGreaterThan(10);
    expect(registers.register.gaps + registers.register.scope).toBe(registers.register.rows);
  });

  it("reads every corpus backend's skip map", () => {
    expect(Object.keys(registers.compileSkips).sort()).toEqual([
      "dapper",
      "dotnet",
      "elixir",
      "java",
      "node",
      "python",
    ]);
  });

  it("waiver and pin counts are numbers, whatever they currently are", () => {
    expect(Number.isInteger(registers.wireWaivers)).toBe(true);
    expect(Array.isArray(registers.heexPins)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Week-over-week Δ (M-T9.31 lane 2).
//
// The bug this section exists to prevent: the report used to diff every run
// against a FROZEN constant (the 2026-08-02 audit), so a ratchet drained after
// that date read as GROWTH forever.  The 2026-08-16 run printed `wire waivers
// 2 → 4 ↑ +2 ⚠️` while the real week-over-week movement was DOWNWARD, and
// `COMPILE_SKIP 0 → 2 ↑ +2 ⚠️` for a pair that had not moved at all.  In a repo
// whose convention is "a stale waiver fails its gate", a false ⚠️ costs an
// agent a re-fix of something already fixed.
//
// Δ is now derived — the same register files read at the commit that was tip
// when the window opened — so there is no stored series to go stale.
// ---------------------------------------------------------------------------

describe("quality-delta — the Δ cell", () => {
  it("a drained ratchet reads as an improvement, not a regression", () => {
    expect(arrow(4, 7)).toBe("↓ -3 ✅");
  });

  it("MUTATION PROOF: the same drain read as a REGRESSION against the frozen baseline", () => {
    // 7 → 4 is the movement; BASELINE.wireWaivers (2) is what the old code
    // compared against.  If this ever stops being a ⚠️, the old behaviour has
    // come back and the test above is no longer proving anything.
    expect(arrow(4, BASELINE.wireWaivers)).toMatch(/⚠️/);
    expect(arrow(4, 7)).not.toMatch(/⚠️/);
  });

  it("growth is still flagged — the guard did not simply mute the warning", () => {
    expect(arrow(7, 4)).toBe("↑ +3 ⚠️");
  });

  it("an unreadable previous value is `n/a`, never an arrow and never zero", () => {
    // Rendering `null` as 0 would print `↑ +4 ⚠️` on a register that was merely
    // renamed — a phantom regression, the exact false alarm being removed.
    expect(arrow(4, null)).toBe("n/a");
    expect(arrow(4, undefined)).toBe("n/a");
    expect(arrow(0, null)).toBe("n/a");
  });

  it("no movement is flat", () => {
    expect(arrow(2, 2)).toBe("→ flat");
  });
});

describe("quality-delta — reading a register that is absent at the compared commit", () => {
  // `read()` returns undefined for a path that does not exist at a past commit.
  // Every parser funnels through `literalBlock`, so undefined must surface as
  // the parsers' existing "not found" throw — loud at HEAD, degraded to `n/a`
  // for the past — rather than a TypeError from `undefined.indexOf`.
  it("throws a NAMED error rather than a TypeError", () => {
    expect(() => countWireWaivers(undefined as unknown as string)).toThrow(/WIRE_WAIVERS/);
    expect(() => countHeexPins(undefined as unknown as string)).toThrow(/KNOWN_HEEX_GAPS/);
    expect(() => countOpenGaps(undefined as unknown as string)).toThrow(/UNSUPPORTED_REGISTER/);
  });

  it("a missing corpus file names the backend it belongs to", () => {
    expect(() => countCompileSkips({ dapper: undefined as unknown as string })).toThrow(/dapper/);
  });
});

describe("quality-delta — the report without a comparison point", () => {
  const registers = {
    wireWaivers: 4,
    register: { gaps: 37, scope: 8, rows: 45 },
    heexPins: ["DataGrid"],
    compileSkips: { node: [], dotnet: [], dapper: ["a", "b"], java: [], python: [], elixir: [] },
  };
  const stats = summarize([]);
  const base = {
    now: Date.parse("2026-08-16T07:00:00Z"),
    days: 7,
    registers,
    stats,
    prs: [],
    runs: undefined,
    sha: "abcdef1234567890",
  };

  it("says so plainly instead of fabricating a delta", () => {
    const body = renderReport({ ...base, prev: undefined, prevStats: undefined });
    expect(body).toContain("no previous-week comparison");
    // Not one arrow anywhere in the ratchet table.
    expect(body).not.toMatch(/[↑↓] [+-]\d/);
  });

  it("renders the real delta once a comparison commit exists", () => {
    const prev = { ...registers, wireWaivers: 7, sha: "0123456789abcdef" };
    const body = renderReport({ ...base, prev, prevStats: summarize([]) });
    expect(body).toContain("↓ -3 ✅");
    expect(body).toContain("0123456");
  });
});
