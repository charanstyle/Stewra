import type { MachineAccessRequest } from '../models/machineAccess';

// ── Machine access — a bridge asking to see the machine it runs on ──────────────────────────────────

/** GET /orgs/:orgId/machine-access — every request against this org's machines. Viewer. */
export interface ListMachineAccessRequestsResponse {
  readonly requests: readonly MachineAccessRequest[];
}

/**
 * POST /orgs/:orgId/machine-access/:requestId/decide — approve or refuse. Admin.
 *
 * `approve` is a boolean rather than two endpoints because a denial is a real decision that must be
 * recorded, not the absence of one: a request nobody answers stays pending and the asker keeps waiting.
 */
export interface DecideMachineAccessRequest {
  readonly approve: boolean;
}

export interface DecideMachineAccessResponse {
  readonly request: MachineAccessRequest;
}
