// ---------------------------------------------------------------------------
// Pane-level error boundary.
//
// The root boundary (`ErrorBoundary.tsx`) converts a render throw into a
// full-page fallback — correct for a crash in the shell, far too blunt for one
// in a builder pane.  The builders re-parse the live source on every keystroke
// and therefore render against partially-recovered ASTs; a throw in one of them
// must not take the editor, the preview, and the workspace UI down with it.
//
// This boundary keeps the crash local: an inline panel where the pane was, plus
// a "Reset pane" button that clears the error and remounts the subtree (the
// source has usually been fixed by then, so a remount is all it takes).
// ---------------------------------------------------------------------------

import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { logDiagnostic } from "./util/diagnostics";

interface Props {
  children: ReactNode;
  /** Pane label shown in the fallback (e.g. "Builder"). */
  name: string;
}

interface State {
  error: Error | null;
  /** Bumped by "Reset pane" — remounts the children so a fixed source re-renders
   *  from a clean subtree instead of re-throwing on retained state. */
  resetKey: number;
}

export class PaneErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`Pane crashed (${this.props.name}):`, error, info.componentStack);
    void logDiagnostic("react-error-pane");
  }

  private reset = (): void => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
    return (
      <Stack gap="sm" p="md" style={{ flex: 1, minHeight: 0, overflow: "auto" }} data-testid="pane-crash-fallback">
        <Alert color="red" title={`This pane crashed (${this.props.name})`}>
          <Text size="sm" c="dimmed">
            The rest of the playground is unaffected — your source and workspace
            are untouched. Fix the source in the editor, then reset this pane.
          </Text>
        </Alert>
        <Code block style={{ whiteSpace: "pre-wrap" }}>
          {error.message || String(error)}
        </Code>
        <Group>
          <Button size="xs" onClick={this.reset} data-testid="pane-crash-reset">
            Reset pane
          </Button>
        </Group>
      </Stack>
    );
  }
}
