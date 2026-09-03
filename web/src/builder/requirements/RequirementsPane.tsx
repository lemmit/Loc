// Requirements pane — a view of the file's traceability artifacts that
// reads + edits the same `.ddd` source.  Layout: tree of requirements +
// test cases + solutions on the left, detail/edit form on the right.
//
// Edits go through the existing CST edit engine (see
// `web/src/builder/edit-engine.ts`): we generate fresh text for the
// changed construct via the printers in `./printers.ts` and splice it
// over the original node's CST range, so everything outside is preserved
// byte-for-byte.  The autocomplete `entitles` / `covers` picker is fed
// from the Targetable symbol index we already compute in the language
// scope provider, so qualified names stay in sync with the model.

import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { AstUtils, type AstNode } from "langium";
import type { LayoutCtx } from "../../layout/ctx";
import { spliceNodeIfParses } from "../edit-engine";
import { RefusalLine } from "../refusal";
import { ParseErrorState } from "../ParseErrorState";
import { PARSE_ERROR } from "../../layout/vocabulary";
import { usePaneHarness } from "../pane-harness";
import { UndoRedo, paneUndoKeyHandler } from "../undo-redo";
import { InlineConfirm, confirmSites } from "../../util/confirm";
import {
  printRequirementText,
  printSolutionText,
  printTestCaseText,
  type RequirementSpec,
  type RequirementStatus,
  type RequirementType,
} from "./printers";
import {
  isRequirement,
  isSolution,
  isTargetable,
  isTestCase,
  type Requirement,
  type Solution,
  type TestCase,
} from "../../../../src/language/generated/ast.js";
import { lowerModel } from "../../../../src/ir/lower/lower.js";
import { enrichLoomModel } from "../../../../src/ir/enrich/enrichments.js";
import { computeVerification } from "../../../../src/verify/verification.js";
import type {
  RequirementVerdict,
  TestCaseStatus,
  TestOutcome,
  VerificationIR,
} from "../../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Parse + collect
// ---------------------------------------------------------------------------

interface TargetableSymbol {
  qn: string;
  kind: string;
}

interface CollectedTrace {
  requirements: Requirement[];
  solutions: Solution[];
  testCases: TestCase[];
  childrenOf: Record<string, string[]>;
  solutionsFor: Record<string, string[]>;
  testCasesByRequirement: Record<string, string[]>;
  targetables: TargetableSymbol[];
}

function qnOf(node: AstNode): string {
  const segments: string[] = [];
  let cur: AstNode | undefined = node;
  while (cur && cur.$type !== "System" && cur.$type !== "Model") {
    const name = (cur as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) segments.unshift(name);
    cur = cur.$container;
  }
  return segments.join(".");
}

function collect(ast: unknown): CollectedTrace {
  const requirements: Requirement[] = [];
  const solutions: Solution[] = [];
  const testCases: TestCase[] = [];
  const targetables: TargetableSymbol[] = [];
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (isRequirement(node)) requirements.push(node);
    else if (isSolution(node)) solutions.push(node);
    else if (isTestCase(node)) testCases.push(node);
    if (isTargetable(node)) {
      const qn = qnOf(node);
      if (qn) targetables.push({ qn, kind: node.$type });
    }
  }

  const childrenOf: Record<string, string[]> = {};
  for (const r of requirements) (childrenOf[r.name] ??= []);
  for (const r of requirements) {
    const parent = r.parent?.ref?.name;
    if (parent) (childrenOf[parent] ??= []).push(r.name);
  }

  const solutionsFor: Record<string, string[]> = {};
  for (const s of solutions) {
    const target = s.requirement?.ref?.name;
    if (target) (solutionsFor[target] ??= []).push(s.name);
  }

  const directTests: Record<string, string[]> = {};
  for (const tc of testCases) {
    const target = tc.requirement?.ref?.name;
    if (target) (directTests[target] ??= []).push(tc.name);
  }
  const testCasesByRequirement: Record<string, string[]> = {};
  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(childrenOf[id] ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      stack.push(...(childrenOf[cur] ?? []));
    }
    return out;
  };
  for (const r of requirements) {
    const ids = new Set(directTests[r.name] ?? []);
    for (const d of descendants(r.name)) for (const t of directTests[d] ?? []) ids.add(t);
    testCasesByRequirement[r.name] = [...ids];
  }

  // De-dupe targetables: every qn is unique (the scope provider already
  // requires it), but sort for stable picker option order.
  const seenQns = new Set<string>();
  const uniqueTargetables = targetables.filter((t) => {
    if (seenQns.has(t.qn)) return false;
    seenQns.add(t.qn);
    return true;
  });
  uniqueTargetables.sort((a, b) => a.qn.localeCompare(b.qn));

  return {
    requirements,
    solutions,
    testCases,
    childrenOf,
    solutionsFor,
    testCasesByRequirement,
    targetables: uniqueTargetables,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIREMENT_TYPES: RequirementType[] = [
  "UserStory",
  "UseCase",
  "AcceptanceCriteria",
  "BusinessReq",
];
const REQUIREMENT_STATUSES: RequirementStatus[] = [
  "Draft",
  "Approved",
  "InProgress",
  "Done",
];

const REQUIREMENT_TYPE_COLOR: Record<string, string> = {
  UserStory: "blue",
  UseCase: "violet",
  AcceptanceCriteria: "teal",
  BusinessReq: "indigo",
};
const STATUS_COLOR: Record<string, string> = {
  Draft: "gray",
  Approved: "cyan",
  InProgress: "yellow",
  Done: "green",
};

const VERDICT_COLOR: Record<RequirementVerdict, string> = {
  VERIFIED: "green",
  FAILING: "red",
  UNTESTED: "gray",
  UNVERIFIED: "yellow",
};
// Hover text for the verdict badge — UNTESTED vs UNVERIFIED is not a
// distinction a reader can guess from the two words alone.
const VERDICT_HINT: Record<RequirementVerdict, string> = {
  VERIFIED: "Verified: every test case for this requirement ran and passed",
  FAILING: "Failing: at least one test case for this requirement failed",
  UNTESTED: "Untested: no test case verifies this requirement yet",
  UNVERIFIED: "Unverified: test cases exist but have not been run (or have no executable test)",
};
const TESTCASE_STATUS_COLOR: Record<TestCaseStatus, string> = {
  VERIFIED: "green",
  FAILING: "red",
  UNVERIFIED: "yellow",
};

function reqProp(r: Requirement, key: string): string | number | undefined {
  for (const p of r.props) {
    if (p.name !== key) continue;
    const v = p.value;
    if (!v) return undefined;
    if (v.$type === "NameRef") return (v as { name: string }).name;
    if (v.$type === "StringLit") return (v as { value: string }).value;
    if (v.$type === "IntLit") return (v as { value: number }).value;
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

type Selection =
  | { kind: "requirement"; id: string }
  | { kind: "testCase"; id: string }
  | { kind: "solution"; id: string };

export default function RequirementsPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // The shared safety rails (parse memo + `rev` + write gate + refusal line) —
  // see `pane-harness.ts`.  `rev` bumps on save so we re-parse the (mutated)
  // source and re-render forms with the canonical text.
  //
  // Deriving on `ctx` used to re-parse the source AND (below) re-run
  // `lowerModel` + `enrichLoomModel` synchronously on the render path for every
  // unrelated app tick — a pipeline step, a diagnostic, an agent token, a test
  // result.  Both now hang off the harness's source-change signals.
  const harness = usePaneHarness(ctx);
  const { parsed, rev, refusal } = harness;
  const trace = useMemo(() => collect(parsed.ast), [parsed]);
  const [selected, setSelected] = useState<Selection | null>(null);
  // DIRTY GUARD (M-T8.17, audit H11): the detail form reports whether it
  // holds unsaved edits; a row click (or mobile "Back") while it does is
  // held behind an inline confirm instead of dropping the form.  `undefined`
  // = nothing pending; `null` = "back to the list" is pending.
  const [formDirty, setFormDirty] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<Selection | null | undefined>(undefined);
  const select = (next: Selection | null): void => {
    const same =
      next !== null && selected !== null && next.kind === selected.kind && next.id === selected.id;
    if (same) return;
    if (formDirty && selected !== null) {
      setPendingSelect(next);
      return;
    }
    setPendingSelect(undefined);
    setSelected(next);
  };
  const forceSelect = (next: Selection | null): void => {
    setPendingSelect(undefined);
    setFormDirty(false);
    setSelected(next);
  };

  // Live verification overlay: lower + enrich the parsed model to get the
  // traceability index, then join the shared `testResults` (lifted into
  // ctx so the Tests panel and this pane see the same outcomes).  Wrapped
  // in try/catch because lowering can throw on a model that the parser
  // accepts but the IR doesn't (extremely rare during normal editing).
  const verification = useMemo<VerificationIR | null>(() => {
    if (trace.requirements.length === 0) return null;
    try {
      const loom = enrichLoomModel(lowerModel(parsed.ast));
      if (!loom.traceability) return null;
      const outcomes: TestOutcome[] = Object.values(ctx.testResults).map((r) => ({
        name: r.name,
        suite: r.suite,
        status: r.status,
      }));
      return computeVerification(
        loom.traceability,
        loom.requirements.map((r) => r.id),
        outcomes,
      );
    } catch {
      return null;
    }
  }, [parsed, ctx.testResults, trace.requirements.length]);

  // `originalNode` comes from the memoised parse of this same source, and the
  // spliced candidate is re-parsed by the harness before it commits — a reprint
  // that would leave the file unparseable is refused, not written.
  const apply = (originalNode: AstNode, newText: string): void => {
    const what = `${originalNode.$type} ${(originalNode as { name?: string }).name ?? ""}`.trim();
    harness.on(what).applyOrRefuse(spliceNodeIfParses(ctx.getSource(), originalNode, newText));
  };

  /** Append a fresh top-level block to the end of the source.  We don't
   *  try to position it cleverly — the parser is order-agnostic; users
   *  who want a specific layout can re-arrange in the Source view. */
  const append = (newText: string): void => {
    const source = ctx.getSource();
    const sep = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    harness.apply(source + sep + newText + "\n");
  };

  // Wizard state — which "new …" modal is open, if any.
  const [wizard, setWizard] = useState<null | "requirement" | "testCase" | "solution">(null);

  if (!harness.parseOk) {
    return <ParseErrorState ctx={ctx} purpose={PARSE_ERROR.purpose.requirements} testid="requirements" />;
  }
  if (
    trace.requirements.length === 0 &&
    trace.solutions.length === 0 &&
    trace.testCases.length === 0
  ) {
    return (
      <Box p="md">
        <Text size="sm" c="dimmed">
          This source declares no <Code>requirement</Code>, <Code>solution</Code>, or{" "}
          <Code>testCase</Code> blocks. See <Code>docs/traceability.md</Code> for the
          syntax.
        </Text>
      </Box>
    );
  }

  const reqById = new Map(trace.requirements.map((r) => [r.name, r]));
  const tcById = new Map(trace.testCases.map((t) => [t.name, t]));
  const solById = new Map(trace.solutions.map((s) => [s.name, s]));
  const roots = trace.requirements.filter((r) => !r.parent?.ref);

  // Master-detail layout: side-by-side on desktop; on mobile the tree
  // and the detail occupy the full pane and swap based on selection,
  // with a "Back to list" affordance to clear the selection.
  const isDesktop = ctx.isDesktop;
  const showTree = isDesktop || selected === null;
  const showDetail = isDesktop || selected !== null;

  return (
    // `tabIndex={-1}` + the key handler: a click in the list focuses the pane
    // so ⌘Z / ⌘⇧Z reach the editor's undo stack; the form's inputs keep
    // their own native undo (`undo-keys.ts`).
    <Box
      style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, outline: "none" }}
      tabIndex={-1}
      onKeyDown={paneUndoKeyHandler(ctx.editorHandleRef)}
    >
    <Group px="xs" py={2} bg="dark.7" gap="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
      <UndoRedo handleRef={ctx.editorHandleRef} testidPrefix="requirements" />
    </Group>
    <RefusalLine refusal={refusal} />
    <Box
      style={{
        flex: 1,
        display: "flex",
        flexDirection: isDesktop ? "row" : "column",
        minHeight: 0,
        minWidth: 0,
      }}
      data-testid="requirements-pane"
    >
      {/* Tree (left on desktop, full-width on mobile) */}
      {showTree && (
        <Box
          style={{
            width: isDesktop ? 320 : "100%",
            borderRight: isDesktop ? "1px solid var(--mantine-color-dark-4)" : undefined,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
        <ScrollArea style={{ flex: 1 }}>
          <Box p="sm">
            <SectionHeader
              label="Requirements"
              count={trace.requirements.length}
              onNew={() => setWizard("requirement")}
              newTestid="req-new-requirement"
            />
            <Stack gap={2}>
              {roots.flatMap((r) =>
                renderReqRow(r.name, 0, reqById, trace, verification, selected, select),
              )}
            </Stack>
            <Divider my="sm" />
            <SectionHeader
              label="Test cases"
              count={trace.testCases.length}
              onNew={trace.requirements.length > 0 ? () => setWizard("testCase") : undefined}
              newTestid="req-new-testcase"
              newDisabledReason={
                trace.requirements.length === 0
                  ? "Add a requirement first — a test case must verify one."
                  : undefined
              }
            />
            <Stack gap={2}>
              {trace.testCases.map((t) => (
                <Row
                  key={t.name}
                  testid={`req-row-tc-${t.name}`}
                  active={selected?.kind === "testCase" && selected.id === t.name}
                  onClick={() => select({ kind: "testCase", id: t.name })}
                >
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={500}>{t.name}</Text>
                    <Text size="sm" c="dimmed" truncate>{t.title ?? ""}</Text>
                  </Group>
                </Row>
              ))}
            </Stack>
            <Divider my="sm" />
            <SectionHeader
              label="Solutions"
              count={trace.solutions.length}
              onNew={trace.requirements.length > 0 ? () => setWizard("solution") : undefined}
              newTestid="req-new-solution"
              newDisabledReason={
                trace.requirements.length === 0
                  ? "Add a requirement first — a solution must justify one."
                  : undefined
              }
            />
            {trace.solutions.length > 0 && (
              <Stack gap={2}>
                {trace.solutions.map((s) => (
                  <Row
                    key={s.name}
                    testid={`req-row-sol-${s.name}`}
                    active={selected?.kind === "solution" && selected.id === s.name}
                    onClick={() => select({ kind: "solution", id: s.name })}
                  >
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={500}>{s.name}</Text>
                      <Text size="sm" c="dimmed" truncate>{s.title ?? ""}</Text>
                    </Group>
                  </Row>
                ))}
              </Stack>
            )}
          </Box>
        </ScrollArea>
        </Box>
      )}

      {/* Detail (right on desktop, full-width on mobile when selected) */}
      {showDetail && (
        <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {!isDesktop && selected !== null && (
            <Group
              gap={6}
              px="sm"
              py={6}
              wrap="nowrap"
              style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
            >
              <Button
                size="xs"
                variant="subtle"
                onClick={() => select(null)}
                data-testid="req-back-to-list"
              >
                ← Back
              </Button>
              <Text size="sm" c="dimmed" truncate>
                {selected.id}
              </Text>
            </Group>
          )}
          {pendingSelect !== undefined && selected !== null && (
            <Box px="sm" py={6} style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
              <InlineConfirm
                spec={confirmSites.discardFormEdits(selected.id)}
                size="compact-xs"
                onConfirm={() => forceSelect(pendingSelect)}
                onCancel={() => setPendingSelect(undefined)}
                testids={{ base: "req-select" }}
              />
            </Box>
          )}
          <ScrollArea style={{ flex: 1 }}>
          <Box p="md">
            {selected === null && (
              <Text size="sm" c="dimmed">
                Pick a requirement, test case, or solution on the left to see and edit
                its details.
              </Text>
            )}
            {selected?.kind === "requirement" && reqById.get(selected.id) && (
              <RequirementForm
                // Bump the key on rev so a saved edit re-seeds local state from
                // the canonical re-parsed source.
                key={`req-${selected.id}-${rev}`}
                req={reqById.get(selected.id)!}
                trace={trace}
                verification={verification}
                onApply={apply}
                onSelect={select}
                onDirtyChange={setFormDirty}
              />
            )}
            {selected?.kind === "testCase" && tcById.get(selected.id) && (
              <TestCaseForm
                key={`tc-${selected.id}-${rev}`}
                tc={tcById.get(selected.id)!}
                trace={trace}
                verification={verification}
                onApply={apply}
                onSelect={select}
                onDirtyChange={setFormDirty}
              />
            )}
            {selected?.kind === "solution" && solById.get(selected.id) && (
              <SolutionForm
                key={`sol-${selected.id}-${rev}`}
                sol={solById.get(selected.id)!}
                trace={trace}
                onApply={apply}
                onSelect={select}
                onDirtyChange={setFormDirty}
              />
            )}
          </Box>
          </ScrollArea>
        </Box>
      )}

      {/* "New …" wizards.  After Create we auto-select the new item so
          the user lands in the existing edit form to fill in extras. */}
      {wizard === "requirement" && (
        <NewRequirementWizard
          existingIds={collectIds(trace)}
          requirements={trace.requirements.map((r) => r.name)}
          onCancel={() => setWizard(null)}
          onCreate={(text, newId) => {
            append(text);
            setWizard(null);
            forceSelect({ kind: "requirement", id: newId });
          }}
        />
      )}
      {wizard === "testCase" && (
        <NewTestCaseWizard
          existingIds={collectIds(trace)}
          requirements={trace.requirements.map((r) => r.name)}
          onCancel={() => setWizard(null)}
          onCreate={(text, newId) => {
            append(text);
            setWizard(null);
            forceSelect({ kind: "testCase", id: newId });
          }}
        />
      )}
      {wizard === "solution" && (
        <NewSolutionWizard
          existingIds={collectIds(trace)}
          requirements={trace.requirements.map((r) => r.name)}
          onCancel={() => setWizard(null)}
          onCreate={(text, newId) => {
            append(text);
            setWizard(null);
            forceSelect({ kind: "solution", id: newId });
          }}
        />
      )}
    </Box>
    </Box>
  );
}

function collectIds(trace: CollectedTrace): Set<string> {
  const ids = new Set<string>();
  for (const r of trace.requirements) ids.add(r.name);
  for (const t of trace.testCases) ids.add(t.name);
  for (const s of trace.solutions) ids.add(s.name);
  return ids;
}

// ---------------------------------------------------------------------------
// Tree (read-only)
// ---------------------------------------------------------------------------

function renderReqRow(
  id: string,
  depth: number,
  reqById: Map<string, Requirement>,
  trace: CollectedTrace,
  verification: VerificationIR | null,
  selected: Selection | null,
  setSelected: (s: Selection) => void,
): JSX.Element[] {
  const r = reqById.get(id);
  if (!r) return [];
  const type = reqProp(r, "type") as string | undefined;
  const title = reqProp(r, "title") as string | undefined;
  const status = reqProp(r, "status") as string | undefined;
  const tcCount = (trace.testCasesByRequirement[id] ?? []).length;
  const hasSolution = (trace.solutionsFor[id] ?? []).length > 0;
  const verdict = verification?.requirements[id]?.verdict;
  const here = (
    <Row
      key={r.name}
      testid={`req-row-${r.name}`}
      active={selected?.kind === "requirement" && selected.id === r.name}
      onClick={() => setSelected({ kind: "requirement", id: r.name })}
    >
      <Group gap={6} wrap="nowrap" style={{ paddingLeft: depth * 12 }}>
        {type && (
          <Badge size="xs" color={REQUIREMENT_TYPE_COLOR[type] ?? "gray"} variant="light">
            {type.replace("AcceptanceCriteria", "AC")}
          </Badge>
        )}
        {/* The badges must not shrink: in a narrow list they were the
            first thing flex squeezed, leaving "INPRO…" / "UNT…" / "0…"
            stubs while the (truncatable) title kept its width. */}
        <Text size="sm" fw={500} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{r.name}</Text>
        <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
          {title ?? ""}
        </Text>
        {status && (
          <Badge size="xs" color={STATUS_COLOR[status] ?? "gray"} variant="outline" style={{ flexShrink: 0 }} title={`Status: ${status}`}>
            {status}
          </Badge>
        )}
        {verdict && (
          <Badge
            size="xs"
            color={VERDICT_COLOR[verdict]}
            variant="filled"
            style={{ flexShrink: 0 }}
            title={VERDICT_HINT[verdict]}
            data-testid={`req-verdict-${r.name}`}
          >
            {verdict}
          </Badge>
        )}
        <Badge
          size="xs"
          color={tcCount > 0 ? "green" : "gray"}
          variant="light"
          style={{ flexShrink: 0 }}
          title={`${tcCount} test case${tcCount === 1 ? "" : "s"} verify this requirement`}
        >
          {tcCount} TC
        </Badge>
        {!hasSolution && type === "UserStory" && (
          <Badge size="xs" color="orange" variant="light" style={{ flexShrink: 0 }} title="No solution declared for this user story">
            no sol
          </Badge>
        )}
      </Group>
    </Row>
  );
  const kids = (trace.childrenOf[id] ?? []).flatMap((c) =>
    renderReqRow(c, depth + 1, reqById, trace, verification, selected, setSelected),
  );
  return [here, ...kids];
}

function SectionHeader({
  label,
  count,
  onNew,
  newTestid,
  newDisabledReason,
}: {
  label: string;
  count: number;
  onNew?: () => void;
  newTestid?: string;
  newDisabledReason?: string;
}): JSX.Element {
  const newButton = (
    <Tooltip
      label={newDisabledReason ?? `New ${label.toLowerCase().replace(/s$/, "")}`}
      disabled={!newDisabledReason && !onNew}
    >
      <ActionIcon
        size="xs"
        variant="subtle"
        color="gray"
        onClick={onNew}
        disabled={!onNew}
        data-testid={newTestid}
        aria-label={`New ${label}`}
      >
        +
      </ActionIcon>
    </Tooltip>
  );
  return (
    <Group justify="space-between" mb={6}>
      <Group gap={6}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          {label}
        </Text>
        <Text size="xs" c="dimmed">{count}</Text>
      </Group>
      {newButton}
    </Group>
  );
}

function Row({
  testid,
  active,
  onClick,
  children,
}: {
  testid?: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Box
      data-testid={testid}
      onClick={onClick}
      style={{
        padding: "4px 6px",
        borderRadius: 4,
        cursor: "pointer",
        background: active ? "var(--mantine-color-dark-5)" : "transparent",
      }}
    >
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** Report the form's dirty flag to the pane (for the row-switch guard) —
 *  on every change and, via the cleanup, as `false` when the form unmounts
 *  (a Save re-keys the form; a switch replaces it). */
function useDirtyReport(dirty: boolean, onDirtyChange?: (dirty: boolean) => void): void {
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callback is a state setter; `dirty` is the signal.
  }, [dirty]);
}

function dirtyBadge(): JSX.Element {
  return (
    <Badge size="xs" color="yellow" variant="light" title="Unsaved changes">
      modified
    </Badge>
  );
}

function FormToolbar({
  title,
  dirty,
  onSave,
  onReset,
}: {
  title: React.ReactNode;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
}): JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Group gap={8} wrap="nowrap">{title}</Group>
      <Group gap={6} wrap="nowrap">
        {dirty && dirtyBadge()}
        <Tooltip label="Revert to the source as written">
          <Button size="xs" variant="default" disabled={!dirty} onClick={onReset}>
            Reset
          </Button>
        </Tooltip>
        <Button size="xs" disabled={!dirty} onClick={onSave} data-testid="req-form-save">
          Save
        </Button>
      </Group>
    </Group>
  );
}

function RequirementForm({
  req,
  trace,
  verification,
  onApply,
  onSelect,
  onDirtyChange,
}: {
  req: Requirement;
  trace: CollectedTrace;
  verification: VerificationIR | null;
  onApply: (node: AstNode, newText: string) => void;
  onSelect: (s: Selection) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const initial: Required<Pick<RequirementSpec, "type" | "title">> & {
    status: RequirementStatus | "";
    priority: number | "";
    parent: string;
  } = {
    type: (reqProp(req, "type") as RequirementType | undefined) ?? "UserStory",
    title: (reqProp(req, "title") as string | undefined) ?? "",
    status: ((reqProp(req, "status") as RequirementStatus | undefined) ?? ""),
    priority: ((reqProp(req, "priority") as number | undefined) ?? ""),
    parent: req.parent?.ref?.name ?? "",
  };
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useDirtyReport(dirty, onDirtyChange);
  const solIds = trace.solutionsFor[req.name] ?? [];
  const tcIds = trace.testCasesByRequirement[req.name] ?? [];

  const save = (): void => {
    const spec: RequirementSpec = {
      name: req.name,
      parent: form.parent || undefined,
      type: form.type,
      title: form.title,
      status: form.status === "" ? undefined : (form.status as RequirementStatus),
      priority: form.priority === "" ? undefined : (form.priority as number),
    };
    onApply(req, printRequirementText(spec));
  };

  const parentOptions = trace.requirements
    .map((r) => r.name)
    .filter((id) => id !== req.name);

  return (
    <Stack gap="sm" data-testid={`req-detail-${req.name}`}>
      <FormToolbar
        title={
          <>
            <Title order={4}>{req.name}</Title>
            <Badge color={REQUIREMENT_TYPE_COLOR[form.type] ?? "gray"} variant="light">
              {form.type}
            </Badge>
            {form.status && (
              <Badge color={STATUS_COLOR[form.status] ?? "gray"} variant="outline">
                {form.status}
              </Badge>
            )}
            {verification?.requirements[req.name]?.verdict && (
              <Badge
                color={VERDICT_COLOR[verification.requirements[req.name]!.verdict]}
                variant="filled"
                data-testid={`req-verdict-detail-${req.name}`}
              >
                {verification.requirements[req.name]!.verdict}
              </Badge>
            )}
          </>
        }
        dirty={dirty}
        onSave={save}
        onReset={() => setForm(initial)}
      />

      <TextInput
        label="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
        data-testid="req-form-title"
      />
      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="sm">
        <Select
          label="Type"
          data={REQUIREMENT_TYPES}
          value={form.type}
          onChange={(v) => v && setForm({ ...form, type: v as RequirementType })}
          allowDeselect={false}
          data-testid="req-form-type"
        />
        <Select
          label="Status"
          data={REQUIREMENT_STATUSES}
          value={form.status || null}
          onChange={(v) => setForm({ ...form, status: (v as RequirementStatus | null) ?? "" })}
          clearable
          placeholder="(unset)"
          data-testid="req-form-status"
        />
        <NumberInput
          label="Priority"
          value={form.priority === "" ? "" : form.priority}
          onChange={(v) =>
            setForm({ ...form, priority: typeof v === "number" ? v : "" })
          }
          min={0}
          placeholder="(unset)"
          data-testid="req-form-priority"
        />
        <Select
          label="Parent"
          data={parentOptions}
          value={form.parent || null}
          onChange={(v) => setForm({ ...form, parent: v ?? "" })}
          clearable
          placeholder="(no parent)"
          searchable
          data-testid="req-form-parent"
        />
      </SimpleGrid>

      <Divider my={4} label="Solutions" labelPosition="left" />
      {solIds.length === 0 ? (
        <Text size="sm" c="dimmed">No solution declared for this requirement.</Text>
      ) : (
        <Stack gap={4}>
          {solIds.map((id) => (
            <Group key={id} gap={6}>
              <Link onClick={() => onSelect({ kind: "solution", id })}>{id}</Link>
              <Text size="sm" c="dimmed">
                {trace.solutions.find((s) => s.name === id)?.title ?? ""}
              </Text>
            </Group>
          ))}
        </Stack>
      )}

      <Divider my={4} label="Test cases (incl. children)" labelPosition="left" />
      {tcIds.length === 0 ? (
        <Text size="sm" c="dimmed">No test cases verify this requirement (or its children) yet.</Text>
      ) : (
        <Stack gap={4}>
          {tcIds.map((id) => {
            const tc = trace.testCases.find((t) => t.name === id);
            const verifies = tc?.requirement?.ref?.name;
            const inherited = verifies && verifies !== req.name;
            const status = verification?.testCases[id]?.status;
            return (
              <Group key={id} gap={6}>
                <Link onClick={() => onSelect({ kind: "testCase", id })}>{id}</Link>
                <Text size="sm" c="dimmed">{tc?.title ?? ""}</Text>
                {status && (
                  <Badge
                    size="xs"
                    color={TESTCASE_STATUS_COLOR[status]}
                    variant="light"
                  >
                    {status}
                  </Badge>
                )}
                {inherited && (
                  <Badge size="xs" color="gray" variant="light" title={`via ${verifies}`}>
                    via {verifies}
                  </Badge>
                )}
              </Group>
            );
          })}
        </Stack>
      )}

      {(trace.childrenOf[req.name] ?? []).length > 0 && (
        <>
          <Divider my={4} label="Children" labelPosition="left" />
          <Stack gap={4}>
            {trace.childrenOf[req.name]!.map((id) => {
              const child = trace.requirements.find((r) => r.name === id);
              const childTitle = child ? (reqProp(child, "title") as string | undefined) : undefined;
              return (
                <Group key={id} gap={6}>
                  <Link onClick={() => onSelect({ kind: "requirement", id })}>{id}</Link>
                  <Text size="sm" c="dimmed">{childTitle ?? ""}</Text>
                </Group>
              );
            })}
          </Stack>
        </>
      )}
    </Stack>
  );
}

function SolutionForm({
  sol,
  trace,
  onApply,
  onSelect,
  onDirtyChange,
}: {
  sol: Solution;
  trace: CollectedTrace;
  onApply: (node: AstNode, newText: string) => void;
  onSelect: (s: Selection) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const initial = {
    title: sol.title ?? "",
    forRequirement: sol.requirement?.ref?.name ?? sol.requirement?.$refText ?? "",
    entitles: sol.entitles.map((e) => e.$refText),
  };
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useDirtyReport(dirty, onDirtyChange);

  const save = (): void => {
    onApply(
      sol,
      printSolutionText({
        name: sol.name,
        forRequirement: form.forRequirement,
        title: form.title || undefined,
        entitles: form.entitles,
      }),
    );
  };

  return (
    <Stack gap="sm" data-testid={`sol-detail-${sol.name}`}>
      <FormToolbar
        title={<Title order={4}>{sol.name}</Title>}
        dirty={dirty}
        onSave={save}
        onReset={() => setForm(initial)}
      />
      <TextInput
        label="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
        data-testid="sol-form-title"
      />
      <Group align="end" wrap="nowrap" gap={6}>
        <Select
          label="For requirement"
          data={trace.requirements.map((r) => r.name)}
          value={form.forRequirement || null}
          onChange={(v) => v && setForm({ ...form, forRequirement: v })}
          allowDeselect={false}
          searchable
          style={{ flex: 1 }}
          data-testid="sol-form-for"
        />
        <Tooltip label="Open the requirement this solution is for">
          <ActionIcon
            variant="default"
            disabled={!form.forRequirement}
            onClick={() => onSelect({ kind: "requirement", id: form.forRequirement })}
          >
            →
          </ActionIcon>
        </Tooltip>
      </Group>

      <CodeRefPicker
        label="Entitles"
        description="Code symbols this solution legitimises (Module.Context.Aggregate.operation, deployables, apis, …)."
        value={form.entitles}
        onChange={(v) => setForm({ ...form, entitles: v })}
        targetables={trace.targetables}
        testid="sol-form-entitles"
      />
    </Stack>
  );
}

function TestCaseForm({
  tc,
  trace,
  verification,
  onApply,
  onSelect,
  onDirtyChange,
}: {
  tc: TestCase;
  trace: CollectedTrace;
  verification: VerificationIR | null;
  onApply: (node: AstNode, newText: string) => void;
  onSelect: (s: Selection) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const initial = {
    title: tc.title ?? "",
    verifies: tc.requirement?.ref?.name ?? tc.requirement?.$refText ?? "",
    covers: tc.covers.map((c) => c.$refText),
  };
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useDirtyReport(dirty, onDirtyChange);

  const save = (): void => {
    onApply(
      tc,
      printTestCaseText({
        name: tc.name,
        verifies: form.verifies,
        title: form.title || undefined,
        covers: form.covers,
      }),
    );
  };

  return (
    <Stack gap="sm" data-testid={`tc-detail-${tc.name}`}>
      <FormToolbar
        title={
          <>
            <Title order={4}>{tc.name}</Title>
            {verification?.testCases[tc.name]?.status && (
              <Badge
                color={TESTCASE_STATUS_COLOR[verification.testCases[tc.name]!.status]}
                variant="filled"
                data-testid={`tc-verdict-detail-${tc.name}`}
              >
                {verification.testCases[tc.name]!.status}
              </Badge>
            )}
          </>
        }
        dirty={dirty}
        onSave={save}
        onReset={() => setForm(initial)}
      />
      <TextInput
        label="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
        data-testid="tc-form-title"
      />
      <Group align="end" wrap="nowrap" gap={6}>
        <Select
          label="Verifies"
          data={trace.requirements.map((r) => r.name)}
          value={form.verifies || null}
          onChange={(v) => v && setForm({ ...form, verifies: v })}
          allowDeselect={false}
          searchable
          style={{ flex: 1 }}
          data-testid="tc-form-verifies"
        />
        <Tooltip label="Open the requirement this test case verifies">
          <ActionIcon
            variant="default"
            disabled={!form.verifies}
            onClick={() => onSelect({ kind: "requirement", id: form.verifies })}
          >
            →
          </ActionIcon>
        </Tooltip>
      </Group>

      <CodeRefPicker
        label="Covers"
        description="Code symbols this test case exercises."
        value={form.covers}
        onChange={(v) => setForm({ ...form, covers: v })}
        targetables={trace.targetables}
        testid="tc-form-covers"
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Code-ref picker (Phase 3) — autocomplete chip input typed against the
// Targetable symbols indexed from the live source.
// ---------------------------------------------------------------------------

const KIND_BADGE_COLOR: Record<string, string> = {
  Module: "violet",
  BoundedContext: "violet",
  Aggregate: "blue",
  Operation: "cyan",
  ValueObject: "teal",
  EventDecl: "orange",
  Repository: "grape",
  Workflow: "indigo",
  Deployable: "pink",
  Api: "yellow",
};

function CodeRefPicker({
  label,
  description,
  value,
  onChange,
  targetables,
  testid,
}: {
  label: string;
  description?: string;
  value: string[];
  onChange: (next: string[]) => void;
  targetables: TargetableSymbol[];
  testid?: string;
}): JSX.Element {
  // Mantine MultiSelect requires every selected value to be in `data`.
  // Add any currently-selected values that aren't in the symbol index
  // (renamed/missing code) so we don't silently drop them.
  const knownQns = new Set(targetables.map((t) => t.qn));
  const extras = value.filter((v) => !knownQns.has(v)).map((qn) => ({ value: qn, label: `${qn} (unknown)` }));
  const data = [
    ...targetables.map((t) => ({ value: t.qn, label: t.qn })),
    ...extras,
  ];
  return (
    <Box>
      <MultiSelect
        label={label}
        description={description}
        data={data}
        value={value}
        onChange={onChange}
        searchable
        clearable
        nothingFoundMessage="No matching code symbol"
        data-testid={testid}
      />
      {value.length > 0 && (
        <Group gap={6} mt={6} wrap="wrap">
          {value.map((qn) => {
            const sym = targetables.find((t) => t.qn === qn);
            const kind = sym?.kind ?? "unknown";
            return (
              <Badge
                key={qn}
                size="xs"
                color={KIND_BADGE_COLOR[kind] ?? "gray"}
                variant="light"
                title={kind}
              >
                {kind.replace("EventDecl", "Event").replace("BoundedContext", "Context")}
              </Badge>
            );
          })}
        </Group>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function Link({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Text
      size="sm"
      c="blue.4"
      style={{ cursor: "pointer", textDecoration: "underline" }}
      onClick={onClick}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// "New …" wizards (Phase 4)
//
// Minimal forms — id + the fields the parser requires.  Additional fields
// (entitles / covers, status, priority) are filled in via the regular edit
// form after Create.  IDs validate against the TraceId surface (a plain
// identifier OR `prefix-digits`, possibly with extra alnum segments) and
// must be unique across requirements / solutions / test cases.
// ---------------------------------------------------------------------------

// Matches both the `ID` terminal (`[_a-zA-Z][\w_]*`) and the ticket-style
// `TRACE_ID` (`[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*-[0-9]+`).
const ID_PATTERN = /^([A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*-[0-9]+|[_a-zA-Z][\w_]*)$/;

function validateId(id: string, existing: Set<string>): string | null {
  const trimmed = id.trim();
  if (!trimmed) return "Required";
  if (!ID_PATTERN.test(trimmed)) {
    return "Must be an identifier like `Login` or a ticket id like `US-001`";
  }
  if (existing.has(trimmed)) return `'${trimmed}' is already in use`;
  return null;
}

function WizardShell({
  title,
  testid,
  canCreate,
  onCreate,
  onCancel,
  children,
}: {
  title: string;
  testid: string;
  canCreate: boolean;
  onCreate: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Modal opened onClose={onCancel} title={title} size="md" data-testid={testid}>
      <Stack gap="sm">
        {children}
        <Group justify="flex-end" gap={6} mt="sm">
          <Button variant="default" onClick={onCancel}>Cancel</Button>
          <Button onClick={onCreate} disabled={!canCreate} data-testid={`${testid}-create`}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function NewRequirementWizard({
  existingIds,
  requirements,
  onCreate,
  onCancel,
}: {
  existingIds: Set<string>;
  requirements: readonly string[];
  onCreate: (text: string, id: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [id, setId] = useState("");
  const [type, setType] = useState<RequirementType>("UserStory");
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState<string>("");
  const idErr = id ? validateId(id, existingIds) : null;
  const canCreate = !!id && !idErr && title.length > 0;

  const submit = (): void => {
    if (!canCreate) return;
    const text = printRequirementText({
      name: id.trim(),
      parent: parent || undefined,
      type,
      title,
    });
    onCreate(text, id.trim());
  };

  return (
    <WizardShell
      title="New requirement"
      testid="req-wizard-requirement"
      canCreate={canCreate}
      onCreate={submit}
      onCancel={onCancel}
    >
      <TextInput
        label="ID"
        description="e.g. US-001, AC-001, Login"
        value={id}
        onChange={(e) => setId(e.currentTarget.value)}
        error={idErr ?? undefined}
        autoFocus
        data-testid="req-wizard-id"
      />
      <Select
        label="Type"
        data={REQUIREMENT_TYPES}
        value={type}
        onChange={(v) => v && setType(v as RequirementType)}
        allowDeselect={false}
        data-testid="req-wizard-type"
      />
      <TextInput
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        data-testid="req-wizard-title"
      />
      <Select
        label="Parent (optional)"
        data={requirements}
        value={parent || null}
        onChange={(v) => setParent(v ?? "")}
        clearable
        searchable
        placeholder="(no parent)"
        data-testid="req-wizard-parent"
      />
    </WizardShell>
  );
}

function NewTestCaseWizard({
  existingIds,
  requirements,
  onCreate,
  onCancel,
}: {
  existingIds: Set<string>;
  requirements: readonly string[];
  onCreate: (text: string, id: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [verifies, setVerifies] = useState<string>(requirements[0] ?? "");
  const idErr = id ? validateId(id, existingIds) : null;
  const canCreate = !!id && !idErr && !!verifies;

  const submit = (): void => {
    if (!canCreate) return;
    const text = printTestCaseText({
      name: id.trim(),
      verifies,
      title: title || undefined,
      covers: [],
    });
    onCreate(text, id.trim());
  };

  return (
    <WizardShell
      title="New test case"
      testid="req-wizard-testcase"
      canCreate={canCreate}
      onCreate={submit}
      onCancel={onCancel}
    >
      <TextInput
        label="ID"
        description="e.g. TC-001"
        value={id}
        onChange={(e) => setId(e.currentTarget.value)}
        error={idErr ?? undefined}
        autoFocus
        data-testid="req-wizard-id"
      />
      <Select
        label="Verifies (requirement)"
        data={requirements}
        value={verifies || null}
        onChange={(v) => v && setVerifies(v)}
        allowDeselect={false}
        searchable
        data-testid="req-wizard-verifies"
      />
      <TextInput
        label="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        data-testid="req-wizard-title"
      />
      <Text size="xs" c="dimmed">
        Add covered code symbols in the next step (after Create, the test case opens in
        the edit form).
      </Text>
    </WizardShell>
  );
}

function NewSolutionWizard({
  existingIds,
  requirements,
  onCreate,
  onCancel,
}: {
  existingIds: Set<string>;
  requirements: readonly string[];
  onCreate: (text: string, id: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [forReq, setForReq] = useState<string>(requirements[0] ?? "");
  const idErr = id ? validateId(id, existingIds) : null;
  const canCreate = !!id && !idErr && !!forReq;

  const submit = (): void => {
    if (!canCreate) return;
    const text = printSolutionText({
      name: id.trim(),
      forRequirement: forReq,
      title: title || undefined,
      entitles: [],
    });
    onCreate(text, id.trim());
  };

  return (
    <WizardShell
      title="New solution"
      testid="req-wizard-solution"
      canCreate={canCreate}
      onCreate={submit}
      onCancel={onCancel}
    >
      <TextInput
        label="ID"
        description="e.g. SOL-001"
        value={id}
        onChange={(e) => setId(e.currentTarget.value)}
        error={idErr ?? undefined}
        autoFocus
        data-testid="req-wizard-id"
      />
      <Select
        label="For (requirement)"
        data={requirements}
        value={forReq || null}
        onChange={(v) => v && setForReq(v)}
        allowDeselect={false}
        searchable
        data-testid="req-wizard-for"
      />
      <TextInput
        label="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        data-testid="req-wizard-title"
      />
      <Text size="xs" c="dimmed">
        Add entitled code symbols in the next step (after Create, the solution opens in
        the edit form).
      </Text>
    </WizardShell>
  );
}
