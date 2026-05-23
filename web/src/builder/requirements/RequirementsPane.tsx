// Requirements pane — read-only browse of the file's traceability artifacts.
//
// A view of the same `.ddd` source as Source / Builder / Model: parses the
// AST and shows the requirement hierarchy + per-requirement detail (its
// solutions, test cases, and the code symbols they touch).  Useful for
// reviewing the traceability graph without scrolling through text — and the
// first step toward inline editing (Phase 2 will splice scalar edits via the
// CST edit engine; Phase 3 adds an autocomplete picker for entitles/covers).

import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Code,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { AstUtils } from "langium";
import type { LayoutCtx } from "../../layout/ctx";
import { parseDdd } from "../parse";
import {
  isRequirement,
  isSolution,
  isTestCase,
  type Requirement,
  type Solution,
  type TestCase,
} from "../../../../src/language/generated/ast.js";

interface CollectedTrace {
  requirements: Requirement[];
  solutions: Solution[];
  testCases: TestCase[];
  /** Requirement id → child ids (direct only). */
  childrenOf: Record<string, string[]>;
  /** Requirement id → ids of solutions whose `for` points at it. */
  solutionsFor: Record<string, string[]>;
  /** Requirement id → ids of testCases whose `verifies` points at it
   *  OR points at one of its (transitive) children. */
  testCasesByRequirement: Record<string, string[]>;
}

function collect(ast: unknown): CollectedTrace {
  const requirements: Requirement[] = [];
  const solutions: Solution[] = [];
  const testCases: TestCase[] = [];
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (isRequirement(node)) requirements.push(node);
    else if (isSolution(node)) solutions.push(node);
    else if (isTestCase(node)) testCases.push(node);
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

  // testCases verifying a requirement OR one of its transitive children.
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

  return { requirements, solutions, testCases, childrenOf, solutionsFor, testCasesByRequirement };
}

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

type Selection =
  | { kind: "requirement"; id: string }
  | { kind: "testCase"; id: string }
  | { kind: "solution"; id: string };

export default function RequirementsPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx]);
  const trace = useMemo(() => collect(parsed.ast), [parsed]);
  const [selected, setSelected] = useState<Selection | null>(null);

  if (parsed.parserErrors.length > 0) {
    return (
      <Box p="md">
        <Text size="sm" c="dimmed">
          Source has syntax errors — fix them in the editor to see the requirements view.
        </Text>
      </Box>
    );
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

  return (
    <Box style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }} data-testid="requirements-pane">
      {/* Tree (left) */}
      <Box
        style={{
          width: 320,
          borderRight: "1px solid var(--mantine-color-dark-4)",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ScrollArea style={{ flex: 1 }}>
          <Box p="sm">
            <SectionHeader label="Requirements" count={trace.requirements.length} />
            <Stack gap={2}>
              {roots.flatMap((r) =>
                renderReqRow(r.name, 0, reqById, trace, selected, setSelected),
              )}
            </Stack>
            <Divider my="sm" />
            <SectionHeader label="Test cases" count={trace.testCases.length} />
            <Stack gap={2}>
              {trace.testCases.map((t) => (
                <Row
                  key={t.name}
                  testid={`req-row-tc-${t.name}`}
                  active={selected?.kind === "testCase" && selected.id === t.name}
                  onClick={() => setSelected({ kind: "testCase", id: t.name })}
                >
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={500}>{t.name}</Text>
                    <Text size="sm" c="dimmed" truncate>{t.title ?? ""}</Text>
                  </Group>
                </Row>
              ))}
            </Stack>
            {trace.solutions.length > 0 && (
              <>
                <Divider my="sm" />
                <SectionHeader label="Solutions" count={trace.solutions.length} />
                <Stack gap={2}>
                  {trace.solutions.map((s) => (
                    <Row
                      key={s.name}
                      testid={`req-row-sol-${s.name}`}
                      active={selected?.kind === "solution" && selected.id === s.name}
                      onClick={() => setSelected({ kind: "solution", id: s.name })}
                    >
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" fw={500}>{s.name}</Text>
                        <Text size="sm" c="dimmed" truncate>{s.title ?? ""}</Text>
                      </Group>
                    </Row>
                  ))}
                </Stack>
              </>
            )}
          </Box>
        </ScrollArea>
      </Box>

      {/* Detail (right) */}
      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ScrollArea style={{ flex: 1 }}>
          <Box p="md">
            {selected === null && (
              <Text size="sm" c="dimmed">
                Pick a requirement, test case, or solution on the left to see its details.
              </Text>
            )}
            {selected?.kind === "requirement" && (
              <RequirementDetail
                req={reqById.get(selected.id)}
                trace={trace}
                reqById={reqById}
                tcById={tcById}
                solById={solById}
                onSelect={setSelected}
              />
            )}
            {selected?.kind === "testCase" && (
              <TestCaseDetail
                tc={tcById.get(selected.id)}
                onSelect={setSelected}
              />
            )}
            {selected?.kind === "solution" && (
              <SolutionDetail sol={solById.get(selected.id)} onSelect={setSelected} />
            )}
          </Box>
        </ScrollArea>
      </Box>
    </Box>
  );
}

function renderReqRow(
  id: string,
  depth: number,
  reqById: Map<string, Requirement>,
  trace: CollectedTrace,
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
        <Text size="sm" fw={500}>{r.name}</Text>
        <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
          {title ?? ""}
        </Text>
        {status && (
          <Badge size="xs" color={STATUS_COLOR[status] ?? "gray"} variant="outline">
            {status}
          </Badge>
        )}
        <Badge
          size="xs"
          color={tcCount > 0 ? "green" : "gray"}
          variant="light"
          title={`${tcCount} test case${tcCount === 1 ? "" : "s"}`}
        >
          {tcCount} TC
        </Badge>
        {!hasSolution && type === "UserStory" && (
          <Badge size="xs" color="orange" variant="light" title="No solution declared">
            no sol
          </Badge>
        )}
      </Group>
    </Row>
  );
  const kids = (trace.childrenOf[id] ?? []).flatMap((c) =>
    renderReqRow(c, depth + 1, reqById, trace, selected, setSelected),
  );
  return [here, ...kids];
}

function SectionHeader({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <Group justify="space-between" mb={6}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="xs" c="dimmed">{count}</Text>
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

function RequirementDetail({
  req,
  trace,
  reqById,
  tcById,
  solById,
  onSelect,
}: {
  req: Requirement | undefined;
  trace: CollectedTrace;
  reqById: Map<string, Requirement>;
  tcById: Map<string, TestCase>;
  solById: Map<string, Solution>;
  onSelect: (s: Selection) => void;
}): JSX.Element | null {
  if (!req) return null;
  const type = reqProp(req, "type") as string | undefined;
  const title = reqProp(req, "title") as string | undefined;
  const status = reqProp(req, "status") as string | undefined;
  const priority = reqProp(req, "priority") as number | undefined;
  const parentId = req.parent?.ref?.name;
  const solIds = trace.solutionsFor[req.name] ?? [];
  const tcIds = trace.testCasesByRequirement[req.name] ?? [];

  return (
    <Stack gap="sm" data-testid={`req-detail-${req.name}`}>
      <Group gap={8} wrap="nowrap">
        <Title order={4}>{req.name}</Title>
        {type && (
          <Badge color={REQUIREMENT_TYPE_COLOR[type] ?? "gray"} variant="light">
            {type}
          </Badge>
        )}
        {status && (
          <Badge color={STATUS_COLOR[status] ?? "gray"} variant="outline">
            {status}
          </Badge>
        )}
      </Group>
      {title && <Text size="md">{title}</Text>}
      <Group gap="lg">
        {priority !== undefined && (
          <Field label="Priority" value={String(priority)} />
        )}
        {parentId && (
          <Field
            label="Parent"
            value={
              <Link onClick={() => onSelect({ kind: "requirement", id: parentId })}>
                {parentId}
              </Link>
            }
          />
        )}
      </Group>

      <Divider my={4} label="Solutions" labelPosition="left" />
      {solIds.length === 0 ? (
        <Text size="sm" c="dimmed">No solution declared for this requirement.</Text>
      ) : (
        <Stack gap={4}>
          {solIds.map((id) => {
            const s = solById.get(id);
            return (
              <Group key={id} gap={6}>
                <Link onClick={() => onSelect({ kind: "solution", id })}>{id}</Link>
                <Text size="sm" c="dimmed">{s?.title ?? ""}</Text>
              </Group>
            );
          })}
        </Stack>
      )}

      <Divider my={4} label="Test cases (incl. children)" labelPosition="left" />
      {tcIds.length === 0 ? (
        <Text size="sm" c="dimmed">No test cases verify this requirement (or its children) yet.</Text>
      ) : (
        <Stack gap={4}>
          {tcIds.map((id) => {
            const tc = tcById.get(id);
            const verifies = tc?.requirement?.ref?.name;
            const inherited = verifies && verifies !== req.name;
            return (
              <Group key={id} gap={6}>
                <Link onClick={() => onSelect({ kind: "testCase", id })}>{id}</Link>
                <Text size="sm" c="dimmed">{tc?.title ?? ""}</Text>
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
              const child = reqById.get(id);
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

function TestCaseDetail({
  tc,
  onSelect,
}: {
  tc: TestCase | undefined;
  onSelect: (s: Selection) => void;
}): JSX.Element | null {
  if (!tc) return null;
  const covers = tc.covers.map((r) => r.$refText);
  const verifies = tc.requirement?.ref?.name;
  return (
    <Stack gap="sm" data-testid={`tc-detail-${tc.name}`}>
      <Title order={4}>{tc.name}</Title>
      {tc.title && <Text size="md">{tc.title}</Text>}
      {verifies && (
        <Field
          label="Verifies"
          value={<Link onClick={() => onSelect({ kind: "requirement", id: verifies })}>{verifies}</Link>}
        />
      )}
      <Divider my={4} label="Covers" labelPosition="left" />
      {covers.length === 0 ? (
        <Text size="sm" c="dimmed">No code symbols covered.</Text>
      ) : (
        <Stack gap={2}>
          {covers.map((qn) => (
            <Code key={qn}>{qn}</Code>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function SolutionDetail({
  sol,
  onSelect,
}: {
  sol: Solution | undefined;
  onSelect: (s: Selection) => void;
}): JSX.Element | null {
  if (!sol) return null;
  const entitles = sol.entitles.map((r) => r.$refText);
  const target = sol.requirement?.ref?.name;
  return (
    <Stack gap="sm" data-testid={`sol-detail-${sol.name}`}>
      <Title order={4}>{sol.name}</Title>
      {sol.title && <Text size="md">{sol.title}</Text>}
      {target && (
        <Field
          label="For"
          value={<Link onClick={() => onSelect({ kind: "requirement", id: target })}>{target}</Link>}
        />
      )}
      <Divider my={4} label="Entitles" labelPosition="left" />
      {entitles.length === 0 ? (
        <Text size="sm" c="dimmed">No code symbols entitled.</Text>
      ) : (
        <Stack gap={2}>
          {entitles.map((qn) => (
            <Code key={qn}>{qn}</Code>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <Group gap={6}>
      <Text size="sm" c="dimmed">{label}:</Text>
      {typeof value === "string" ? <Text size="sm">{value}</Text> : value}
    </Group>
  );
}

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
