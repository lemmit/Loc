// Auto-generated.  Top-level error boundary — catches render-time
// exceptions so one broken component shows a readable fallback instead of
// a blank screen, and logs the error (surfaced in the Loom playground's
// "App logs" stream and captured by e2e console capture).
import { Component, type ErrorInfo, type ReactNode } from "react";
import { getLogger } from "./logger";

const log = getLogger("react");

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// Style objects kept as consts (inline double-brace JSX style props are
// avoided here because this file is a Handlebars template).
const wrapStyle = { padding: 16, fontFamily: "system-ui, sans-serif" } as const;
const msgStyle = { whiteSpace: "pre-wrap", color: "#b91c1c" } as const;

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("Uncaught render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" style={wrapStyle}>
          <h2 style={msgStyle}>Something went wrong.</h2>
          <pre style={msgStyle}>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
