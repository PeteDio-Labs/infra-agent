import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { InfraAgentInputSchema } from './schema.js';
import { buildPlan, executeStep, formatReport, type InfraStep, type InfraStepLog } from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3009', 10);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const SHARED_AGENTS_MODULE_PATH = process.env.SHARED_AGENTS_MODULE_PATH ?? '@petedio/shared/agents';

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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'infra-agent', sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH });
});

app.listen(PORT, () => {
  log.info({ port: PORT, sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH }, 'infra-agent listening');
});
