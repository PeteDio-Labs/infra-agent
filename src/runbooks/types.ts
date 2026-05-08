/**
 * Approval preview discriminated union — matches MC Phase 2.4 contract
 * (planning/MISSION-CONTROL-HOMELAB-UPGRADE.md lines 192-195).
 *
 * The MC frontend reads `pending_approval.preview` directly, so the shape
 * (key names, case) MUST match what's defined here.
 *
 * Note: today @petedio/shared@^1.1.0 declares `GatedAction.preview` as
 * `z.string().optional()`, so until Stream D bumps the shared schema, the
 * structured object is emitted as-is and the MC backend will only render
 * it correctly after the schema change ships. The shape itself is the
 * source-of-truth here.
 */

export interface TextPreview {
  type: 'text';
  content: string;
}

export interface TfPlanPreview {
  type: 'tf-plan';
  planText: string;
  summary: {
    add: number;
    change: number;
    destroy: number;
  };
}

export interface AnsibleCheckTask {
  name: string;
  host: string;
  changed: boolean;
  diff?: string;
}

export interface AnsibleCheckPreview {
  type: 'ansible-check';
  tasks: AnsibleCheckTask[];
}

export type ApprovalPreview = TextPreview | TfPlanPreview | AnsibleCheckPreview;

/**
 * Counts of resource changes parsed from `terraform show -json tfplan`.
 */
export interface PlanSummary {
  add: number;
  change: number;
  destroy: number;
}

/**
 * Result of running `terraform plan` — captured stdout plus a parsed summary
 * suitable for the `tf-plan` ApprovalPreview shape.
 */
export interface TerraformPlanResult {
  planText: string;
  summary: PlanSummary;
  planJsonPath: string;
}

/**
 * Outcome from the gate hook — mirrors the v1.2.x shared API.
 */
export type GateDecision = 'proceed' | 'skip' | 'abort';

/**
 * Hook called BEFORE a gated step runs. Implementations post a structured
 * preview to MC and poll for the operator's approve/reject decision.
 *
 * Returns:
 *   - 'proceed' on approve
 *   - 'abort' on reject
 *   - 'skip' if the gated step should be silently skipped (not used here today)
 */
export type GateHook = (input: {
  preview: ApprovalPreview;
  description: string;
  actionType: string;
}) => Promise<GateDecision>;
