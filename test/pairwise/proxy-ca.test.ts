import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { caInstallPrefix, PROXY_CA_HOST_PATH, proxyCaDockerArgs } from "./compile-leg.js";

// ---------------------------------------------------------------------------
// The sandbox proxy CA must be plumbed ONLY where it exists.
//
// `/root/.ccr/ca-bundle.crt` is an artifact of this repo's agent sandbox, whose
// egress proxy re-signs TLS.  The dotnet leg mounted it and copied it into the
// container trust store UNCONDITIONALLY, so on a GitHub runner — where the file
// does not exist — the mount became an empty dir and every case died at
// `cp: cannot stat …`, reported as "emitted .NET project failed to compile".
//
// This pins both halves against whichever host runs it, so it is meaningful in
// the sandbox AND on the runner rather than only where it was written.
// ---------------------------------------------------------------------------

const present = fs.existsSync(PROXY_CA_HOST_PATH);

describe("proxy-CA plumbing matches the host it runs on", () => {
  it(`is ${present ? "wired (CA present)" : "absent (CA missing — the CI shape)"}`, () => {
    if (present) {
      expect(proxyCaDockerArgs()).toEqual(["-v", "/root/.ccr:/root/.ccr:ro"]);
      expect(caInstallPrefix()).toContain("update-ca-certificates");
    } else {
      // The CI shape: no mount, no copy, nothing to fail on.
      expect(proxyCaDockerArgs()).toEqual([]);
      expect(caInstallPrefix()).toBe("");
    }
  });

  it("the two halves agree — a mount without its install (or vice versa) is the drift", () => {
    expect(proxyCaDockerArgs().length > 0).toBe(caInstallPrefix() !== "");
  });

  it("the shell prefix re-tests the file, so an empty mount cannot resurrect the failure", () => {
    if (!present) return;
    expect(caInstallPrefix()).toMatch(/^if \[ -f \S+ \]; then /);
  });

  it("emits no dangling docker flag", () => {
    const a = proxyCaDockerArgs();
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-v" || a[i] === "-e") {
        expect(a[i + 1], `flag ${a[i]} has no value`).toBeDefined();
        expect(a[i + 1]?.startsWith("-")).toBe(false);
      }
    }
  });
});
