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
// model has none — the button then no-ops, exactly as `+ Repository` /
// `+ API` already do when their target is missing.

import { Button, Group, Text } from "@mantine/core";
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

interface Props {
  path: ViewPath;
  source: string;
  onChange: (next: string) => void;
  /** Selected body member of the workflow / aggregate at the path leaf;
   *  undefined = the primary body (a workflow's `create`, an operation's own). */
  bodyMember?: BodyKey;
}

const try_ = (onChange: (next: string) => void, next: string | null): void => {
  if (next != null) onChange(next);
};

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

export default function AddPalette({ path, source, onChange, bodyMember }: Props): JSX.Element | null {
  const last = path[path.length - 1];

  if (!last) return null;

  if (last.kind === "system") {
    return (
      <Group gap={4} px={6} py={4} bg="dark.6" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-v2-add-palette">
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-subdomain"
          onClick={() => try_(onChange, addSubdomainSource(source))}>+ Subdomain</Button>
        <Button size="compact-xs" variant="default" data-testid="c4system-v2-add-api"
          onClick={() => try_(onChange, addConstructSource(source, "api"))}>+ API</Button>
        <Button size="compact-xs" variant="default" data-testid="c4system-v2-add-storage"
          onClick={() => try_(onChange, addConstructSource(source, "storage"))}>+ Storage</Button>
        <Button size="compact-xs" variant="default" data-testid="c4system-v2-add-ui"
          onClick={() => try_(onChange, addConstructSource(source, "ui"))}>+ UI</Button>
        <Button size="compact-xs" variant="default" data-testid="c4system-v2-add-deployable"
          onClick={() => try_(onChange, addConstructSource(source, "deployable"))}>+ Deployable</Button>
        <Text size="xs" c="dimmed" mx={2}>|</Text>
        {SYSTEM_EXTRAS.map((e) => (
          <Button key={e.kind} size="compact-xs" variant="default" data-testid={`c4system-v2-add-${e.kind}`}
            onClick={() => try_(onChange, addSystemExtraSource(source, e.kind))}>{e.label}</Button>
        ))}
      </Group>
    );
  }

  if (last.kind === "subdomain") {
    return (
      <Group gap={4} px={6} py={4} bg="dark.6" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-v2-add-palette">
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-context"
          onClick={() => try_(onChange, addContextSource(source, last.name))}>+ Context</Button>
        <Button size="compact-xs" variant="default" data-testid="c4system-v2-add-permissions"
          onClick={() => try_(onChange, addPermissionsSource(source, last.name))}>+ Permissions</Button>
      </Group>
    );
  }

  if (last.kind === "aggregate") {
    return (
      <Group gap={4} px={6} py={4} bg="dark.6" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-v2-add-palette">
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-operation"
          onClick={() => try_(onChange, addOperationSource(source, last.name))}>+ Operation</Button>
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-field"
          onClick={() => {
            // Add a `: string` field with a fresh name to the named aggregate.
            const agg = findAggregate(parseDdd(source).ast, last.name);
            if (!agg) return;
            try_(
              onChange,
              addField(source, "aggregate", last.name, freshFieldName(agg), {
                base: { kind: "primitive", name: "string" },
                array: false,
                optional: false,
              }),
            );
          }}>+ Field</Button>
      </Group>
    );
  }

  if (last.kind === "operation" || last.kind === "workflow") {
    const loc: BodyLocator =
      last.kind === "workflow"
        ? { kind: "workflow", name: last.name, member: bodyMember }
        : (() => {
            const agg = path[path.length - 2];
            // A selected member reaches the aggregate's create / destroy /
            // apply bodies; without one the locator names the operation, the
            // shape it has always had.
            return bodyMember
              ? aggregateBody(agg?.name ?? "", bodyMember)
              : { kind: "operation", aggregate: agg?.name ?? "", op: last.name };
          })();
    return (
      <Group gap={4} px={6} py={4} bg="dark.6" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-v2-add-palette">
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-stmt"
          onClick={() => try_(onChange, addStatement(source, loc, "precondition true"))}>+ Stmt</Button>
      </Group>
    );
  }

  if (last.kind === "context") {
    const ctxName = last.name;
    return (
      <Group gap={4} px={6} py={4} bg="dark.6" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-v2-add-palette">
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-aggregate"
          onClick={() => try_(onChange, addConstructSource(source, "aggregate", { context: ctxName }))}>+ Aggregate</Button>
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-valueobject"
          onClick={() => try_(onChange, addConstructSource(source, "valueobject", { context: ctxName }))}>+ Value object</Button>
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-event"
          onClick={() => try_(onChange, addConstructSource(source, "event", { context: ctxName }))}>+ Event</Button>
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-workflow"
          onClick={() => try_(onChange, addConstructSource(source, "workflow", { context: ctxName }))}>+ Workflow</Button>
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-repository"
          onClick={() => try_(onChange, addConstructSource(source, "repository", { context: ctxName }))}>+ Repository</Button>
        <Text size="xs" c="dimmed" mx={2}>|</Text>
        {CONTEXT_EXTRAS.map((e) => (
          <Button key={e.kind} size="compact-xs" variant="default" data-testid={`c4system-v2-add-${e.kind}`}
            onClick={() => try_(onChange, addContextExtraSource(source, ctxName, e.kind))}>{e.label}</Button>
        ))}
      </Group>
    );
  }

  return null;
}
