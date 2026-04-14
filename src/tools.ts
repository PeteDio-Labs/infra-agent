import type { z } from 'zod';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { InfraAgentInput, InfraAgentInputSchema } from './schema.js';

export type InfraAction = z.infer<typeof InfraAgentInputSchema>['mode'];

export interface InfraStep {
  title: string;
  action: InfraAction;
  args?: Record<string, unknown>;
}

export interface InfraStepLog {
  step: InfraStep;
  status: 'complete' | 'failed';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

const ANSIBLE_BASE = '/home/pedro/PeteDio-Labs/infrastructure/ansible';
const PLAYBOOKS_DIR = join(ANSIBLE_BASE, 'playbooks');
const INVENTORY_FILE = join(ANSIBLE_BASE, 'inventory/hosts.yml');
const SPAWN_CWD = '/home/pedro/PeteDio-Labs';

const PLAYBOOK_NAME_RE = /^[\w-]+\.yml$/;
const DESTRUCTIVE_RE = /teardown|destroy|delete|nuke/i;

async function spawnCapture(
  cmd: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: SPAWN_CWD,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

function validatePlaybookName(name: string): string | null {
  if (!PLAYBOOK_NAME_RE.test(name)) {
    return `Invalid playbook name: "${name}". Must match /^[\\w-]+\\.yml$/`;
  }
  return null;
}

function formatCommandResult(result: { stdout: string; stderr: string; exitCode: number }): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return `Exit code: ${result.exitCode}\n${output || '(no output)'}`;
}

export function buildPlan(input: InfraAgentInput): InfraStep[] {
  switch (input.mode) {
    case 'list-playbooks':
      return [{ title: 'List Ansible playbooks', action: 'list-playbooks' }];
    case 'read-playbook':
      return [{ title: `Read ${input.playbook}`, action: 'read-playbook', args: { playbook: input.playbook } }];
    case 'get-inventory':
      return [{ title: 'Read Ansible inventory', action: 'get-inventory' }];
    case 'dry-run-playbook':
      return [{ title: `Dry-run ${input.playbook}`, action: 'dry-run-playbook', args: { playbook: input.playbook, extraVars: input.extraVars } }];
    case 'run-playbook':
      return [
        { title: `Dry-run ${input.playbook}`, action: 'dry-run-playbook', args: { playbook: input.playbook, extraVars: input.extraVars } },
        { title: `Run ${input.playbook}`, action: 'run-playbook', args: { playbook: input.playbook, extraVars: input.extraVars } },
      ];
    case 'list-vms':
      return [{ title: 'List Proxmox VMs', action: 'list-vms' }];
    case 'check-capacity':
    default:
      return [{ title: 'Check Proxmox capacity', action: 'check-capacity' }];
  }
}

export async function executeStep(step: InfraStep, opts: { gated: boolean; mcBackendUrl: string }): Promise<string> {
  const { gated, mcBackendUrl } = opts;

  switch (step.action) {
    case 'list-playbooks': {
      const files = readdirSync(PLAYBOOKS_DIR).filter(f => f.endsWith('.yml'));
      if (files.length === 0) return 'No playbooks found in ' + PLAYBOOKS_DIR;
      return `Playbooks (${files.length}):\n${files.join('\n')}`;
    }
    case 'read-playbook': {
      const name = String(step.args?.playbook ?? '');
      const invalid = validatePlaybookName(name);
      if (invalid) return invalid;
      return readFileSync(join(PLAYBOOKS_DIR, name), 'utf-8');
    }
    case 'get-inventory':
      return readFileSync(INVENTORY_FILE, 'utf-8');
    case 'dry-run-playbook': {
      const name = String(step.args?.playbook ?? '');
      const invalid = validatePlaybookName(name);
      if (invalid) return invalid;
      const cmd = ['ansible-playbook', '-i', INVENTORY_FILE, '--check', '--diff', join(PLAYBOOKS_DIR, name)];
      const extraVars = step.args?.extraVars;
      if (typeof extraVars === 'string' && extraVars.length > 0) cmd.push('--extra-vars', extraVars);
      return formatCommandResult(await spawnCapture(cmd, 120_000));
    }
    case 'run-playbook': {
      if (!gated) throw new Error('run-playbook requires gated=true');
      const name = String(step.args?.playbook ?? '');
      const invalid = validatePlaybookName(name);
      if (invalid) return invalid;
      if (DESTRUCTIVE_RE.test(name)) {
        return `Blocked: playbook name "${name}" matches destructive pattern (teardown|destroy|delete|nuke). Refusing to run.`;
      }
      const cmd = ['ansible-playbook', '-i', INVENTORY_FILE, join(PLAYBOOKS_DIR, name)];
      const extraVars = step.args?.extraVars;
      if (typeof extraVars === 'string' && extraVars.length > 0) cmd.push('--extra-vars', extraVars);
      return formatCommandResult(await spawnCapture(cmd, 300_000));
    }
    case 'check-capacity': {
      const res = await fetch(`${mcBackendUrl}/api/v1/infrastructure/proxmox`);
      if (!res.ok) return `Proxmox API error: HTTP ${res.status}`;
      const data = await res.json() as { nodes?: Array<{ node: string; status: string; cpu: number; mem: number; maxmem: number }> };
      const nodes = data.nodes ?? (Array.isArray(data) ? data : []);
      if (!nodes.length) return 'No Proxmox nodes found';
      return nodes.map((n) => {
        const cpu = `${(n.cpu * 100).toFixed(1)}%`;
        const mem = `${((n.mem / n.maxmem) * 100).toFixed(1)}%`;
        return `${n.node}: status=${n.status}, cpu=${cpu}, mem=${mem}`;
      }).join('\n');
    }
    case 'list-vms': {
      const res = await fetch(`${mcBackendUrl}/api/v1/infrastructure/proxmox/vms`);
      if (!res.ok) return `Proxmox VMs API error: HTTP ${res.status}`;
      const data = await res.json();
      return JSON.stringify(data, null, 2);
    }
  }
}

export function formatReport(logs: InfraStepLog[]): string {
  if (logs.length === 0) return 'No steps executed.';
  return logs.map((log, index) => {
    const lines = [
      `${index + 1}. ${log.step.title} [${log.status}]`,
      `action: ${log.step.action}`,
      `duration: ${log.durationMs}ms`,
    ];
    if (log.output) {
      lines.push('output:');
      lines.push(log.output);
    }
    return lines.join('\n');
  }).join('\n\n');
}
