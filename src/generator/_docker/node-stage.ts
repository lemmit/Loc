// ---------------------------------------------------------------------------
// Shared Dockerfile fragments for the NODE build stages every backend's
// Dockerfile may carry — the embedded-SPA (`spa-build`) stage on the
// fullstack .NET / Java / Python / Phoenix images, and the Phoenix LiveView
// `assets-build` stage.
//
// Two invariants live here, and they are the reason this is one module rather
// than four copies (M-FT.13, findings G7b/G10).  The three STANDALONE frontend
// hosts keep their own copies because they are `.hbs` templates, not TS
// emitters — `test/system/generation-defaults.test.ts` asserts the invariants
// over those files too, so the two halves cannot drift apart silently:
//
//  1. **Certs before the first network call.**  A proxy CA dropped into
//     `certs/` must be trusted by the stage that runs `npm install`, not just
//     by the stage that runs the language toolchain.  The Phoenix
//     `assets-build` stage used to run `npm install` BEFORE any `COPY certs/`,
//     so behind a TLS-terminating proxy the elixir image was the one image in
//     the matrix that could not build.  Every node stage now opens with the
//     same block.
//  2. **`npm install`, never `npm ci`.**  No generator emits a
//     `package-lock.json`, so `npm ci` always fails — and `npm ci || npm
//     install` still dumps npm's whole EUSAGE usage text into the build log on
//     every first build.  `--no-audit --no-fund` drops two registry
//     round-trips and the funding banner.
// ---------------------------------------------------------------------------

/** Proxy-CA trust for an alpine/debian `node:*` stage.  `certs/` always
 *  exists in the emitted project (it carries a `.gitkeep`), so the COPY is a
 *  no-op when no CAs are configured.  Ends with a newline: callers splice it
 *  straight into a template literal before the next instruction. */
export const NODE_CERTS_BLOCK = `# Optional proxy CAs — drop *.crt files into ./certs/ to make npm
# trust them.  The directory always exists (with a .gitkeep), so
# this COPY is a no-op when no CAs are configured.  It has to come
# BEFORE the install below: that is this stage's first network call.
COPY certs/ /usr/local/share/ca-certificates/
RUN cat /usr/local/share/ca-certificates/*.crt 2>/dev/null >> /etc/ssl/cert.pem || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem NPM_CONFIG_CAFILE=/etc/ssl/cert.pem
`;

/** Proxy-CA trust for a debian-based stage that layers Node onto another SDK
 *  (the Feliz `spa-build` stage: `dotnet/sdk` + nodesource).  Debian ships
 *  `update-ca-certificates`, so the CA lands in the OS bundle that curl, apt,
 *  the .NET SDK and Node all read. */
export const DEBIAN_CERTS_BLOCK = `# Optional proxy CAs — drop *.crt files into ./certs/ to make curl / apt /
# dotnet / npm trust them.  The directory always exists (with a .gitkeep),
# so this COPY is a no-op when no CAs are configured.  It has to come BEFORE
# the nodesource fetch below: that is this stage's first network call.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>/dev/null || true
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \\
    NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt
`;

/** The dependency install every node stage runs.  See invariant 2 above. */
export const NPM_INSTALL_BLOCK = `# Use plain "npm install" rather than "npm ci": the generator emits no
# package-lock.json so npm ci exits with EUSAGE and dumps its whole usage
# text into the build log.  --no-audit --no-fund keeps the log clean and
# skips two registry round-trips.
RUN npm install --no-audit --no-fund
`;

/** Line-array form of the blocks above, for emitters that build their
 *  Dockerfile through `lines(...)` instead of a template literal. */
export const NODE_CERTS_LINES: readonly string[] = NODE_CERTS_BLOCK.trimEnd().split("\n");
export const DEBIAN_CERTS_LINES: readonly string[] = DEBIAN_CERTS_BLOCK.trimEnd().split("\n");
export const NPM_INSTALL_LINES: readonly string[] = NPM_INSTALL_BLOCK.trimEnd().split("\n");
