// ---------------------------------------------------------------------------
// `ConfirmAction` — the ONE confirm component for every destructive action in
// the playground (M-T8.17 slice 1, audit H8).
//
// Two shapes, one API:
//
//   * inline — the trigger is replaced in place by a consequence sentence and
//     a "Yes, …" / Cancel pair (the pattern the audit PR gave Reset database).
//     For small things: a file, a declaration, a menu link.
//   * modal  — a Mantine `Modal` with a title, the consequence, an optional
//     detail list and an optional type-to-confirm box.  For the actions whose
//     blast radius is a whole workspace.
//
// The copy comes from `confirm-state.ts`'s `confirmSites` catalog and the
// arm/confirm/cancel machine is `confirmReduce` there — this file is only the
// React over it.  `requestConfirm` is the imperative escape hatch for the one
// caller that lives inside an async function (`App.importExample`): it
// resolves a promise through a single mounted `<ConfirmHost/>`.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { Box, Button, Group, List, Modal, Stack, Text, TextInput } from "@mantine/core";
import {
  CONFIRM_IDLE,
  canConfirm,
  confirmReduce,
  type ConfirmSpec,
  type ConfirmState,
} from "./confirm-state";

export type { ConfirmSpec } from "./confirm-state";
export { confirmSites } from "./confirm-state";

/** Test-id triple for a confirm surface.  `base` alone derives
 *  `${base}-confirm` (the row / modal), `${base}-yes` and `${base}-cancel`;
 *  the overrides exist for the two pre-existing ids specs already use
 *  (`btn-wipe-confirm`, `history-restore-do`). */
export interface ConfirmTestIds {
  base: string;
  root?: string;
  yes?: string;
  cancel?: string;
}

function ids(t: ConfirmTestIds): { root: string; yes: string; cancel: string; type: string } {
  return {
    root: t.root ?? `${t.base}-confirm`,
    yes: t.yes ?? `${t.base}-yes`,
    cancel: t.cancel ?? `${t.base}-cancel`,
    type: `${t.base}-type`,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ConfirmHandle {
  state: ConfirmState;
  armed: boolean;
  arm: () => void;
  cancel: () => void;
  setTyped: (value: string) => void;
  /** Fires `onConfirm` and disarms — a no-op while `canConfirm` is false. */
  confirm: () => void;
  ok: boolean;
}

export function useConfirm(spec: Pick<ConfirmSpec, "typeToConfirm">, onConfirm: () => void): ConfirmHandle {
  const [state, dispatch] = useReducer(confirmReduce, CONFIRM_IDLE);
  const ok = canConfirm(state, spec);
  const confirm = useCallback((): void => {
    if (!ok) return;
    dispatch({ type: "confirm" });
    onConfirm();
  }, [ok, onConfirm]);
  return {
    state,
    armed: state.armed,
    arm: () => dispatch({ type: "arm" }),
    cancel: () => dispatch({ type: "cancel" }),
    setTyped: (value) => dispatch({ type: "type", value }),
    confirm,
    ok,
  };
}

// ---------------------------------------------------------------------------
// Inline row
// ---------------------------------------------------------------------------

export interface InlineConfirmProps {
  spec: ConfirmSpec;
  onConfirm: () => void;
  onCancel: () => void;
  testids: ConfirmTestIds;
  /** Spinner on the affirmative button while the action runs. */
  loading?: boolean;
  /** Stack the sentence above the buttons (a node on the canvas is narrow). */
  stacked?: boolean;
  /** Mantine size for the buttons; `compact-xs` on dense chrome. */
  size?: "xs" | "compact-xs";
}

/** The armed state of an inline confirm: consequence + Yes / Cancel.  Renders
 *  as a `role="group"` labelled by the consequence so a screen reader hears
 *  what the two buttons decide. */
export function InlineConfirm({
  spec,
  onConfirm,
  onCancel,
  testids,
  loading = false,
  stacked = false,
  size = "xs",
}: InlineConfirmProps): JSX.Element {
  const t = ids(testids);
  // Escape anywhere inside the row cancels — the same key that closes the
  // modal shape, so both shapes answer the same reflex.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  };
  const buttons = (
    <Group gap={6} wrap="nowrap">
      <Button
        size={size}
        color="red"
        loading={loading}
        onClick={(e) => {
          e.stopPropagation();
          onConfirm();
        }}
        data-testid={t.yes}
      >
        {spec.confirmLabel}
      </Button>
      <Button
        size={size}
        variant="subtle"
        color="gray"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        data-testid={t.cancel}
      >
        Cancel
      </Button>
    </Group>
  );
  const sentence = (
    <Text size="xs" c="dimmed" style={stacked ? undefined : { flex: 1, minWidth: 0 }}>
      {spec.consequence}
    </Text>
  );
  return (
    <Box
      role="group"
      aria-label={spec.consequence}
      data-testid={t.root}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {stacked ? (
        <Stack gap={4}>
          {sentence}
          {buttons}
        </Stack>
      ) : (
        <Group gap={6} wrap="nowrap" align="center">
          {sentence}
          {buttons}
        </Group>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ConfirmModalProps {
  opened: boolean;
  spec: ConfirmSpec;
  onConfirm: () => void;
  onCancel: () => void;
  testids: ConfirmTestIds;
  loading?: boolean;
}

/** The modal shape.  Owns its type-to-confirm draft (reset on every open) so
 *  callers only hold `opened`. */
export function ConfirmModal({ opened, spec, onConfirm, onCancel, testids, loading = false }: ConfirmModalProps): JSX.Element {
  const t = ids(testids);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (opened) setTyped("");
  }, [opened]);
  const ok = canConfirm({ armed: opened, typed }, spec);
  return (
    <Modal
      opened={opened}
      onClose={onCancel}
      title={spec.title ?? spec.confirmLabel}
      centered
      size="sm"
      data-testid={t.root}
    >
      <Stack gap="sm">
        <Text size="sm">{spec.consequence}</Text>
        {spec.details && spec.details.length > 0 && (
          <List size="xs" spacing={2} style={{ fontFamily: "var(--mantine-font-family-monospace)" }}>
            {spec.details.map((d) => (
              <List.Item key={d}>{d}</List.Item>
            ))}
          </List>
        )}
        {spec.typeToConfirm !== undefined && (
          <TextInput
            size="sm"
            label={`Type “${spec.typeToConfirm}” to confirm`}
            value={typed}
            autoFocus
            onChange={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ok) onConfirm();
            }}
            data-testid={t.type}
          />
        )}
        <Group justify="flex-end" gap={8}>
          <Button size="xs" variant="default" onClick={onCancel} disabled={loading} data-testid={t.cancel}>
            Cancel
          </Button>
          <Button size="xs" color="red" onClick={onConfirm} disabled={!ok} loading={loading} data-testid={t.yes}>
            {spec.confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Trigger-driven convenience
// ---------------------------------------------------------------------------

export interface ConfirmActionProps {
  spec: ConfirmSpec;
  /** Renders the trigger; call `arm` from its click.  For the inline shape
   *  the trigger is REPLACED by the row while armed. */
  trigger: (arm: () => void) => ReactNode;
  onConfirm: () => void;
  testids: ConfirmTestIds;
  loading?: boolean;
  stacked?: boolean;
  size?: "xs" | "compact-xs";
}

/** A trigger that asks first.  `spec.shape` decides whether the armed state is
 *  the inline row (in place of the trigger) or a modal (beside it). */
export function ConfirmAction({ spec, trigger, onConfirm, testids, loading, stacked, size }: ConfirmActionProps): JSX.Element {
  const h = useConfirm(spec, onConfirm);
  if (spec.shape === "modal") {
    return (
      <>
        {trigger(h.arm)}
        <ConfirmModal opened={h.armed} spec={spec} onConfirm={h.confirm} onCancel={h.cancel} testids={testids} loading={loading} />
      </>
    );
  }
  if (!h.armed) return <>{trigger(h.arm)}</>;
  return (
    <InlineConfirm spec={spec} onConfirm={h.confirm} onCancel={h.cancel} testids={testids} loading={loading} stacked={stacked} size={size} />
  );
}

// ---------------------------------------------------------------------------
// Imperative host — for async callers
// ---------------------------------------------------------------------------

interface PendingRequest {
  spec: ConfirmSpec;
  testids: ConfirmTestIds;
  resolve: (ok: boolean) => void;
}

let hostListener: ((req: PendingRequest | null) => void) | null = null;

/** Ask through the mounted `<ConfirmHost/>`.  Resolves `false` when no host is
 *  mounted (a headless harness) — never blocks, never throws: a missing host
 *  must fail SAFE (the action doesn't run), not fail open. */
export function requestConfirm(spec: ConfirmSpec, testids: ConfirmTestIds): Promise<boolean> {
  if (!hostListener) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    hostListener?.({ spec, testids, resolve });
  });
}

/** Mount ONCE, anywhere under the MantineProvider.  Renders the modal for the
 *  current `requestConfirm`; a second request while one is open cancels the
 *  first (resolves it `false`) rather than stacking. */
export function ConfirmHost(): JSX.Element | null {
  const [req, setReq] = useState<PendingRequest | null>(null);
  useEffect(() => {
    hostListener = (next) => {
      setReq((cur) => {
        cur?.resolve(false);
        return next;
      });
    };
    return () => {
      hostListener = null;
    };
  }, []);
  if (!req) return null;
  const finish = (ok: boolean): void => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <ConfirmModal
      opened
      spec={req.spec}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
      testids={req.testids}
    />
  );
}
