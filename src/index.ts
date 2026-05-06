import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { InfraAgentInputSchema, TERRAFORM_MODES, isTerraformMode } from './schema.js';
import { buildPlan, executeStep, formatReport, type InfraStep, type InfraStepLog } from './tools.js';
import {
  buildPlans,
  executeTerraformStep,
  type TerraformStep,
  type TerraformStepState,
} from './runbooks/terraform.js';
import type { ApprovalPreview, GateDecision } from './runbooks/types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3009', 10);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const SHARED_AGENTS_MODULE_PATH = process.env.SHARED_AGENTS_MODULE_PATH ?? '@petedio/shared/agents';

const APPROVAL_POLL_INTERVAL_MS = 3_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

interface SharedAgentReporter {
  running(message: string): Promise<void>;
  complete(result: {
    taskId: string;
    agentName: string;
    status: 'complete';
    summary: string;
    artifacts: Array<{ type: 'log'; label: string; content: string }>;
    durationMs: number;
    completedAt: string;
  }): Promise<void>;
  fail(message: string): Promise<void>;
}

interface SharedAgentsModule {
  AgentReporter: new (opts: { mcUrl: string; taskId: string; agentName: string }) => SharedAgentReporter;
  TaskPayloadSchema: z.ZodType<{
    taskId: string;
    agentName: string;
    trigger: string;
    input: Record<string, unknown>;
    issuedAt: string;
  }>;
  runDeterministicPlan: (opts: {
    steps: InfraStep[];
    executeStep: (step: InfraStep) => Promise<string>;
    onStepStart?: (step: InfraStep, index: number) => void | Promise<void>;
    stopOnError?: boolean;
  }) => Promise<{
    status: 'complete' | 'failed';
    logs: InfraStepLog[];
    completedSteps: number;
    failedStep?: InfraStepLog;
  }>;
}

async function loadSharedAgents(): Promise<SharedAgentsModule> {
  return import(SHARED_AGENTS_MODULE_PATH) as Promise<SharedAgentsModule>;
}

// ─── Agent Logic ─────────────────────────────────────────────────

async function runInfraTask(payload: { taskId: string; input: Record<string, unknown> }): Promise<void> {
  const startMs = Date.now();
  const input = InfraAgentInputSchema.parse(payload.input);
  const shared = await loadSharedAgents();
  const { AgentReporter, runDeterministicPlan } = shared;

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'infra-agent',
  });

  await reporter.running(`Processing infrastructure task (${input.mode})...`);
  log.info({ taskId: payload.taskId, input }, 'infra-agent starting');

  // Terraform modes have their own runbook + step shape, so route them
  // separately rather than threading TF args through the legacy InfraStep
  // contract used by Ansible playbooks.
  if (isTerraformMode(input.mode)) {
    await runTerraformTask(payload.taskId, input, reporter, startMs);
    return;
  }

  const steps = buildPlan(input);

  try {
    const result = await runDeterministicPlan({
      steps,
      executeStep: (step) => executeStep(step, { gated: input.gated, mcBackendUrl: MC_BACKEND_URL }),
      onStepStart: async (step, index) => {
        await reporter.running(`Step ${index + 1}/${steps.length}: ${step.title}`);
      },
    });

    const durationMs = Date.now() - startMs;
    const report = formatReport(result.logs);
    const summary = result.failedStep
      ? `Failed at ${result.failedStep.step.title}`
      : `Completed ${result.completedSteps} infrastructure step(s)`;
    log.info({ taskId: payload.taskId, durationMs, steps: result.logs.length, status: result.status }, 'infra task complete');

    if (result.status === 'failed') {
      await reporter.fail(`${summary}\n\n${report}`);
      return;
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'infra-agent',
      status: 'complete',
      summary,
      artifacts: [
        {
          type: 'log',
          label: 'Infrastructure Task Report',
          content: report,
        },
      ],
      durationMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'infra task failed');
    await reporter.fail(msg);
  }
}

// ─── Terraform task runner ───────────────────────────────────────

interface TerraformStepLog {
  step: TerraformStep;
  status: 'complete' | 'failed';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

function buildTerraformSteps(input: z.infer<typeof InfraAgentInputSchema>): TerraformStep[] {
  // Schema's superRefine has already enforced these are present for TF modes.
  const environment = input.environment!;
  const targets = input.targets;

  switch (input.mode) {
    case 'tf:plan':
      return buildPlans.plan({ environment, targets });
    case 'tf:apply':
      return buildPlans.apply({ environment, targets });
    case 'tf:destroy':
      return buildPlans.destroy({ environment, targets });
    case 'tf:import':
      return buildPlans.import({
        environment,
        resource_address: input.resource_address!,
        resource_id: input.resource_id!,
      });
    case 'tf:output':
      return buildPlans.output({ environment });
    case 'tf:state-list':
      return buildPlans.stateList({ environment });
    default:
      throw new Error(`Unhandled terraform mode: ${input.mode}`);
  }
}

async function runTerraformTask(
  taskId: string,
  input: z.infer<typeof InfraAgentInputSchema>,
  reporter: SharedAgentReporter,
  startMs: number,
): Promise<void> {
  const steps = buildTerraformSteps(input);
  const state: TerraformStepState = {};
  const logs: TerraformStepLog[] = [];

  // Gate hook: post a structured pending_approval to MC and poll for the
  // operator's decision. Bypasses the typed reporter because the v1.1.0
  // shared schema constrains preview to string; here we want the structured
  // ApprovalPreview shape that MC Phase 2.4 will render directly.
  const onBeforeStep = async (args: {
    preview: ApprovalPreview;
    description: string;
    actionType: string;
  }): Promise<GateDecision> => {
    const outcome = await requestStructuredApproval(taskId, args);
    if (outcome === 'approved') return 'proceed';
    if (outcome === 'rejected') return 'abort';
    return 'skip';
  };

  for (const [index, step] of steps.entries()) {
    await reporter.running(`Step ${index + 1}/${steps.length}: ${step.title}`);
    const startedAt = new Date().toISOString();
    const sm = Date.now();

    try {
      const output = await executeTerraformStep(step, {
        state,
        onBeforeStep: step.args.gated ? onBeforeStep : undefined,
      });
      logs.push({
        step,
        status: 'complete',
        output,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - sm,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push({
        step,
        status: 'failed',
        output: msg,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - sm,
      });
      const durationMs = Date.now() - startMs;
      log.error({ taskId, err: msg, mode: input.mode }, 'terraform task failed');
      await reporter.fail(`Failed at ${step.title}\n\n${formatTerraformReport(logs)}\n[duration: ${durationMs}ms]`);
      return;
    }

    if (state.aborted) {
      // Operator rejected — surface as a failure so MC reflects waiting_approval → failed.
      const durationMs = Date.now() - startMs;
      await reporter.fail(`Aborted by operator at ${step.title}\n\n${formatTerraformReport(logs)}\n[duration: ${durationMs}ms]`);
      return;
    }
  }

  const durationMs = Date.now() - startMs;
  const report = formatTerraformReport(logs);
  const summary = buildTerraformSummary(input.mode, state, logs.length);
  log.info({ taskId, durationMs, steps: logs.length, mode: input.mode }, 'terraform task complete');

  await reporter.complete({
    taskId,
    agentName: 'infra-agent',
    status: 'complete',
    summary,
    artifacts: [
      {
        type: 'log',
        label: 'Terraform Task Report',
        content: report,
      },
    ],
    durationMs,
    completedAt: new Date().toISOString(),
  });
}

function formatTerraformReport(logs: TerraformStepLog[]): string {
  if (logs.length === 0) return 'No terraform steps executed.';
  return logs
    .map((entry, index) => {
      const lines = [
        `${index + 1}. ${entry.step.title} [${entry.status}]`,
        `action: ${entry.step.action}`,
        `duration: ${entry.durationMs}ms`,
        'output:',
        entry.output,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildTerraformSummary(
  mode: string,
  state: TerraformStepState,
  stepCount: number,
): string {
  if (state.lastSkippedReason) return `Skipped: ${state.lastSkippedReason}`;
  if (mode === 'tf:apply' || mode === 'tf:destroy') {
    const list = state.lastStateList?.length ?? 0;
    if (state.lastApplyOutput) return `Applied ${stepCount} step(s); state has ${list} resources.`;
  }
  if (mode === 'tf:import' && state.lastImportOutput) {
    return `Imported resource into state.`;
  }
  if (mode === 'tf:output' && state.lastOutputJson) {
    const keys = Object.keys(state.lastOutputJson).length;
    return `Read ${keys} output(s).`;
  }
  if (mode === 'tf:state-list' && state.lastStateList) {
    return `Listed ${state.lastStateList.length} state resource(s).`;
  }
  if (mode === 'tf:plan' && state.lastPlan) {
    const s = state.lastPlan.summary;
    return `Plan: +${s.add}/~${s.change}/-${s.destroy}`;
  }
  return `Completed ${stepCount} terraform step(s).`;
}

/**
 * Posts a structured-preview waiting_approval to MC and polls for the
 * approve/reject outcome. Returns 'approved' | 'rejected' | 'timeout'.
 *
 * Uses raw fetch rather than reporter.requestApproval so the preview can be
 * a structured ApprovalPreview object — the v1.1.0 shared schema constrains
 * the typed surface to `preview: string`. MC's pending_approval column is
 * JSONB, so the structured object is stored faithfully; downstream MC
 * Phase 2.4 work will widen the validation schema to match.
 */
async function requestStructuredApproval(
  taskId: string,
  args: { preview: ApprovalPreview; description: string; actionType: string },
): Promise<'approved' | 'rejected' | 'timeout'> {
  const statusBody = {
    taskId,
    agentName: 'infra-agent',
    status: 'waiting_approval',
    message: args.description,
    requiresApproval: {
      actionType: args.actionType,
      description: args.description,
      preview: args.preview,
    },
    updatedAt: new Date().toISOString(),
  };

  // Best-effort post; MC may reject the schema today but the column is JSONB.
  try {
    await fetch(`${MC_BACKEND_URL}/api/v1/agents/${taskId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statusBody),
      signal: AbortSignal.timeout(5_000),
    });
    await fetch(`${MC_BACKEND_URL}/api/v1/agents/${taskId}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        agentName: 'infra-agent',
        action: statusBody.requiresApproval,
        requestedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    log.warn({ taskId, err: (err as Error).message }, 'approval request post failed (continuing to poll)');
  }

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/${taskId}/approval`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { outcome?: string };
        if (data.outcome === 'approved') return 'approved';
        if (data.outcome === 'rejected') return 'rejected';
      }
    } catch {
      // Keep polling.
    }
  }
  return 'timeout';
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());
const shared = await loadSharedAgents();
const { TaskPayloadSchema } = shared;

// MC Backend POSTs here to dispatch a task
app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  res.json({ accepted: true, taskId: parsed.data.taskId });

  // Run async — don't await (MC doesn't wait for completion)
  runInfraTask(parsed.data).catch(err => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled infra task error');
  });
});

// Mode list mirrors the schema enum — useful for `curl /health` smoke checks
// and for the MC frontend to discover what the agent can do.
const ALL_MODES = [
  'health-check',
  'list-playbooks',
  'read-playbook',
  'get-inventory',
  'deploy-local-agents',
  'sync-ollama-models',
  'update-ollama-service',
  'verify-cloudflare-tunnel',
  'cloudflare-tunnel-routes',
  'cloudflare-tunnel-dns',
  'cloudflare-tunnel-dns-cleanup',
  'cloudflare-tunnel-verify',
  'cloudflare-tunnel-connector',
  'dry-run-playbook',
  'run-playbook',
  'check-capacity',
  'list-vms',
  ...TERRAFORM_MODES,
];

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agent: 'infra-agent',
    sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH,
    modes: ALL_MODES,
    modeCount: ALL_MODES.length,
  });
});

app.listen(PORT, () => {
  log.info({ port: PORT, sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH }, 'infra-agent listening');
});
