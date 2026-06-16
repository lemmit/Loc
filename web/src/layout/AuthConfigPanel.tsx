import { Alert, Box, Code, Group, Stack, Switch, Text, Textarea } from "@mantine/core";
import { type AuthStubConfig, type LayoutCtx, devClaimsHeader } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// Auth config tab (Phase 7) — a dev-only identity stub.  The playground
// runs the generated Hono backend in-browser, where a real OIDC verifier
// can't reach an IdP; this panel instead injects the configured claims as
// the `x-loom-dev-claims` header on every dispatched request (Backend
// tester + Preview app), which the generated dev-stub verifier merges over
// its built-in identity.  So an `auth: required` system is explorable as
// different users — flip `role`, watch a `requires`-gated route go
// 200 ↔ 403 — without any token.
export function AuthConfigPanel({ ctx }: Props): JSX.Element {
  const { authStub, setAuthStub } = ctx;

  // Parse state drives the inline validity hint.  An empty / disabled stub
  // is valid (no header injected); a non-object or malformed body is not.
  const parseState = validate(authStub);

  return (
    <Box p="md" style={{ overflow: "auto", height: "100%" }}>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Box>
            <Text size="sm" fw={600}>
              Inject identity
            </Text>
            <Text size="xs" c="dimmed">
              Send these claims as <Code>x-loom-dev-claims</Code> on every request.
            </Text>
          </Box>
          <Switch
            checked={authStub.enabled}
            onChange={(e) =>
              setAuthStub((prev) => ({ ...prev, enabled: e.currentTarget.checked }))
            }
            data-testid="auth-stub-enabled"
            label={authStub.enabled ? "On" : "Off"}
          />
        </Group>

        <Textarea
          label="Claims (JSON)"
          description="Overrides the dev-stub's built-in identity. e.g. flip role to test a requires gate."
          autosize
          minRows={4}
          maxRows={16}
          spellCheck={false}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
          value={authStub.claimsJson}
          disabled={!authStub.enabled}
          onChange={(e) =>
            setAuthStub((prev) => ({ ...prev, claimsJson: e.currentTarget.value }))
          }
          data-testid="auth-stub-claims"
        />

        {authStub.enabled && parseState.kind === "error" && (
          <Alert color="red" variant="light" data-testid="auth-stub-error">
            {parseState.message}
          </Alert>
        )}

        <Alert color="yellow" variant="light" title="Dev only">
          <Text size="xs">
            This is a sandbox convenience — the generated dev-stub verifier trusts this
            header and accepts every request. A system with a real <Code>auth {"{"} oidc {"}"}</Code>{" "}
            block runs the OIDC verifier instead, which ignores this header.
          </Text>
        </Alert>
      </Stack>
    </Box>
  );
}

type ParseState = { kind: "ok" } | { kind: "error"; message: string };

function validate(cfg: AuthStubConfig): ParseState {
  if (!cfg.enabled) return { kind: "ok" };
  let obj: unknown;
  try {
    obj = JSON.parse(cfg.claimsJson);
  } catch {
    return { kind: "error", message: "Claims must be valid JSON." };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { kind: "error", message: "Claims must be a JSON object, e.g. { \"role\": \"agent\" }." };
  }
  return { kind: "ok" };
}

/** A status dot for the dock tab — green when an identity is actively
 *  injected, gray otherwise. */
export function authStubDot(ctx: LayoutCtx): "green" | null {
  return devClaimsHeader(ctx.authStub) ? "green" : null;
}
