/**
 * Terraform runbooks for infra-agent — implements Phase G of the
 * "review-the-ansible-directory" plan + Phase 2 of the
 * MISSION-CONTROL-HOMELAB-UPGRADE plan.
 *
 * Six modes, three flavours:
 *   - read-only:   tf:plan, tf:output, tf:state-list
 *   - apply-style: tf:apply, tf:destroy           (plan → gate → apply tfplan)
 *   - import:      tf:import                      (target plan → gate → import)
 *
 * Each mode returns an array of `TerraformStep` ready to be fed to
 * `runDeterministicPlan` (or executed manually). Gated steps emit a
 * structured `ApprovalPreview` of the `tf-plan` variant — the MC frontend
 * (Phase 2.4) will read this directly without translation.
 *
 * Execution is fully command-driven: every shell-out goes through the
 * injected `runner` so tests can stub out terraform.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type {
  ApprovalPreview,
  GateDecision,
  GateHook,
  PlanSummary,
  TerraformPlanResult,
} from './types.js';

// ─── Constants ───────────────────────────────────────────────────

export const TF_ENV_ROOT_DEFAULT = '/home/pedro/PeteDio-Labs/infrastructure/terraform/environments';

/**
 * Root directory for terraform environment workspaces. Defaults to the LXC
 * 113 path; tests + Mac runs can override via TF_ENV_ROOT.
 */
export function getTfEnvRoot(): string {
  return process.env.TF_ENV_ROOT ?? TF_ENV_ROOT_DEFAULT;
}

export const TF_PLAN_FILE = 'tfplan';
export const TF_BIN = process.env.TERRAFORM_BIN ?? 'terraform';

const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RESOURCE_ADDR_RE = /^[A-Za-z_][\w.\-[\]"']*$/;
// Resource IDs are quite freeform across providers (e.g. "pve02/118",
// "i-abc123", "vpc-xxxx"). Keep this loose but reject obvious shell metas.
const RESOURCE_ID_RE = /^[A-Za-z0-9_./:-]+$/;

// ─── Step contract (matches DeterministicStep<TAction>) ──────────

export type TerraformAction =
  | 'tf:plan'
  | 'tf:plan-destroy'
  | 'tf:plan-target'
  | 'tf:apply'
  | 'tf:output'
  | 'tf:state-list'
  | 'tf:import'
  | 'tf:show-json';

export interface TerraformStep {
  title: string;
  action: TerraformAction;
  args: {
    environment: string;
    targets?: string[];
    resourceAddress?: string;
    resourceId?: string;
    /** When true, the step is gated and must run inside the gate hook. */
    gated?: boolean;
  };
}

// ─── Pluggable runner — abstracts process spawn for testability ──

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a terraform (or any) command. Tests inject a stub; production wires
 * this to `Bun.spawn`.
 */
export type CommandRunner = (
  cmd: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
};

// ─── Environment + arg validation ────────────────────────────────

export class TerraformError extends Error {
  constructor(message: string, readonly code: 'invalid-env' | 'invalid-arg' | 'tf-failed' | 'gate-rejected') {
    super(message);
    this.name = 'TerraformError';
  }
}

export function resolveEnvironmentDir(environment: string): string {
  if (!ENV_NAME_RE.test(environment)) {
    throw new TerraformError(
      `Invalid environment name: "${environment}". Must match ${ENV_NAME_RE}.`,
      'invalid-arg',
    );
  }
  const dir = resolve(getTfEnvRoot(), environment);
  if (!existsSync(dir)) {
    throw new TerraformError(
      `Terraform environment directory not found: ${dir}`,
      'invalid-env',
    );
  }
  return dir;
}

function validateTargets(targets: string[] | undefined): void {
  if (!targets) return;
  for (const t of targets) {
    if (!RESOURCE_ADDR_RE.test(t)) {
      throw new TerraformError(`Invalid -target address: "${t}".`, 'invalid-arg');
    }
  }
}

function validateResourceAddress(addr: string): void {
  if (!RESOURCE_ADDR_RE.test(addr)) {
    throw new TerraformError(`Invalid resource address: "${addr}".`, 'invalid-arg');
  }
}

function validateResourceId(id: string): void {
  if (!RESOURCE_ID_RE.test(id)) {
    throw new TerraformError(`Invalid resource id: "${id}".`, 'invalid-arg');
  }
}

function appendTargets(cmd: string[], targets: string[] | undefined): void {
  if (!targets) return;
  for (const t of targets) cmd.push(`-target=${t}`);
}

// ─── Plan parsing ────────────────────────────────────────────────

interface TfShowJson {
  resource_changes?: Array<{
    address?: string;
    change?: { actions?: string[] };
  }>;
}

/**
 * Counts add/change/destroy from a parsed `terraform show -json tfplan`.
 *
 * Terraform actions reference: a `change.actions` array per resource_change
 * entry. We follow the upgrade-plan summary: `add` counts pure creates,
 * `change` counts in-place updates, `destroy` counts pure deletes.
 * `replace` (delete+create) contributes to both add and destroy.
 */
export function summarizePlanJson(json: TfShowJson): PlanSummary {
  const summary: PlanSummary = { add: 0, change: 0, destroy: 0 };
  const changes = json.resource_changes ?? [];
  for (const c of changes) {
    const actions = c.change?.actions ?? [];
    const has = (a: string) => actions.includes(a);
    // Pure create
    if (actions.length === 1 && has('create')) summary.add += 1;
    // Pure update
    else if (actions.length === 1 && has('update')) summary.change += 1;
    // Pure delete
    else if (actions.length === 1 && has('delete')) summary.destroy += 1;
    // Replace = delete-create or create-delete (Terraform emits either order)
    else if (actions.length === 2 && has('create') && has('delete')) {
      summary.add += 1;
      summary.destroy += 1;
    }
    // 'no-op' / 'read' contribute nothing.
  }
  return summary;
}

// ─── Plan builders (mode → step list) ────────────────────────────

function planSteps(environment: string, targets?: string[]): TerraformStep[] {
  validateTargets(targets);
  return [
    {
      title: `terraform plan (${environment}${targets?.length ? `, targets=${targets.length}` : ''})`,
      action: 'tf:plan',
      args: { environment, targets },
    },
  ];
}

function applySteps(environment: string, targets?: string[]): TerraformStep[] {
  validateTargets(targets);
  return [
    {
      title: `terraform plan (${environment})`,
      action: 'tf:plan',
      args: { environment, targets },
    },
    {
      title: `terraform apply tfplan (${environment})`,
      action: 'tf:apply',
      args: { environment, targets, gated: true },
    },
  ];
}

function destroySteps(environment: string, targets?: string[]): TerraformStep[] {
  validateTargets(targets);
  return [
    {
      title: `terraform plan -destroy (${environment})`,
      action: 'tf:plan-destroy',
      args: { environment, targets },
    },
    {
      title: `terraform apply tfplan (destroy, ${environment})`,
      action: 'tf:apply',
      args: { environment, targets, gated: true },
    },
  ];
}

function importSteps(
  environment: string,
  resourceAddress: string,
  resourceId: string,
): TerraformStep[] {
  validateResourceAddress(resourceAddress);
  validateResourceId(resourceId);
  return [
    {
      title: `terraform plan -target=${resourceAddress} (dry-run import preview)`,
      action: 'tf:plan-target',
      args: { environment, resourceAddress },
    },
    {
      title: `terraform import ${resourceAddress} ${resourceId}`,
      action: 'tf:import',
      args: { environment, resourceAddress, resourceId, gated: true },
    },
  ];
}

function outputSteps(environment: string): TerraformStep[] {
  return [
    {
      title: `terraform output -json (${environment})`,
      action: 'tf:output',
      args: { environment },
    },
  ];
}

function stateListSteps(environment: string): TerraformStep[] {
  return [
    {
      title: `terraform state list (${environment})`,
      action: 'tf:state-list',
      args: { environment },
    },
  ];
}

// ─── Per-mode entry points (ready for index.ts dispatch) ─────────

export interface TfPlanInput {
  environment: string;
  targets?: string[];
}

export interface TfApplyInput {
  environment: string;
  targets?: string[];
}

export interface TfDestroyInput {
  environment: string;
  targets?: string[];
}

export interface TfImportInput {
  environment: string;
  resource_address: string;
  resource_id: string;
}

export interface TfOutputInput {
  environment: string;
}

export interface TfStateListInput {
  environment: string;
}

// Builders are exported for unit tests to assert plan shape without execution.
export const buildPlans = {
  plan: (input: TfPlanInput): TerraformStep[] => planSteps(input.environment, input.targets),
  apply: (input: TfApplyInput): TerraformStep[] => applySteps(input.environment, input.targets),
  destroy: (input: TfDestroyInput): TerraformStep[] => destroySteps(input.environment, input.targets),
  import: (input: TfImportInput): TerraformStep[] =>
    importSteps(input.environment, input.resource_address, input.resource_id),
  output: (input: TfOutputInput): TerraformStep[] => outputSteps(input.environment),
  stateList: (input: TfStateListInput): TerraformStep[] => stateListSteps(input.environment),
} as const;

// ─── Step executor ───────────────────────────────────────────────

export interface ExecuteOptions {
  runner?: CommandRunner;
  /**
   * Called before any gated step. If returns 'abort' (rejected) or 'skip',
   * the gated step is not executed; 'proceed' (approved) executes it.
   */
  onBeforeStep?: GateHook;
  /**
   * Per-step state: when the plan step runs first, it populates this so the
   * subsequent apply step can build the structured preview from the captured
   * stdout + summary. The same map is also used to surface the final result
   * back to the agent host.
   */
  state: TerraformStepState;
}

export interface TerraformStepState {
  lastPlan?: TerraformPlanResult;
  lastApplyOutput?: string;
  lastImportOutput?: string;
  lastOutputJson?: Record<string, unknown>;
  lastStateList?: string[];
  lastSkippedReason?: string;
  /** Set when any gate returns 'abort'. */
  aborted?: boolean;
}

const TF_PLAN_TIMEOUT_MS = 5 * 60_000;
const TF_APPLY_TIMEOUT_MS = 30 * 60_000;
const TF_READ_TIMEOUT_MS = 60_000;

function fail(label: string, result: CommandResult): never {
  throw new TerraformError(
    `${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    'tf-failed',
  );
}

async function runPlan(
  step: TerraformStep,
  destroyMode: boolean,
  runner: CommandRunner,
): Promise<TerraformPlanResult> {
  const cwd = resolveEnvironmentDir(step.args.environment);
  const cmd = [TF_BIN, 'plan', '-no-color', '-detailed-exitcode', `-out=${TF_PLAN_FILE}`];
  if (destroyMode) cmd.splice(2, 0, '-destroy'); // terraform plan -destroy ...
  if (step.args.targets) appendTargets(cmd, step.args.targets);
  if (step.args.resourceAddress) cmd.push(`-target=${step.args.resourceAddress}`);

  const result = await runner(cmd, { cwd, timeoutMs: TF_PLAN_TIMEOUT_MS });
  // -detailed-exitcode: 0 = no changes, 1 = error, 2 = changes present.
  // Both 0 and 2 are "success" for our purposes — only 1 is a hard failure.
  if (result.exitCode === 1) fail('terraform plan', result);

  const showCmd = [TF_BIN, 'show', '-json', TF_PLAN_FILE];
  const show = await runner(showCmd, { cwd, timeoutMs: TF_READ_TIMEOUT_MS });
  if (show.exitCode !== 0) fail('terraform show -json tfplan', show);

  let parsed: TfShowJson = {};
  try {
    parsed = JSON.parse(show.stdout) as TfShowJson;
  } catch (err) {
    throw new TerraformError(
      `terraform show -json produced unparsable output: ${(err as Error).message}`,
      'tf-failed',
    );
  }
  const summary = summarizePlanJson(parsed);
  return {
    planText: result.stdout,
    summary,
    planJsonPath: join(cwd, TF_PLAN_FILE),
  };
}

async function runApply(
  step: TerraformStep,
  runner: CommandRunner,
): Promise<string> {
  const cwd = resolveEnvironmentDir(step.args.environment);
  // Apply ALWAYS consumes the saved tfplan — never re-plans. This is the
  // contract that makes plan-first approvals safe: operator approves diff X,
  // we apply diff X, no surprises.
  const cmd = [TF_BIN, 'apply', '-no-color', '-auto-approve', TF_PLAN_FILE];
  const result = await runner(cmd, { cwd, timeoutMs: TF_APPLY_TIMEOUT_MS });
  if (result.exitCode !== 0) fail('terraform apply', result);
  return result.stdout;
}

async function runImport(
  step: TerraformStep,
  runner: CommandRunner,
): Promise<string> {
  const cwd = resolveEnvironmentDir(step.args.environment);
  const addr = step.args.resourceAddress;
  const id = step.args.resourceId;
  if (!addr || !id) {
    throw new TerraformError('tf:import requires resourceAddress and resourceId', 'invalid-arg');
  }
  const cmd = [TF_BIN, 'import', '-no-color', addr, id];
  const result = await runner(cmd, { cwd, timeoutMs: TF_APPLY_TIMEOUT_MS });
  if (result.exitCode !== 0) fail('terraform import', result);
  return result.stdout;
}

async function runOutput(
  step: TerraformStep,
  runner: CommandRunner,
): Promise<Record<string, unknown>> {
  const cwd = resolveEnvironmentDir(step.args.environment);
  const cmd = [TF_BIN, 'output', '-json', '-no-color'];
  const result = await runner(cmd, { cwd, timeoutMs: TF_READ_TIMEOUT_MS });
  if (result.exitCode !== 0) fail('terraform output', result);
  try {
    return JSON.parse(result.stdout || '{}') as Record<string, unknown>;
  } catch (err) {
    throw new TerraformError(
      `terraform output JSON unparsable: ${(err as Error).message}`,
      'tf-failed',
    );
  }
}

async function runStateList(
  step: TerraformStep,
  runner: CommandRunner,
): Promise<string[]> {
  const cwd = resolveEnvironmentDir(step.args.environment);
  const cmd = [TF_BIN, 'state', 'list', '-no-color'];
  const result = await runner(cmd, { cwd, timeoutMs: TF_READ_TIMEOUT_MS });
  if (result.exitCode !== 0) fail('terraform state list', result);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Build the structured ApprovalPreview for a gated terraform step. The
 * captured plan stdout is used directly as `planText`; counts come from the
 * `terraform show -json tfplan` summary parsed earlier.
 */
export function buildTfPlanPreview(plan: TerraformPlanResult): ApprovalPreview {
  return {
    type: 'tf-plan',
    planText: plan.planText,
    summary: plan.summary,
  };
}

/**
 * Single-step executor — used by the agent's deterministic step runner.
 * Read-only steps execute directly; gated steps consult `onBeforeStep` and
 * abort/skip per the operator's decision.
 */
export async function executeTerraformStep(
  step: TerraformStep,
  opts: ExecuteOptions,
): Promise<string> {
  const runner = opts.runner ?? defaultCommandRunner;

  if (opts.state.aborted) {
    return 'Skipped: prior gated step aborted.';
  }

  switch (step.action) {
    case 'tf:plan': {
      const plan = await runPlan(step, false, runner);
      opts.state.lastPlan = plan;
      return formatPlanReport(plan);
    }
    case 'tf:plan-destroy': {
      const plan = await runPlan(step, true, runner);
      opts.state.lastPlan = plan;
      return formatPlanReport(plan, '(destroy)');
    }
    case 'tf:plan-target': {
      const plan = await runPlan(step, false, runner);
      opts.state.lastPlan = plan;
      return formatPlanReport(plan, `(target=${step.args.resourceAddress})`);
    }
    case 'tf:apply': {
      // Apply is always gated — caller must have populated state.lastPlan.
      if (!step.args.gated) {
        throw new TerraformError('tf:apply requires gated=true on the step', 'invalid-arg');
      }
      const plan = opts.state.lastPlan;
      if (!plan) {
        throw new TerraformError(
          'tf:apply requires a prior tf:plan or tf:plan-destroy step to populate state.lastPlan',
          'invalid-arg',
        );
      }
      const decision = await invokeGate(opts.onBeforeStep, {
        preview: buildTfPlanPreview(plan),
        description:
          `Apply terraform plan in ${step.args.environment}: ` +
          `+${plan.summary.add}/~${plan.summary.change}/-${plan.summary.destroy}`,
        actionType: 'deploy',
      });
      if (decision === 'abort') {
        opts.state.aborted = true;
        return 'Aborted by operator.';
      }
      if (decision === 'skip') {
        opts.state.lastSkippedReason = 'apply skipped';
        return 'Skipped by operator.';
      }
      const out = await runApply(step, runner);
      opts.state.lastApplyOutput = out;
      // Re-list state for the final result line — useful as a sanity check.
      try {
        const list = await runStateList(step, runner);
        opts.state.lastStateList = list;
        return `${out}\n\n[state list: ${list.length} resources]`;
      } catch {
        return out;
      }
    }
    case 'tf:import': {
      if (!step.args.gated) {
        throw new TerraformError('tf:import requires gated=true on the step', 'invalid-arg');
      }
      const plan = opts.state.lastPlan;
      if (!plan) {
        throw new TerraformError(
          'tf:import requires a prior tf:plan-target step to populate state.lastPlan',
          'invalid-arg',
        );
      }
      const decision = await invokeGate(opts.onBeforeStep, {
        preview: buildTfPlanPreview(plan),
        description:
          `Import ${step.args.resourceAddress} = ${step.args.resourceId} in ${step.args.environment}`,
        actionType: 'deploy',
      });
      if (decision === 'abort') {
        opts.state.aborted = true;
        return 'Aborted by operator.';
      }
      if (decision === 'skip') {
        opts.state.lastSkippedReason = 'import skipped';
        return 'Skipped by operator.';
      }
      const out = await runImport(step, runner);
      opts.state.lastImportOutput = out;
      return out;
    }
    case 'tf:output': {
      const out = await runOutput(step, runner);
      opts.state.lastOutputJson = out;
      return JSON.stringify(out, null, 2);
    }
    case 'tf:state-list': {
      const list = await runStateList(step, runner);
      opts.state.lastStateList = list;
      return list.length === 0 ? '(empty)' : list.join('\n');
    }
    case 'tf:show-json': {
      // Helper kept private to the runbook for now — exposed only for
      // testability. Reads tfplan JSON via terraform show.
      const cwd = resolveEnvironmentDir(step.args.environment);
      const cmd = [TF_BIN, 'show', '-json', TF_PLAN_FILE];
      const result = await runner(cmd, { cwd, timeoutMs: TF_READ_TIMEOUT_MS });
      if (result.exitCode !== 0) fail('terraform show -json tfplan', result);
      return result.stdout;
    }
    default: {
      const exhaustive: never = step.action;
      throw new TerraformError(`Unknown terraform action: ${String(exhaustive)}`, 'invalid-arg');
    }
  }
}

async function invokeGate(
  hook: GateHook | undefined,
  args: { preview: ApprovalPreview; description: string; actionType: string },
): Promise<GateDecision> {
  if (!hook) {
    // No hook wired — treat as auto-approve. The host (index.ts) is
    // responsible for wiring a real hook before exposing destructive modes.
    return 'proceed';
  }
  return hook(args);
}

function formatPlanReport(plan: TerraformPlanResult, suffix?: string): string {
  const head = suffix
    ? `Plan ${suffix}: +${plan.summary.add}/~${plan.summary.change}/-${plan.summary.destroy}`
    : `Plan: +${plan.summary.add}/~${plan.summary.change}/-${plan.summary.destroy}`;
  return `${head}\n${plan.planText}`;
}

// ─── Convenience: run an entire mode end-to-end (used by index.ts) ─

/**
 * Reads the saved tfplan JSON for cases the host wants to surface it
 * without re-running terraform. Optional convenience.
 */
export function readPlanJson(environment: string): string | null {
  const dir = resolveEnvironmentDir(environment);
  const planPath = join(dir, TF_PLAN_FILE);
  if (!existsSync(planPath)) return null;
  // The tfplan binary is not human-readable; this returns the raw bytes
  // intentionally short — callers should use `tf:show-json` for the JSON.
  return readFileSync(planPath, 'utf-8');
}
