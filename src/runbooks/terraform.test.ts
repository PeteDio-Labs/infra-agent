import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TerraformError,
  TF_PLAN_FILE,
  buildPlans,
  buildTfPlanPreview,
  executeTerraformStep,
  resolveEnvironmentDir,
  summarizePlanJson,
  type CommandResult,
  type CommandRunner,
  type TerraformStep,
  type TerraformStepState,
} from './terraform.js';
import type { ApprovalPreview, GateDecision } from './types.js';

// ─── Test helpers ────────────────────────────────────────────────

/**
 * We point TF_ENV_ROOT at a temp dir for the duration of the suite so
 * resolveEnvironmentDir's existsSync check passes regardless of the host
 * (Mac vs LXC). All terraform commands themselves are stubbed via the
 * pluggable runner — no real terraform binary is ever invoked.
 */
const ENV = 'pve02-test';
let TMP_ROOT = '';

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'tf-runbook-test-'));
  mkdirSync(join(TMP_ROOT, ENV), { recursive: true });
  process.env.TF_ENV_ROOT = TMP_ROOT;
});

afterAll(() => {
  delete process.env.TF_ENV_ROOT;
  if (TMP_ROOT) rmSync(TMP_ROOT, { recursive: true, force: true });
});

function makeState(): TerraformStepState {
  return {};
}

interface ScriptedCommand {
  /** Substring match against `cmd.join(' ')` used to pick which canned
   * response to return. The first matching entry wins; matched entries are
   * removed (one-shot) unless `repeat: true`. */
  match: string;
  result: Partial<CommandResult>;
  repeat?: boolean;
}

function scriptedRunner(commands: ScriptedCommand[]): {
  runner: CommandRunner;
  calls: Array<{ cmd: string[]; cwd: string }>;
} {
  const calls: Array<{ cmd: string[]; cwd: string }> = [];
  const queue = [...commands];
  const runner: CommandRunner = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    const joined = cmd.join(' ');
    const idx = queue.findIndex((c) => joined.includes(c.match));
    if (idx === -1) {
      throw new Error(
        `Unexpected command in test: ${joined}\nRemaining queue: ${JSON.stringify(queue.map((q) => q.match))}`,
      );
    }
    const entry = queue[idx]!;
    if (!entry.repeat) queue.splice(idx, 1);
    return {
      stdout: entry.result.stdout ?? '',
      stderr: entry.result.stderr ?? '',
      exitCode: entry.result.exitCode ?? 0,
    };
  };
  return { runner, calls };
}

/**
 * A small but realistic `terraform show -json tfplan` payload — one create,
 * one update, one delete — used across plan/apply/destroy specs.
 */
const SAMPLE_PLAN_JSON = JSON.stringify({
  resource_changes: [
    { address: 'foo.add', change: { actions: ['create'] } },
    { address: 'foo.change', change: { actions: ['update'] } },
    { address: 'foo.destroy', change: { actions: ['delete'] } },
  ],
});

const SAMPLE_PLAN_STDOUT =
  'Terraform will perform the following actions:\n  + foo.add\n  ~ foo.change\n  - foo.destroy\n\nPlan: 1 to add, 1 to change, 1 to destroy.';

// ─── Pure-function tests: summarizePlanJson ──────────────────────

describe('summarizePlanJson', () => {
  it('counts pure create/update/delete actions correctly', () => {
    const summary = summarizePlanJson({
      resource_changes: [
        { change: { actions: ['create'] } },
        { change: { actions: ['create'] } },
        { change: { actions: ['update'] } },
        { change: { actions: ['delete'] } },
      ],
    });
    expect(summary).toEqual({ add: 2, change: 1, destroy: 1 });
  });

  it('counts replace as one add + one destroy', () => {
    const summary = summarizePlanJson({
      resource_changes: [
        { change: { actions: ['delete', 'create'] } },
        { change: { actions: ['create', 'delete'] } },
      ],
    });
    expect(summary).toEqual({ add: 2, change: 0, destroy: 2 });
  });

  it('ignores no-op and read actions', () => {
    const summary = summarizePlanJson({
      resource_changes: [
        { change: { actions: ['no-op'] } },
        { change: { actions: ['read'] } },
      ],
    });
    expect(summary).toEqual({ add: 0, change: 0, destroy: 0 });
  });

  it('returns zeros for an empty plan', () => {
    expect(summarizePlanJson({})).toEqual({ add: 0, change: 0, destroy: 0 });
  });
});

// ─── Pure-function tests: buildTfPlanPreview shape ───────────────

describe('buildTfPlanPreview', () => {
  it('emits the exact ApprovalPreview tf-plan variant shape', () => {
    const preview: ApprovalPreview = buildTfPlanPreview({
      planText: 'plan stdout here',
      summary: { add: 1, change: 2, destroy: 3 },
      planJsonPath: '/tmp/tfplan',
    });
    expect(preview).toEqual({
      type: 'tf-plan',
      planText: 'plan stdout here',
      summary: { add: 1, change: 2, destroy: 3 },
    });
    // Case-sensitive key check — guards against accidental rename.
    expect(Object.keys(preview).sort()).toEqual(['planText', 'summary', 'type']);
  });
});

// ─── Pure-function tests: resolveEnvironmentDir ──────────────────

describe('resolveEnvironmentDir', () => {
  it('returns the absolute path for a valid existing environment', () => {
    const dir = resolveEnvironmentDir(ENV);
    expect(dir.endsWith(`/${ENV}`)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('throws TerraformError for an invalid name (slashes/spaces)', () => {
    expect(() => resolveEnvironmentDir('../etc')).toThrow(TerraformError);
    expect(() => resolveEnvironmentDir('foo bar')).toThrow(TerraformError);
  });

  it('throws TerraformError for a missing directory', () => {
    expect(() => resolveEnvironmentDir('definitely-not-an-env-xyz')).toThrow(TerraformError);
  });
});

// ─── Plan builders ────────────────────────────────────────────────

describe('buildPlans', () => {
  it('plan: returns a single tf:plan step', () => {
    const steps = buildPlans.plan({ environment: ENV });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toBe('tf:plan');
  });

  it('apply: returns plan then gated apply', () => {
    const steps = buildPlans.apply({ environment: ENV });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.action).toBe('tf:plan');
    expect(steps[1]?.action).toBe('tf:apply');
    expect(steps[1]?.args.gated).toBe(true);
  });

  it('destroy: returns plan-destroy then gated apply', () => {
    const steps = buildPlans.destroy({ environment: ENV });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.action).toBe('tf:plan-destroy');
    expect(steps[1]?.action).toBe('tf:apply');
    expect(steps[1]?.args.gated).toBe(true);
  });

  it('import: returns plan-target then gated import', () => {
    const steps = buildPlans.import({
      environment: ENV,
      resource_address: 'foo.bar',
      resource_id: 'pve02/118',
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.action).toBe('tf:plan-target');
    expect(steps[0]?.args.resourceAddress).toBe('foo.bar');
    expect(steps[1]?.action).toBe('tf:import');
    expect(steps[1]?.args.gated).toBe(true);
  });

  it('output: single tf:output step', () => {
    const steps = buildPlans.output({ environment: ENV });
    expect(steps).toEqual([
      expect.objectContaining({ action: 'tf:output', args: { environment: ENV } }),
    ]);
  });

  it('stateList: single tf:state-list step', () => {
    const steps = buildPlans.stateList({ environment: ENV });
    expect(steps).toEqual([
      expect.objectContaining({ action: 'tf:state-list', args: { environment: ENV } }),
    ]);
  });

  it('rejects invalid -target= addresses early in apply', () => {
    expect(() =>
      buildPlans.apply({ environment: ENV, targets: ['rm -rf /'] }),
    ).toThrow(TerraformError);
  });

  it('rejects invalid resource_address in import', () => {
    expect(() =>
      buildPlans.import({
        environment: ENV,
        resource_address: 'bad address with spaces',
        resource_id: 'pve02/118',
      }),
    ).toThrow(TerraformError);
  });

  it('rejects invalid resource_id in import', () => {
    expect(() =>
      buildPlans.import({
        environment: ENV,
        resource_address: 'foo.bar',
        // backticks would be a shell injection vector
        resource_id: 'pve02/`whoami`',
      }),
    ).toThrow(TerraformError);
  });
});

// ─── Read-only mode executors ────────────────────────────────────

describe('executeTerraformStep — tf:plan', () => {
  it('runs terraform plan, parses summary from show-json, populates state.lastPlan', async () => {
    const { runner, calls } = scriptedRunner([
      // First call: terraform plan
      { match: 'plan -no-color -detailed-exitcode -out=tfplan', result: { stdout: SAMPLE_PLAN_STDOUT, exitCode: 2 } },
      // Second call: terraform show -json tfplan
      { match: 'show -json tfplan', result: { stdout: SAMPLE_PLAN_JSON, exitCode: 0 } },
    ]);

    const state = makeState();
    const step: TerraformStep = {
      title: 'plan',
      action: 'tf:plan',
      args: { environment: ENV },
    };
    const out = await executeTerraformStep(step, { runner, state });

    expect(state.lastPlan?.summary).toEqual({ add: 1, change: 1, destroy: 1 });
    expect(state.lastPlan?.planText).toContain('Plan: 1 to add');
    expect(state.lastPlan?.planJsonPath.endsWith(`/${TF_PLAN_FILE}`)).toBe(true);
    expect(out).toContain('Plan: +1/~1/-1');
    // Sanity: both terraform calls happened in the env cwd.
    expect(calls.every((c) => c.cwd.endsWith(`/${ENV}`))).toBe(true);
  });

  it('treats exit code 2 (changes present) as success, exit 1 as failure', async () => {
    const { runner } = scriptedRunner([
      { match: 'plan -no-color -detailed-exitcode -out=tfplan', result: { stderr: 'syntax error', exitCode: 1 } },
    ]);
    const step: TerraformStep = { title: 't', action: 'tf:plan', args: { environment: ENV } };
    await expect(executeTerraformStep(step, { runner, state: makeState() })).rejects.toThrow(/terraform plan failed/);
  });

  it('appends -target=ADDR for each target', async () => {
    const { runner, calls } = scriptedRunner([
      { match: 'plan -no-color', result: { stdout: SAMPLE_PLAN_STDOUT, exitCode: 0 } },
      { match: 'show -json tfplan', result: { stdout: SAMPLE_PLAN_JSON, exitCode: 0 } },
    ]);
    const step: TerraformStep = {
      title: 't',
      action: 'tf:plan',
      args: { environment: ENV, targets: ['foo.bar', 'baz.qux'] },
    };
    await executeTerraformStep(step, { runner, state: makeState() });
    const planCall = calls[0]!;
    expect(planCall.cmd).toContain('-target=foo.bar');
    expect(planCall.cmd).toContain('-target=baz.qux');
  });

  it('throws when terraform show -json emits unparsable JSON', async () => {
    const { runner } = scriptedRunner([
      { match: 'plan -no-color', result: { stdout: 'p', exitCode: 0 } },
      { match: 'show -json tfplan', result: { stdout: 'not-json{', exitCode: 0 } },
    ]);
    const step: TerraformStep = { title: 't', action: 'tf:plan', args: { environment: ENV } };
    await expect(executeTerraformStep(step, { runner, state: makeState() })).rejects.toThrow(/unparsable/);
  });
});

describe('executeTerraformStep — tf:output', () => {
  it('parses terraform output -json and populates state.lastOutputJson', async () => {
    const outputs = { ip: { value: '192.168.50.118', type: 'string' } };
    const { runner, calls } = scriptedRunner([
      { match: 'output -json', result: { stdout: JSON.stringify(outputs), exitCode: 0 } },
    ]);
    const state = makeState();
    const step: TerraformStep = {
      title: 'o',
      action: 'tf:output',
      args: { environment: ENV },
    };
    const out = await executeTerraformStep(step, { runner, state });
    expect(state.lastOutputJson).toEqual(outputs);
    expect(JSON.parse(out)).toEqual(outputs);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toContain('output');
    expect(calls[0]!.cmd).toContain('-json');
  });

  it('treats empty stdout as empty object', async () => {
    const { runner } = scriptedRunner([
      { match: 'output -json', result: { stdout: '', exitCode: 0 } },
    ]);
    const state = makeState();
    const step: TerraformStep = {
      title: 'o',
      action: 'tf:output',
      args: { environment: ENV },
    };
    await executeTerraformStep(step, { runner, state });
    expect(state.lastOutputJson).toEqual({});
  });

  it('fails when terraform output exits non-zero', async () => {
    const { runner } = scriptedRunner([
      { match: 'output -json', result: { stderr: 'not initialized', exitCode: 1 } },
    ]);
    const step: TerraformStep = { title: 'o', action: 'tf:output', args: { environment: ENV } };
    await expect(executeTerraformStep(step, { runner, state: makeState() })).rejects.toThrow(
      /terraform output failed/,
    );
  });
});

describe('executeTerraformStep — tf:state-list', () => {
  it('splits stdout lines and trims empties', async () => {
    const stdout = 'foo.bar\nbaz.qux\n  module.lxc.proxmox_virtual_environment_container.this  \n\n';
    const { runner } = scriptedRunner([
      { match: 'state list', result: { stdout, exitCode: 0 } },
    ]);
    const state = makeState();
    const step: TerraformStep = {
      title: 's',
      action: 'tf:state-list',
      args: { environment: ENV },
    };
    const out = await executeTerraformStep(step, { runner, state });
    expect(state.lastStateList).toEqual([
      'foo.bar',
      'baz.qux',
      'module.lxc.proxmox_virtual_environment_container.this',
    ]);
    expect(out).toContain('foo.bar');
  });

  it('returns "(empty)" when state has no resources', async () => {
    const { runner } = scriptedRunner([
      { match: 'state list', result: { stdout: '\n  \n', exitCode: 0 } },
    ]);
    const step: TerraformStep = {
      title: 's',
      action: 'tf:state-list',
      args: { environment: ENV },
    };
    const out = await executeTerraformStep(step, { runner, state: makeState() });
    expect(out).toBe('(empty)');
  });

  it('fails when terraform state list exits non-zero', async () => {
    const { runner } = scriptedRunner([
      { match: 'state list', result: { stderr: 'no state', exitCode: 1 } },
    ]);
    const step: TerraformStep = { title: 's', action: 'tf:state-list', args: { environment: ENV } };
    await expect(executeTerraformStep(step, { runner, state: makeState() })).rejects.toThrow();
  });
});

// ─── Gated mode executors ────────────────────────────────────────

function makePlanState(): TerraformStepState {
  return {
    lastPlan: {
      planText: SAMPLE_PLAN_STDOUT,
      summary: { add: 1, change: 1, destroy: 1 },
      planJsonPath: `/tmp/${TF_PLAN_FILE}`,
    },
  };
}

describe('executeTerraformStep — tf:apply (gated)', () => {
  it('proceed: runs terraform apply tfplan, captures stdout + state-list', async () => {
    const { runner, calls } = scriptedRunner([
      { match: 'apply -no-color -auto-approve tfplan', result: { stdout: 'Apply complete!', exitCode: 0 } },
      { match: 'state list', result: { stdout: 'foo.bar\nfoo.baz', exitCode: 0 } },
    ]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: true },
    };
    let capturedPreview: ApprovalPreview | undefined;
    const onBeforeStep = mock(async (input: { preview: ApprovalPreview; description: string; actionType: string }) => {
      capturedPreview = input.preview;
      return 'proceed' as GateDecision;
    });
    const out = await executeTerraformStep(step, { runner, state, onBeforeStep });

    expect(onBeforeStep).toHaveBeenCalledTimes(1);
    expect(capturedPreview).toEqual({
      type: 'tf-plan',
      planText: SAMPLE_PLAN_STDOUT,
      summary: { add: 1, change: 1, destroy: 1 },
    });
    expect(state.lastApplyOutput).toBe('Apply complete!');
    expect(state.lastStateList).toEqual(['foo.bar', 'foo.baz']);
    expect(out).toContain('Apply complete!');
    expect(out).toContain('[state list: 2 resources]');
    // First call must be apply, NOT plan — apply consumes the saved tfplan.
    expect(calls[0]!.cmd[0]).toBe(process.env.TERRAFORM_BIN ?? 'terraform');
    expect(calls[0]!.cmd).toContain('apply');
    expect(calls[0]!.cmd).toContain('tfplan');
  });

  it('skip: does not run apply, marks state.lastSkippedReason', async () => {
    const { runner, calls } = scriptedRunner([]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: true },
    };
    const onBeforeStep = mock(async () => 'skip' as GateDecision);
    const out = await executeTerraformStep(step, { runner, state, onBeforeStep });
    expect(out).toBe('Skipped by operator.');
    expect(state.lastSkippedReason).toBe('apply skipped');
    expect(state.lastApplyOutput).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('abort: marks state.aborted; subsequent steps short-circuit', async () => {
    const { runner, calls } = scriptedRunner([]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: true },
    };
    const onBeforeStep = mock(async () => 'abort' as GateDecision);
    const out = await executeTerraformStep(step, { runner, state, onBeforeStep });
    expect(out).toBe('Aborted by operator.');
    expect(state.aborted).toBe(true);
    expect(calls).toHaveLength(0);

    // Now feed the same state into another step — it should short-circuit.
    const followup: TerraformStep = {
      title: 'state',
      action: 'tf:state-list',
      args: { environment: ENV },
    };
    const out2 = await executeTerraformStep(followup, { runner, state });
    expect(out2).toContain('prior gated step aborted');
  });

  it('throws when no prior plan is captured in state', async () => {
    const { runner } = scriptedRunner([]);
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: true },
    };
    await expect(
      executeTerraformStep(step, {
        runner,
        state: makeState(),
        onBeforeStep: async () => 'proceed' as GateDecision,
      }),
    ).rejects.toThrow(/requires a prior tf:plan/);
  });

  it('throws when step.args.gated is false', async () => {
    const { runner } = scriptedRunner([]);
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: false },
    };
    await expect(
      executeTerraformStep(step, { runner, state: makePlanState() }),
    ).rejects.toThrow(/requires gated=true/);
  });

  it('treats apply non-zero exit as a hard failure', async () => {
    const { runner } = scriptedRunner([
      { match: 'apply -no-color -auto-approve tfplan', result: { stderr: 'apply failed!', exitCode: 1 } },
    ]);
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: true },
    };
    await expect(
      executeTerraformStep(step, {
        runner,
        state: makePlanState(),
        onBeforeStep: async () => 'proceed' as GateDecision,
      }),
    ).rejects.toThrow(/terraform apply failed/);
  });
});

describe('executeTerraformStep — tf:plan-destroy', () => {
  it('runs terraform plan -destroy and feeds same parser', async () => {
    const { runner, calls } = scriptedRunner([
      { match: 'plan -destroy -no-color', result: { stdout: 'destroy preview', exitCode: 2 } },
      { match: 'show -json tfplan', result: { stdout: SAMPLE_PLAN_JSON, exitCode: 0 } },
    ]);
    const state = makeState();
    const step: TerraformStep = {
      title: 't',
      action: 'tf:plan-destroy',
      args: { environment: ENV },
    };
    const out = await executeTerraformStep(step, { runner, state });
    expect(state.lastPlan?.summary).toEqual({ add: 1, change: 1, destroy: 1 });
    expect(out).toContain('(destroy)');
    expect(calls[0]!.cmd).toContain('-destroy');
  });
});

describe('executeTerraformStep — tf:import (gated)', () => {
  it('proceed: runs terraform import, captures stdout', async () => {
    const { runner, calls } = scriptedRunner([
      { match: 'import -no-color foo.bar pve02/118', result: { stdout: 'Import successful!', exitCode: 0 } },
    ]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'import',
      action: 'tf:import',
      args: {
        environment: ENV,
        resourceAddress: 'foo.bar',
        resourceId: 'pve02/118',
        gated: true,
      },
    };
    const onBeforeStep = mock(async (input: { actionType: string; description: string }) => {
      expect(input.actionType).toBe('deploy');
      expect(input.description).toContain('Import foo.bar');
      expect(input.description).toContain('pve02/118');
      return 'proceed' as GateDecision;
    });
    const out = await executeTerraformStep(step, { runner, state, onBeforeStep });
    expect(state.lastImportOutput).toBe('Import successful!');
    expect(out).toBe('Import successful!');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual([
      process.env.TERRAFORM_BIN ?? 'terraform',
      'import',
      '-no-color',
      'foo.bar',
      'pve02/118',
    ]);
  });

  it('skip: leaves state.lastImportOutput unset', async () => {
    const { runner, calls } = scriptedRunner([]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'import',
      action: 'tf:import',
      args: {
        environment: ENV,
        resourceAddress: 'foo.bar',
        resourceId: 'pve02/118',
        gated: true,
      },
    };
    const onBeforeStep = mock(async () => 'skip' as GateDecision);
    const out = await executeTerraformStep(step, { runner, state, onBeforeStep });
    expect(out).toBe('Skipped by operator.');
    expect(state.lastImportOutput).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('abort: marks state.aborted', async () => {
    const { runner, calls } = scriptedRunner([]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'import',
      action: 'tf:import',
      args: {
        environment: ENV,
        resourceAddress: 'foo.bar',
        resourceId: 'pve02/118',
        gated: true,
      },
    };
    const onBeforeStep = mock(async () => 'abort' as GateDecision);
    const out = await executeTerraformStep(step, { runner, state, onBeforeStep });
    expect(out).toBe('Aborted by operator.');
    expect(state.aborted).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects when resourceAddress or resourceId is missing on the step', async () => {
    const { runner } = scriptedRunner([]);
    const step: TerraformStep = {
      title: 'import',
      action: 'tf:import',
      args: { environment: ENV, gated: true },
    };
    await expect(
      executeTerraformStep(step, {
        runner,
        state: makePlanState(),
        onBeforeStep: async () => 'proceed' as GateDecision,
      }),
    ).rejects.toThrow(/resourceAddress and resourceId/);
  });
});

describe('executeTerraformStep — wiring', () => {
  it('uses defaultCommandRunner when none provided, but never reached due to no real terraform', async () => {
    // We intentionally don't call this branch — defaultCommandRunner would
    // try to spawn `terraform` and we MUST NOT hit the real binary in tests.
    // This test exists purely as a documented anchor for that contract.
    expect(typeof executeTerraformStep).toBe('function');
  });

  it('throws on unknown action', async () => {
    const { runner } = scriptedRunner([]);
    const step = {
      title: 'bogus',
      action: 'tf:nope' as unknown as 'tf:plan',
      args: { environment: ENV },
    };
    await expect(
      executeTerraformStep(step, { runner, state: makeState() }),
    ).rejects.toThrow();
  });

  it('auto-proceeds when no onBeforeStep hook is wired (escape hatch)', async () => {
    // This exercises the `if (!hook)` branch. Used by tests / one-off CLI
    // runs where the caller has already approved via human intervention.
    const { runner } = scriptedRunner([
      { match: 'apply -no-color -auto-approve tfplan', result: { stdout: 'ok', exitCode: 0 } },
      { match: 'state list', result: { stdout: '', exitCode: 0 } },
    ]);
    const state = makePlanState();
    const step: TerraformStep = {
      title: 'apply',
      action: 'tf:apply',
      args: { environment: ENV, gated: true },
    };
    const out = await executeTerraformStep(step, { runner, state });
    expect(out).toContain('ok');
  });
});

// ─── Cleanup any env mutation between tests (none today) ─────────

beforeEach(() => {
  // No-op anchor for future state-bleed protection.
});
afterEach(() => {
  mock.restore();
});
