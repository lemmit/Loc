// Per-view "+" palette: a tiny toolbar above the React Flow that exposes the
// adds that make sense at the current drill level, reusing v1's pure
// `addConstructSource` / `addSubdomainSource` (so the same parse-guarded edits
// the v1 inspector produces).
//
// System and context views reuse the levels v1's add.ts already handles
// directly; subdomain-level "+ Context", aggregate-level "+ Operation" and
// operation-level "+ Stmt" come from the v2-only helpers next to it.
//
// The kinds the v2 graph renders beyond v1's `NodeKind` union get their adds
// from the sibling `SystemExtraKind` / `ContextExtraKind` menus below.  Several
// of those templates need a mandatory cross-reference target (a `channel`
// carries an event, a `resource` uses a storage, …) and return null when the
// model has none.  Such an entry renders DISABLED with the reason as its
// tooltip (`add-palette-blockers.ts`), and every add that still returns null
// goes to the pane's named `applyOrRefuse`, so the refusal line says which
// entry failed — nothing here no-ops silently (M-T8.17, audit H10).

import { Button, Group, Text, Tooltip } from "@mantine/core";
import {
  addConstructSource,
  addSubdomainSource,
  addSystemExtraSource,
  type SystemExtraKind,
} from "../system/add";
import { addStatement, aggregateBody, type BodyKey, type BodyLocator } from "../system/body";
import { addField, freshFieldName } from "../system/fields";
import { findAggregate, type ViewPath } from "./view-graph";
import {
  addContextExtraSource,
  addContextSource,
  addOperationSource,
  addPermissionsSource,
  type ContextExtraKind,
} from "./add-extra";
import { parseDdd } from "../parse";
import { paletteBlockers } from "./add-palette-blockers";

interface Props {
  path: ViewPath;
  source: string;
  /** Hand a candidate to the pane, NAMED after the entry that produced it
   *  (`what` is the button label, e.g. "+ Repository"); null is a refusal. */
  onAdd: (what: string, next: string | null) => void;
  /** Selected member of the WORKFLOW at the path leaf; undefined = its primary
   *  `create` starter. An aggregate's members each have a path step of their
   *  own (`operation` / `body`), so they need no override here. */
  bodyMember?: BodyKey;
}

/** System-scope extras, grouped read-model-ish first then infrastructure —
 *  same order the system view lays them out. */
const SYSTEM_EXTRAS: { kind: SystemExtraKind; label: string }[] = [
  { kind: "resource", label: "+ Resource" },
  { kind: "channelSource", label: "+ Channel source" },
  { kind: "timerSource", label: "+ Timer source" },
  { kind: "capability", label: "+ Capability" },
];

/** Context-scope extras, grouped by family so the row reads as three clusters:
 *  read models / behaviour, vocabulary, then predicates + authz. */
const CONTEXT_EXTRAS: { kind: ContextExtraKind; label: string }[] = [
  { kind: "projection", label: "+ Projection" },
  { kind: "domainService", label: "+ Domain service" },
  { kind: "channel", label: "+ Channel" },
  { kind: "payload", label: "+ Payload" },
  { kind: "enum", label: "+ Enum" },
  { kind: "criterion", label: "+ Criterion" },
  { kind: "retrieval", label: "+ Retrieval" },
  { kind: "policy", label: "+ Policy" },
];

const ROW_STYLE = { borderBottom: "1px solid var(--loom-border)" } as const;

/** One palette button.  A blocked entry is disabled with the reason on a
 *  Tooltip around a WRAPPER span — a disabled button emits no pointer events,
 *  so a tooltip on the button itself would never open. */
function Entry({
  label,
  testid,
  variant,
  blocked,
  onClick,
}: {
  label: string;
  testid: string;
  variant: "light" | "default";
  blocked?: string;
  onClick: () => void;
}): JSX.Element {
  const button = (
    <Button size="compact-xs" variant={variant} data-testid={testid} disabled={blocked !== undefined} onClick={onClick}>
      {label}
    </Button>
  );
  if (blocked === undefined) return button;
  return (
    <Tooltip label={blocked} withArrow multiline w={260} openDelay={200}>
      <span data-testid={`${testid}-blocked`} title={blocked} style={{ display: "inline-block" }}>
        {button}
      </span>
    </Tooltip>
  );
}

export default function AddPalette({ path, source, onAdd, bodyMember }: Props): JSX.Element | null {
  const last = path[path.length - 1];

  if (!last) return null;

  const ast = parseDdd(source).ast;
  const blockers = paletteBlockers(ast, path);

  if (last.kind === "system") {
    return (
      <Group gap={4} px={6} py={4} bg="var(--loom-bg-raised)" wrap="wrap" style={ROW_STYLE} data-testid="c4system-v2-add-palette">
        <Entry label="+ Subdomain" variant="light" testid="c4system-v2-add-subdomain"
          onClick={() => onAdd("+ Subdomain", addSubdomainSource(source))} />
        <Entry label="+ API" variant="default" testid="c4system-v2-add-api" blocked={blockers.get("api")}
          onClick={() => onAdd("+ API", addConstructSource(source, "api"))} />
        <Entry label="+ Storage" variant="default" testid="c4system-v2-add-storage"
          onClick={() => onAdd("+ Storage", addConstructSource(source, "storage"))} />
        <Entry label="+ UI" variant="default" testid="c4system-v2-add-ui"
          onClick={() => onAdd("+ UI", addConstructSource(source, "ui"))} />
        <Entry label="+ Deployable" variant="default" testid="c4system-v2-add-deployable"
          onClick={() => onAdd("+ Deployable", addConstructSource(source, "deployable"))} />
        <Text size="xs" c="dimmed" mx={2}>|</Text>
        {SYSTEM_EXTRAS.map((e) => (
          <Entry key={e.kind} label={e.label} variant="default" testid={`c4system-v2-add-${e.kind}`} blocked={blockers.get(e.kind)}
            onClick={() => onAdd(e.label, addSystemExtraSource(source, e.kind))} />
        ))}
      </Group>
    );
  }

  if (last.kind === "subdomain") {
    return (
      <Group gap={4} px={6} py={4} bg="var(--loom-bg-raised)" wrap="wrap" style={ROW_STYLE} data-testid="c4system-v2-add-palette">
        <Entry label="+ Context" variant="light" testid="c4system-v2-add-context"
          onClick={() => onAdd("+ Context", addContextSource(source, last.name))} />
        <Entry label="+ Permissions" variant="default" testid="c4system-v2-add-permissions"
          onClick={() => onAdd("+ Permissions", addPermissionsSource(source, last.name))} />
      </Group>
    );
  }

  if (last.kind === "aggregate") {
    return (
      <Group gap={4} px={6} py={4} bg="var(--loom-bg-raised)" wrap="wrap" style={ROW_STYLE} data-testid="c4system-v2-add-palette">
        <Entry label="+ Operation" variant="light" testid="c4system-v2-add-operation"
          onClick={() => onAdd("+ Operation", addOperationSource(source, last.name))} />
        <Entry label="+ Field" variant="light" testid="c4system-v2-add-field"
          onClick={() => {
            // Add a `: string` field with a fresh name to the named aggregate.
            const agg = findAggregate(ast, last.name);
            onAdd(
              "+ Field",
              agg
                ? addField(source, "aggregate", last.name, freshFieldName(agg), {
                    base: { kind: "primitive", name: "string" },
                    array: false,
                    optional: false,
                  })
                : null,
            );
          }} />
      </Group>
    );
  }

  if (last.kind === "operation" || last.kind === "workflow" || last.kind === "body") {
    const loc: BodyLocator =
      last.kind === "workflow"
        ? { kind: "workflow", name: last.name, member: bodyMember }
        : (() => {
            const agg = path[path.length - 2];
            // A `body` step carries the aggregate's `listBodies` key, which
            // reaches its create / destroy / apply bodies; an `operation` step
            // names the operation, the shape this locator has always had.
            return last.kind === "body"
              ? aggregateBody(agg?.name ?? "", last.name)
              : { kind: "operation", aggregate: agg?.name ?? "", op: last.name };
          })();
    return (
      <Group gap={4} px={6} py={4} bg="var(--loom-bg-raised)" wrap="wrap" style={ROW_STYLE} data-testid="c4system-v2-add-palette">
        <Entry label="+ Stmt" variant="light" testid="c4system-v2-add-stmt"
          onClick={() => onAdd("+ Stmt", addStatement(source, loc, "precondition true"))} />
      </Group>
    );
  }

  if (last.kind === "context") {
    const ctxName = last.name;
    return (
      <Group gap={4} px={6} py={4} bg="var(--loom-bg-raised)" wrap="wrap" style={ROW_STYLE} data-testid="c4system-v2-add-palette">
        <Entry label="+ Aggregate" variant="light" testid="c4system-v2-add-aggregate"
          onClick={() => onAdd("+ Aggregate", addConstructSource(source, "aggregate", { context: ctxName }))} />
        <Entry label="+ Value object" variant="light" testid="c4system-v2-add-valueobject"
          onClick={() => onAdd("+ Value object", addConstructSource(source, "valueobject", { context: ctxName }))} />
        <Entry label="+ Event" variant="light" testid="c4system-v2-add-event"
          onClick={() => onAdd("+ Event", addConstructSource(source, "event", { context: ctxName }))} />
        <Entry label="+ Workflow" variant="light" testid="c4system-v2-add-workflow"
          onClick={() => onAdd("+ Workflow", addConstructSource(source, "workflow", { context: ctxName }))} />
        <Entry label="+ Repository" variant="light" testid="c4system-v2-add-repository" blocked={blockers.get("repository")}
          onClick={() => onAdd("+ Repository", addConstructSource(source, "repository", { context: ctxName }))} />
        <Text size="xs" c="dimmed" mx={2}>|</Text>
        {CONTEXT_EXTRAS.map((e) => (
          <Entry key={e.kind} label={e.label} variant="default" testid={`c4system-v2-add-${e.kind}`} blocked={blockers.get(e.kind)}
            onClick={() => onAdd(e.label, addContextExtraSource(source, ctxName, e.kind))} />
        ))}
      </Group>
    );
  }

  return null;
}
