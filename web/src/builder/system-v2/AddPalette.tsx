// Per-view "+" palette: a tiny toolbar above the React Flow that exposes the
// adds that make sense at the current drill level, reusing v1's pure
// `addConstructSource` / `addSubdomainSource` (so the same parse-guarded edits
// the v1 inspector produces).
//
// Phase 3a covers system and context views — the levels v1's add.ts already
// handles directly. Subdomain-level "+ Context", aggregate-level "+ Operation"
// and operation-level "+ Stmt" come in Phase 3b once their pure helpers exist.

import { Button, Group } from "@mantine/core";
import { addConstructSource, addSubdomainSource } from "../system/add";
import { addStatement, type BodyLocator } from "../system/body";
import { addField, freshFieldName } from "../system/fields";
import { findAggregate, type ViewPath } from "./view-graph";
import { addContextSource, addOperationSource } from "./add-extra";
import { parseDdd } from "../parse";

interface Props {
  path: ViewPath;
  source: string;
  onChange: (next: string) => void;
}

const try_ = (onChange: (next: string) => void, next: string | null): void => {
  if (next != null) onChange(next);
};

export default function AddPalette({ path, source, onChange }: Props): JSX.Element | null {
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
      </Group>
    );
  }

  if (last.kind === "subdomain") {
    return (
      <Group gap={4} px={6} py={4} bg="dark.6" wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-v2-add-palette">
        <Button size="compact-xs" variant="light" data-testid="c4system-v2-add-context"
          onClick={() => try_(onChange, addContextSource(source, last.name))}>+ Context</Button>
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
        ? { kind: "workflow", name: last.name }
        : (() => {
            const agg = path[path.length - 2];
            return { kind: "operation", aggregate: agg?.name ?? "", op: last.name };
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
      </Group>
    );
  }

  return null;
}
