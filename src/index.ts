/**
 * infra-agent — Infrastructure automation agent.
 *
 * Accepts a TaskPayload from MC Backend, runs a Gemma 4 tool-calling loop
 * over Ansible playbooks and Proxmox capacity, produces a result report,
 * and reports back to MC.
 *
 * Also exposes an Express HTTP server so MC Backend can POST tasks.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { AgentReporter, runToolLoop } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { InfraAgentInputSchema } from './schema.js';
import { buildTools } from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3009', 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.50.59:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';

// ─── Agent Logic ─────────────────────────────────────────────────

async function runInfraTask(payload: z.infer<typeof TaskPayloadSchema>): Promise<void> {
  const startMs = Date.now();
  const input = InfraAgentInputSchema.parse(payload.input);

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'infra-agent',
  });

  await reporter.running('Processing infrastructure task...');
  log.info({ taskId: payload.taskId, input }, 'infra-agent starting');

  const gateNote = input.gated
    ? 'Gated mode is ENABLED — write and destructive operations are permitted (except teardown/destroy/delete/nuke playbooks).'
    : 'Gated mode is DISABLED — only read-only and dry-run operations are permitted.';

  const userPrompt = `
Task: ${input.task}

${gateNote}

Instructions:
1. Use the available tools to understand the current infrastructure state
2. For any playbook execution, always dry-run first to preview changes
3. If gated mode is enabled and changes are safe, proceed with run_playbook
4. Produce a concise report with:
   - Actions taken (tools called, playbooks run)
   - Results and any errors encountered
   - Current infrastructure state (capacity, relevant VMs)
   - Recommended next steps if the task is incomplete

Always dry-run before executing. Never run destructive playbooks.
`.trim();

  try {
    const { finalResponse, toolCallLog, iterations } = await runToolLoop({
      ollamaUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      system: 'You are an infrastructure automation agent. You manage Ansible playbooks and monitor Proxmox capacity. For destructive operations, only proceed if gated mode is enabled. Always dry-run before executing.',
      userPrompt,
      tools: buildTools(input.gated, MC_BACKEND_URL),
      onIteration: (i, content) => {
        if (content) log.info({ taskId: payload.taskId, iteration: i }, 'loop response');
      },
    });

    const durationMs = Date.now() - startMs;
    log.info({ taskId: payload.taskId, iterations, durationMs }, 'infra task complete');

    const toolSummary = toolCallLog.length > 0
      ? `\n\n---\n**Tools used:** ${[...new Set(toolCallLog.map(t => t.tool))].join(', ')}`
      : '';

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'infra-agent',
      status: 'complete',
      summary: firstLine(finalResponse),
      artifacts: [
        {
          type: 'log',
          label: 'Infrastructure Task Report',
          content: finalResponse + toolSummary,
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

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim().length > 0) ?? text.slice(0, 100);
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

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
  res.json({ status: 'ok', agent: 'infra-agent', model: OLLAMA_MODEL });
});

app.listen(PORT, () => {
  log.info({ port: PORT, model: OLLAMA_MODEL }, 'infra-agent listening');
});
