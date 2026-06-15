// Auth-block checks (D-AUTH-OIDC) — the system-level `auth { … }` block
// that drives the generated OIDC verifier + `/auth/*` handshake.
//
// Block uniqueness ("at most one `auth { … }` per system") is enforced
// alongside the theme-block check in `ddd-validator.ts`; this file owns
// the per-block semantic rules:
//   - requires a `user { … }` block (the claim shape it projects into)
//   - a `provider:` must name a known preset
//   - self-hosted providers (and a bare `oidc { … }`) need an `issuer`
//   - OIDC always needs a `clientId`
//   - every `claims:` entry must target a real `user { … }` field

import type { ValidationAcceptor } from "langium";
import { isKnownProvider, KNOWN_PROVIDERS, lookupPreset } from "../../util/auth-providers.js";
import { type AuthBlock, isUserBlock, type System } from "../generated/ast.js";

export function checkAuthBlock(auth: AuthBlock, system: System, accept: ValidationAcceptor): void {
  // 1. An auth block needs a user block to define the identity shape.
  const userBlock = system.members.find(isUserBlock);
  if (!userBlock) {
    accept("error", "auth block requires a `user { … }` block to define the identity shape.", {
      node: auth,
      code: "loom.auth-without-user",
    });
    return;
  }
  const userFields = new Set(userBlock.fields.map((f) => f.name));

  // 2. A named provider must be a known preset.
  const provider = auth.provider;
  if (provider !== undefined && !isKnownProvider(provider)) {
    accept(
      "error",
      `unknown auth provider '${provider}'.  Known providers: ${KNOWN_PROVIDERS.join(", ")} (or omit \`provider:\` and supply a raw \`oidc { issuer }\`).`,
      { node: auth, property: "provider", code: "loom.auth-unknown-provider" },
    );
  }

  // 3. Issuer + clientId resolution.  An explicit `oidc { issuer }`
  //    always satisfies; otherwise a hosted preset supplies a fixed one.
  const preset = provider && isKnownProvider(provider) ? lookupPreset(provider) : undefined;
  const hasExplicitIssuer = auth.oidc?.issuer !== undefined;
  const hasPresetIssuer = !!preset && preset.issuer !== "";
  if (!hasExplicitIssuer && !hasPresetIssuer) {
    accept(
      "error",
      provider && preset?.requiresIssuer
        ? `provider '${provider}' is self-hosted and requires an \`oidc { issuer: … }\` block.`
        : 'oidc requires an `issuer` (env-bound).  Add an `oidc { issuer: env("OIDC_ISSUER") }` block.',
      { node: auth, property: "oidc", code: "loom.auth-missing-issuer" },
    );
  }

  // clientId is always required for an OIDC client.
  if (auth.oidc?.clientId === undefined) {
    accept(
      "error",
      'oidc requires a `clientId` (env-bound).  Add `clientId: env("OIDC_CLIENT_ID")` to the `oidc { … }` block.',
      { node: auth, property: "oidc", code: "loom.auth-missing-client-id" },
    );
  }

  // 4. Claim mappings must target real user fields.
  for (const entry of auth.claims?.entries ?? []) {
    if (!userFields.has(entry.field)) {
      accept("error", `claim mapping targets unknown user field '${entry.field}'.`, {
        node: entry,
        property: "field",
        code: "loom.auth-unknown-claim-field",
      });
    }
  }
}
