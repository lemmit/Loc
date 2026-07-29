// ---------------------------------------------------------------------------
// In-system typed api bindings (M-T4.8) — resolve, for one deployable, the
// `resource { kind: api, use: <Api> }` bindings it wires and which sibling
// deployable serves each.
//
// Pure IR: no port resolution here.  A service's container port comes from
// `PlatformSurface.composeService()`, which lives ABOVE this layer — the
// composer joins that on.  Keeping the join here would drag `platform/` into
// `ir/` against the pipeline direction.
// ---------------------------------------------------------------------------

import { descriptorFor } from "../../platform/metadata.js";
import type { DataSourceIR, DeployableIR, SystemIR } from "../types/loom-ir.js";

export interface ApiResourceBinding {
  /** The `resource` declaration doing the binding. */
  readonly resource: DataSourceIR;
  /** The `api` it binds (`resource.apiName`). */
  readonly apiName: string;
  /** The backend deployable that `serves:` that api — the call's target. */
  readonly server: DeployableIR;
}

/** The api-bound resources `deployable` wires, each joined to the deployable
 *  that serves it.  A binding whose api no backend serves — or which more than
 *  one serves — is DROPPED here rather than guessed: `loom.resource-api-unserved`
 *  / `loom.resource-api-ambiguous-server` already fail the build, so by the time
 *  a generator runs, every surviving binding has exactly one server. */
export function apiResourceBindings(deployable: DeployableIR, sys: SystemIR): ApiResourceBinding[] {
  const out: ApiResourceBinding[] = [];
  for (const name of deployable.dataSourceNames) {
    const resource = sys.dataSources.find((r) => r.name === name);
    if (!resource?.apiName) continue;
    const servers = sys.deployables.filter(
      (d) => d.serves.includes(resource.apiName as string) && !descriptorFor(d.platform).isFrontend,
    );
    const server = servers.length === 1 ? servers[0] : undefined;
    if (!server) continue;
    // A deployable serving the api it also consumes is `loom.resource-api-self-call`
    // — likewise already an error; skip so a diagnostics-suppressed run can't
    // emit a service that depends_on itself (compose rejects the cycle).
    if (server.name === deployable.name) continue;
    out.push({ resource, apiName: resource.apiName, server });
  }
  return out;
}

/** True when any deployable in the system wires an api-bound resource — the
 *  gate that keeps systems without one byte-identical. */
export function systemHasApiResourceBindings(sys: SystemIR): boolean {
  return sys.dataSources.some((r) => r.apiName);
}
