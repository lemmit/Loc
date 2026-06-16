// Framework-neutral frontend auth files (D-AUTH-OIDC, `auth: ui`).
//
// Emitted into a React deployable that opts in via `auth: ui` (and whose
// target backend is `auth: required`).  Pack-agnostic — plain React +
// inline styles, no design-system imports — so a single pair of files
// works under every design pack.  The guard probes the backend's
// `/auth/me` session route (which works for both the OIDC verifier and
// the in-browser playground dev stub) and gates the app on a verified
// session; "Sign in" redirects to the backend's `/auth/login` (→ IdP).

/** `src/auth/session.ts` — session probe + sign-in/out redirects. */
export const AUTH_SESSION_TS = `// Auto-generated.
import { ApiError, api } from "../api/client";
import { API_BASE_URL } from "../api/config";

export type SessionUser = Record<string, unknown>;

/** Redirect to the backend's login, which 302s to the IdP's hosted login
 *  page.  No login form is shipped — the IdP owns credentials. */
export function signIn(): void {
  window.location.href = \`\${API_BASE_URL}/auth/login\`;
}

/** Redirect to the backend's logout, clearing the local session. */
export function signOut(): void {
  window.location.href = \`\${API_BASE_URL}/auth/logout\`;
}

/** Probe the current session.  Returns the verified user claims, or null
 *  when unauthenticated (HTTP 401). */
export async function fetchSession(): Promise<SessionUser | null> {
  try {
    const me = await api.get("/auth/me");
    return me !== null && typeof me === "object" ? (me as SessionUser) : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
`;

/** `src/auth/AuthGate.tsx` — the route guard + session context. */
export const AUTH_GATE_TSX = `// Auto-generated.
import { type CSSProperties, type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { type SessionUser, fetchSession, signIn, signOut } from "./session";

interface Session {
  user: SessionUser;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

/** Access the verified session from inside the guarded app. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <AuthGate>");
  return ctx;
}

type State =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "authed"; user: SessionUser };

/** Gates the app on a verified session.  Probes /auth/me on mount: shows a
 *  spinner while loading, a Sign in screen (redirecting to the IdP) when
 *  unauthenticated, and the app once authenticated. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    fetchSession()
      .then((user) => {
        if (active) setState(user ? { kind: "authed", user } : { kind: "anon" });
      })
      .catch(() => {
        if (active) setState({ kind: "anon" });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === "loading") {
    return <div style={centered}>Loading…</div>;
  }
  if (state.kind === "anon") {
    return (
      <div style={centered}>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ marginBottom: 16 }}>Sign in</h1>
          <button type="button" style={primaryButton} onClick={signIn}>
            Sign in
          </button>
        </div>
      </div>
    );
  }
  return (
    <SessionContext.Provider value={{ user: state.user, signOut }}>
      {children}
      <button type="button" style={signOutButton} onClick={signOut}>
        Sign out
      </button>
    </SessionContext.Provider>
  );
}

const centered: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
};
const primaryButton: CSSProperties = {
  padding: "8px 20px",
  fontSize: 16,
  cursor: "pointer",
};
const signOutButton: CSSProperties = {
  position: "fixed",
  bottom: 12,
  right: 12,
  zIndex: 1000,
  padding: "6px 12px",
  cursor: "pointer",
};
`;
