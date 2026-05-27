import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Image,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import { TsTransformClient } from "../testing/transform-client";
import { findApiTestFile, loadApiTests } from "../testing/run-api-tests";
import { findUiTestFile, loadUiSuite, uiSuiteFiles } from "../testing/run-ui-tests";
import {
  findUnitTestFiles,
  loadUnitSuite,
  unitSuiteFiles,
} from "../testing/run-unit-tests";
import {
  makePostMessageTransport,
  RemotePage,
} from "../../../packages/ui-test-driver/index";
import { getActiveDriverPort } from "../preview/active-driver-port";
import { runTests, type TestCase, type TestResult } from "../testing/harness";
import { runUiTests, type UiTestCase } from "../testing/ui-harness";
import { computeVerification } from "../../../src/verify/verification.js";
import type {
  ExecTestRef,
  RequirementVerdict,
  TestOutcome,
  VerificationIR,
} from "../../../src/ir/types/loom-ir.js";

// Shape of the `.loom/traceability.json` slice the verification overlay
// reads — emitted by `src/system/traceability.ts`.
interface TraceabilityJson {
  requirements: { id: string; title: string; type: string; parentId?: string }[];
  testCases: { id: string; verifies: string }[];
  index: {
    testsByRequirement: Record<string, string[]>;
    childrenOf: Record<string, string[]>;
    execTests: ExecTestRef[];
  };
}

const VERDICT_COLOR: Record<RequirementVerdict, string> = {
  VERIFIED: "green",
  FAILING: "red",
  UNTESTED: "gray",
  UNVERIFIED: "yellow",
};

const ALL = "\0all";
const key = (group: string, name: string): string => `${group}\0${name}`;

interface UnitSuite {
  id: string;
  label: string;
  cases: TestCase[];
}

// "Tests" dock tab — discovers the generated `test e2e` and aggregate
// `test` suites (registering them lists the cases without running the
// bodies) and runs each test, or a whole suite, individually.
//   - unit (aggregate `test`): pure in-process domain tests — runnable
//     straight after Generate, no Boot.
//   - api (`against <backend>`): hit the runtime dispatch — need Boot.
//   - ui  (`against <react>`):  drive the preview iframe — need Boot.
export function TestsBody({
  ctx,
  active = true,
}: {
  ctx: LayoutCtx;
  /** Whether this panel is the visible tab.  Mobile keeps all panels
   *  mounted, so gate the (esbuild-driven) discovery on visibility to
   *  avoid building suites in the background on a phone.  Desktop only
   *  mounts the panel when its tab is active, so the default suffices. */
  active?: boolean;
}): JSX.Element {
  const { engine, ddl, generateSuccess } = ctx;
  const files = generateSuccess?.files ?? [];
  const apiFile = useMemo(() => findApiTestFile(files), [generateSuccess]);
  const uiFile = useMemo(() => findUiTestFile(files), [generateSuccess]);

  // Traceability index (if the source declares requirements) drives the
  // live Definition-of-Done overlay below.
  const traceability = useMemo<TraceabilityJson | null>(() => {
    const f = files.find((x) => x.path === ".loom/traceability.json");
    if (!f) return null;
    try {
      return JSON.parse(f.content) as TraceabilityJson;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateSuccess]);
  const unitFiles = useMemo(() => findUnitTestFiles(files), [generateSuccess]);

  const clientRef = useRef<TsTransformClient | null>(null);
  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);
  const client = (): TsTransformClient =>
    (clientRef.current ??= new TsTransformClient());

  const [unitSuites, setUnitSuites] = useState<UnitSuite[] | null>(null);
  const [apiCases, setApiCases] = useState<TestCase[] | null>(null);
  const [uiCases, setUiCases] = useState<UiTestCase[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { testResults: results, setTestResults: setResults } = ctx;

  // Drop stale results when the generated output actually changes (a
  // re-Generate likely renames or removes tests).  Crucially this does
  // NOT fire when the panel merely remounts after a dock-tab switch —
  // the lifted `ctx.testResults` would otherwise be wiped on every
  // round trip.  `prevGen` starts unset so the very first run after
  // mount doesn't clear what's already there.
  const prevGenRef = useRef<typeof generateSuccess | undefined>(undefined);
  useEffect(() => {
    if (prevGenRef.current !== undefined && prevGenRef.current !== generateSuccess) {
      setResults({});
    }
    prevGenRef.current = generateSuccess;
    // setResults is referentially stable in the App; tracking only
    // generateSuccess keeps the clear gate tight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateSuccess]);
  const [running, setRunning] = useState<string | null>(null);

  const hasAny = unitFiles.length > 0 || !!apiFile || !!uiFile;
  const hasProofs = Object.values(results).some((r) => r.screenshot);

  // Live Definition-of-Done overlay: join the current results onto the
  // requirements graph.  Recomputes as tests run (depends on `results`).
  const verification = useMemo<VerificationIR | null>(() => {
    if (!traceability) return null;
    const outcomes: TestOutcome[] = Object.values(results).map((r) => ({
      name: r.name,
      suite: r.suite,
      status: r.status,
    }));
    return computeVerification(
      traceability.index,
      traceability.requirements.map((r) => r.id),
      outcomes,
    );
  }, [traceability, results]);

  useEffect(() => {
    if (!active) return;
    if (!hasAny) {
      setUnitSuites(null);
      setApiCases(null);
      setUiCases(null);
      return;
    }
    let cancelled = false;
    setDiscovering(true);
    setError(null);
    void (async () => {
      try {
        const c = client();
        const build = (e: string, f: Record<string, string>, a: Record<string, string>) =>
          c.build(e, f, a);
        const units: UnitSuite[] = [];
        for (const f of unitFiles) {
          const cases = await loadUnitSuite({
            entry: f.path,
            files: unitSuiteFiles(files, f),
            build,
          });
          const base = f.path.split("/").pop()!.replace(/\.test\.ts$/, "");
          units.push({ id: `unit\0${f.path}`, label: base, cases });
        }
        const ui = uiFile
          ? await loadUiSuite({ entry: uiFile.path, files: uiSuiteFiles(files, uiFile), build })
          : null;
        const api = apiFile && engine
          ? await loadApiTests({
              source: apiFile.content,
              compile: (ts) => c.compile(ts),
              dispatch: (req) => engine.dispatch(req),
            })
          : null;
        if (cancelled) return;
        setUnitSuites(units);
        setUiCases(ui);
        setApiCases(api);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDiscovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateSuccess, engine, active]);

  const merge = (group: string, res: TestResult[]): void => {
    setResults((prev) => {
      const next = { ...prev };
      for (const r of res) next[key(group, r.name)] = r;
      return next;
    });
  };

  const guard = async (busyKey: string, fn: () => Promise<void>): Promise<void> => {
    if (running) return;
    setRunning(busyKey);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const runUnit = (suite: UnitSuite, cases: TestCase[], busyKey: string): void => {
    // Pure in-process — no DB, no boot, no reset.
    void guard(busyKey, async () => merge(suite.id, await runTests(cases)));
  };
  const runApi = (cases: TestCase[], busyKey: string): void => {
    void guard(busyKey, async () => {
      if (engine) await engine.wipe();
      merge("api", await runTests(cases));
    });
  };
  const runUi = (cases: UiTestCase[], busyKey: string): void => {
    void guard(busyKey, async () => {
      const port = getActiveDriverPort();
      if (!port) {
        throw new Error("Preview isn't booted — Bundle + Boot first.");
      }
      if (engine) await engine.wipe();
      const page = new RemotePage(
        makePostMessageTransport(port, { timeout: 8000 }),
      );
      // Report the UI suite name so results join the verification rollup
      // (UI ExecTestRefs carry `suite: "<System> e2e"`).
      const uiSuite =
        traceability?.index.execTests.find((t) => t.kind === "ui")?.suite ?? "";
      merge("ui", await runUiTests(cases, page, uiSuite, ctx.getAppLog));
    });
  };

  if (!hasAny) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        This system declares no <Code>test</Code> blocks. Add some (and
        Generate) to run them here.
      </Text>
    );
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {discovering && (
        <Group gap="xs" px="sm" py={6}>
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Discovering tests…
          </Text>
        </Group>
      )}
      {error && (
        <Code block c="red" m="sm" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="test-error">
          {error}
        </Code>
      )}
      {hasProofs && (
        <Group px="sm" py={6} justify="flex-end">
          <Button
            size="compact-xs"
            variant="light"
            onClick={() =>
              downloadProofReport(traceability, verification, results)
            }
            data-testid="btn-download-proofs"
          >
            Download proofs
          </Button>
        </Group>
      )}
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box px="sm" pb="sm">
          {traceability && verification && (
            <RequirementsRollup
              traceability={traceability}
              verification={verification}
              results={results}
            />
          )}
          {(unitSuites ?? []).map((s) => (
            <Suite
              key={s.id}
              testid={`unit-${s.label}`}
              label={`Unit — ${s.label}`}
              cases={s.cases.map((c) => c.name)}
              group={s.id}
              results={results}
              running={running}
              disabled={running !== null}
              onRunAll={() => runUnit(s, s.cases, key(s.id, ALL))}
              onRunOne={(name) => {
                const c = s.cases.find((t) => t.name === name);
                if (c) runUnit(s, [c], key(s.id, name));
              }}
            />
          ))}
          {apiCases && (
            <Suite
              testid="api"
              label="API tests"
              hint={!ddl ? "Boot the backend to run" : undefined}
              cases={apiCases.map((c) => c.name)}
              group="api"
              results={results}
              running={running}
              disabled={!ddl || running !== null}
              onRunAll={() => runApi(apiCases, key("api", ALL))}
              onRunOne={(name) => {
                const c = apiCases.find((t) => t.name === name);
                if (c) runApi([c], key("api", name));
              }}
            />
          )}
          {uiCases && (
            <Suite
              testid="ui"
              label="UI tests"
              hint={!ddl ? "Boot the backend to run" : undefined}
              cases={uiCases.map((c) => c.name)}
              group="ui"
              results={results}
              running={running}
              disabled={!ddl || running !== null}
              onRunAll={() => runUi(uiCases, key("ui", ALL))}
              onRunOne={(name) => {
                const c = uiCases.find((t) => t.name === name);
                if (c) runUi([c], key("ui", name));
              }}
            />
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}

// Clickable screenshot thumbnail that enlarges in a modal — the proof /
// debugging artifact for a UI test.
function ProofImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Image
        src={src}
        alt={alt}
        h={64}
        w="auto"
        radius="sm"
        fit="contain"
        onClick={() => setOpen(true)}
        data-testid="test-screenshot"
        style={{
          cursor: "zoom-in",
          border: "1px solid var(--mantine-color-gray-3)",
        }}
      />
      <Modal opened={open} onClose={() => setOpen(false)} size="xl" centered title={alt}>
        <Image src={src} alt={alt} fit="contain" />
      </Modal>
    </>
  );
}

// Live Definition-of-Done overlay — each requirement's verdict rolled
// up from the test results, indented by the requirement hierarchy.  Leaf
// requirements also show the screenshot proofs from the UI tests whose
// testCases verify them.
function RequirementsRollup({
  traceability,
  verification,
  results,
}: {
  traceability: TraceabilityJson;
  verification: VerificationIR;
  results: Record<string, TestResult>;
}): JSX.Element {
  const { requirements, testCases, index } = traceability;
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const roots = requirements.filter((r) => !r.parentId);
  const s = verification.summary;

  // UI-test screenshot proofs for the testCases that directly verify a
  // requirement (matched back through `execTests` by suite+name).
  const proofsFor = (reqId: string): { name: string; src: string }[] => {
    const tcIds = new Set(
      (testCases ?? []).filter((tc) => tc.verifies === reqId).map((tc) => tc.id),
    );
    const out: { name: string; src: string }[] = [];
    for (const ex of index.execTests) {
      if (ex.kind !== "ui" || ex.testCaseId == null || !tcIds.has(ex.testCaseId)) {
        continue;
      }
      const src = results[key("ui", ex.name)]?.screenshot;
      if (src) out.push({ name: ex.name, src });
    }
    return out;
  };

  const renderReq = (id: string, depth: number): JSX.Element[] => {
    const r = byId.get(id);
    if (!r) return [];
    const verdict = verification.requirements[id]?.verdict ?? "UNTESTED";
    const proofs = proofsFor(id);
    const here = (
      <Group
        key={id}
        gap="xs"
        wrap="nowrap"
        style={{ paddingLeft: depth * 16 }}
        data-testid={`req-${r.id}`}
      >
        <Badge size="xs" color={VERDICT_COLOR[verdict]} variant="light" data-testid={`req-verdict-${r.id}`}>
          {verdict}
        </Badge>
        <Text size="sm" fw={500}>{r.id}</Text>
        <Text size="sm" c="dimmed" truncate>{r.title}</Text>
      </Group>
    );
    const proofRow =
      proofs.length > 0 ? (
        <Group
          key={`${id}-proofs`}
          gap={6}
          wrap="wrap"
          style={{ paddingLeft: depth * 16 + 16 }}
          data-testid={`req-proofs-${r.id}`}
        >
          {proofs.map((p) => (
            <ProofImage key={p.name} src={p.src} alt={`${r.id}: ${p.name}`} />
          ))}
        </Group>
      ) : null;
    const kids = (index.childrenOf[id] ?? []).flatMap((c) => renderReq(c, depth + 1));
    return proofRow ? [here, proofRow, ...kids] : [here, ...kids];
  };

  return (
    <Box pb="sm" data-testid="requirements-rollup">
      <Group gap="xs" py={6} justify="space-between">
        <Text size="sm" fw={600}>Requirements</Text>
        <Group gap={6}>
          <Badge size="xs" color="green" variant="light">{s.verified} verified</Badge>
          {s.failing > 0 && <Badge size="xs" color="red" variant="light">{s.failing} failing</Badge>}
          {s.unverified > 0 && <Badge size="xs" color="yellow" variant="light">{s.unverified} unverified</Badge>}
          {s.untested > 0 && <Badge size="xs" color="gray" variant="light">{s.untested} untested</Badge>}
        </Group>
      </Group>
      <Stack gap={4}>{roots.flatMap((r) => renderReq(r.id, 0))}</Stack>
    </Box>
  );
}

function Suite({
  testid,
  label,
  hint,
  cases,
  group,
  results,
  running,
  disabled,
  onRunAll,
  onRunOne,
}: {
  testid: string;
  label: string;
  hint?: string;
  cases: string[];
  group: string;
  results: Record<string, TestResult>;
  running: string | null;
  disabled: boolean;
  onRunAll: () => void;
  onRunOne: (name: string) => void;
}): JSX.Element | null {
  if (cases.length === 0) return null;
  return (
    <Box mb="md" data-testid={`test-suite-${testid}`}>
      <Group gap="sm" mb={6}>
        <Text size="xs" fw={700} tt="uppercase">
          {label}
        </Text>
        <Button
          size="compact-xs"
          variant="light"
          disabled={disabled}
          loading={running === key(group, ALL)}
          onClick={onRunAll}
          data-testid={`btn-run-all-${testid}`}
        >
          Run all
        </Button>
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
      </Group>
      <Stack gap={4}>
        {cases.map((name) => {
          const r = results[key(group, name)];
          return (
            <Box key={name} data-testid="test-row">
              <Group gap={8} wrap="nowrap">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={disabled}
                  loading={running === key(group, name)}
                  onClick={() => onRunOne(name)}
                  data-testid="btn-run-one"
                >
                  Run
                </Button>
                <Badge
                  size="xs"
                  variant="light"
                  color={r == null ? "gray" : r.status === "pass" ? "green" : "red"}
                >
                  {r == null ? "—" : r.status}
                </Badge>
                <Text size="sm" style={{ flex: 1 }}>
                  {name}
                </Text>
                {r && (
                  <Text size="xs" c="dimmed">
                    {Math.round(r.durationMs)} ms
                  </Text>
                )}
              </Group>
              {r?.error && (
                <Code block c="red" mt={4} style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                  {r.error}
                </Code>
              )}
              {r?.logs && r.logs.length > 0 && (
                <Code
                  block
                  mt={4}
                  style={{ whiteSpace: "pre-wrap", fontSize: 11 }}
                  data-testid="test-console"
                >
                  {r.logs
                    .map((l) => (l.level === "log" ? l.text : `[${l.level}] ${l.text}`))
                    .join("\n")}
                </Code>
              )}
              {r?.screenshot && (
                <Box mt={4}>
                  <ProofImage src={r.screenshot} alt={name} />
                </Box>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

const escHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

// Build + download a single self-contained HTML proof report: the
// requirement rollup (verdict + the UI-test screenshots that prove each)
// and every UI test's final-state screenshot, with a machine-readable
// manifest embedded as a <script type="application/json">.  Data-URL
// images are inlined so the file is portable (attach to a PR, open
// offline).  No zip dependency.
function downloadProofReport(
  traceability: TraceabilityJson | null,
  verification: VerificationIR | null,
  results: Record<string, TestResult>,
): void {
  const sysName =
    traceability?.index.execTests.find((t) => t.suite)?.suite?.replace(/ e2e$/, "") ??
    "system";

  const proofsFor = (
    reqId: string,
  ): { testCaseId: string; name: string; src: string }[] => {
    if (!traceability) return [];
    const tcIds = new Set(
      (traceability.testCases ?? []).filter((tc) => tc.verifies === reqId).map((tc) => tc.id),
    );
    const out: { testCaseId: string; name: string; src: string }[] = [];
    for (const ex of traceability.index.execTests) {
      if (ex.kind !== "ui" || ex.testCaseId == null || !tcIds.has(ex.testCaseId)) continue;
      const src = results[key("ui", ex.name)]?.screenshot;
      if (src) out.push({ testCaseId: ex.testCaseId, name: ex.name, src });
    }
    return out;
  };

  const reqRows =
    traceability && verification
      ? traceability.requirements
          .map((r) => {
            const verdict = verification.requirements[r.id]?.verdict ?? "UNTESTED";
            const imgs = proofsFor(r.id)
              .map(
                (p) =>
                  `<figure><figcaption>${escHtml(p.name)}</figcaption><img src="${p.src}" alt="${escHtml(r.id)}"/></figure>`,
              )
              .join("");
            return `<section class="req"><h3><span class="v ${verdict}">${verdict}</span> ${escHtml(r.id)} — ${escHtml(r.title)}</h3>${imgs}</section>`;
          })
          .join("")
      : "";

  const logText = (r: TestResult): string =>
    (r.logs ?? [])
      .map((l) => (l.level === "log" ? l.text : `[${l.level}] ${l.text}`))
      .join("\n");

  const uiResults = Object.values(results).filter((r) => r.screenshot);
  const testRows = uiResults
    .map((r) => {
      const logs = logText(r);
      return `<section class="test"><h4>${escHtml(r.name)} <span class="v ${r.status === "pass" ? "VERIFIED" : "FAILING"}">${r.status}</span></h4>${r.error ? `<pre>${escHtml(r.error)}</pre>` : ""}${logs ? `<pre class="logs">${escHtml(logs)}</pre>` : ""}<img src="${r.screenshot}" alt="${escHtml(r.name)}"/></section>`;
    })
    .join("");

  const manifest = {
    system: sysName,
    generatedAt: new Date().toISOString(),
    requirements:
      traceability && verification
        ? traceability.requirements.map((r) => ({
            id: r.id,
            title: r.title,
            verdict: verification.requirements[r.id]?.verdict ?? "UNTESTED",
            proofs: proofsFor(r.id).map((p) => ({
              testCaseId: p.testCaseId,
              testName: p.name,
            })),
          }))
        : [],
    tests: uiResults.map((r) => ({
      suite: r.suite,
      name: r.name,
      status: r.status,
      logs: r.logs ?? [],
    })),
  };

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escHtml(sysName)} — test proofs</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; color: #1e293b; }
  h1 { font-size: 1.4rem; } h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
  .v { font-size: .7rem; padding: .1rem .4rem; border-radius: .3rem; color: #fff; }
  .VERIFIED { background: #16a34a; } .FAILING { background: #dc2626; }
  .UNTESTED { background: #64748b; } .UNVERIFIED { background: #ca8a04; }
  figure { display: inline-block; margin: .3rem .6rem .3rem 0; vertical-align: top; }
  figcaption { font-size: .7rem; color: #64748b; }
  img { max-width: 480px; border: 1px solid #cbd5e1; border-radius: .3rem; display: block; }
  pre { background: #f1f5f9; padding: .5rem; border-radius: .3rem; white-space: pre-wrap; font-size: 12px; }
</style></head><body>
<h1>${escHtml(sysName)} — test proofs</h1>
<p>Generated ${escHtml(manifest.generatedAt)}</p>
<h2>Requirements</h2>${reqRows || "<p>No requirements declared.</p>"}
<h2>UI test screenshots</h2>${testRows || "<p>No UI screenshots captured.</p>"}
<script type="application/json" id="loom-proofs">${JSON.stringify(manifest).replace(/</g, "\\u003c")}</script>
</body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sysName}-proofs.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
