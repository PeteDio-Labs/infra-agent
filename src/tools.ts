/**
 * Tool definitions for the infra-agent Gemma 4 loop.
 * Each tool wraps an Ansible or Proxmox operation and returns a string result.
 */

import type { ToolDef } from '@petedio/shared/agents';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

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

export function buildTools(gated: boolean, mcBackendUrl: string): ToolDef[] {
  const tools: ToolDef[] = [
    // ── Always allowed ────────────────────────────────────────────

    {
      name: 'list_playbooks',
      description: 'List all Ansible playbooks available in the playbooks directory',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        try {
          const files = readdirSync(PLAYBOOKS_DIR).filter(f => f.endsWith('.yml'));
          if (files.length === 0) return 'No playbooks found in ' + PLAYBOOKS_DIR;
          return `Playbooks (${files.length}):\n${files.join('\n')}`;
        } catch (err) {
          return `Failed to list playbooks: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'read_playbook',
      description: 'Read the contents of an Ansible playbook file',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Playbook filename (e.g. deploy-local-agents.yml). Must match /^[\\w-]+\\.yml$/',
          },
        },
        required: ['name'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { name: string };
        if (!PLAYBOOK_NAME_RE.test(args.name)) {
          return `Invalid playbook name: "${args.name}". Must match /^[\\w-]+\\.yml$/`;
        }
        const filePath = join(PLAYBOOKS_DIR, args.name);
        try {
          const content = readFileSync(filePath, 'utf-8');
          return content;
        } catch (err) {
          return `Failed to read playbook: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'get_inventory',
      description: 'Read the Ansible inventory hosts.yml file',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        try {
          const content = readFileSync(INVENTORY_FILE, 'utf-8');
          return content;
        } catch (err) {
          return `Failed to read inventory: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'dry_run_playbook',
      description: 'Dry-run an Ansible playbook with --check --diff to preview changes without applying them',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Playbook filename (e.g. deploy-local-agents.yml). Must match /^[\\w-]+\\.yml$/',
          },
          extra_vars: {
            type: 'string',
            description: 'Optional extra vars string passed to --extra-vars',
          },
        },
        required: ['name'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { name: string; extra_vars?: string };
        if (!PLAYBOOK_NAME_RE.test(args.name)) {
          return `Invalid playbook name: "${args.name}". Must match /^[\\w-]+\\.yml$/`;
        }
        const playbookPath = join(PLAYBOOKS_DIR, args.name);
        const cmd = [
          'ansible-playbook',
          '-i', INVENTORY_FILE,
          '--check',
          '--diff',
          playbookPath,
        ];
        if (args.extra_vars) cmd.push('--extra-vars', args.extra_vars);

        const { stdout, stderr, exitCode } = await spawnCapture(cmd, 120_000);
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        return `Exit code: ${exitCode}\n${output || '(no output)'}`;
      },
    },

    {
      name: 'check_proxmox_capacity',
      description: 'Get CPU% and memory% usage per Proxmox node to assess available capacity',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        try {
          const res = await fetch(`${mcBackendUrl}/api/v1/infrastructure/proxmox`);
          if (!res.ok) return `Proxmox API error: HTTP ${res.status}`;
          const data = await res.json() as { nodes?: Array<{ node: string; status: string; cpu: number; mem: number; maxmem: number }> };
          const nodes = data.nodes ?? (Array.isArray(data) ? data : []);
          if (!nodes.length) return 'No Proxmox nodes found';
          return nodes.map((n: { node: string; status: string; cpu: number; mem: number; maxmem: number }) => {
            const cpu = `${(n.cpu * 100).toFixed(1)}%`;
            const mem = `${((n.mem / n.maxmem) * 100).toFixed(1)}%`;
            return `${n.node}: status=${n.status}, cpu=${cpu}, mem=${mem}`;
          }).join('\n');
        } catch (err) {
          return `Failed to check Proxmox capacity: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];

  // ── Gated only ────────────────────────────────────────────────

  if (gated) {
    tools.push(
      {
        name: 'run_playbook',
        description: 'Run an Ansible playbook (applies changes). Only available in gated mode. Blocked for teardown/destroy/delete/nuke playbooks.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Playbook filename (e.g. deploy-local-agents.yml). Must match /^[\\w-]+\\.yml$/',
            },
            extra_vars: {
              type: 'string',
              description: 'Optional extra vars string passed to --extra-vars',
            },
          },
          required: ['name'],
        },
        async execute(rawArgs) {
          const args = rawArgs as { name: string; extra_vars?: string };
          if (!PLAYBOOK_NAME_RE.test(args.name)) {
            return `Invalid playbook name: "${args.name}". Must match /^[\\w-]+\\.yml$/`;
          }
          if (DESTRUCTIVE_RE.test(args.name)) {
            return `Blocked: playbook name "${args.name}" matches destructive pattern (teardown|destroy|delete|nuke). Refusing to run.`;
          }
          const playbookPath = join(PLAYBOOKS_DIR, args.name);
          const cmd = [
            'ansible-playbook',
            '-i', INVENTORY_FILE,
            playbookPath,
          ];
          if (args.extra_vars) cmd.push('--extra-vars', args.extra_vars);

          const { stdout, stderr, exitCode } = await spawnCapture(cmd, 300_000);
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          return `Exit code: ${exitCode}\n${output || '(no output)'}`;
        },
      },

      {
        name: 'get_proxmox_vms',
        description: 'List all VMs and LXC containers across Proxmox nodes with their status and resource allocation',
        parameters: {
          type: 'object',
          properties: {},
        },
        async execute() {
          try {
            const res = await fetch(`${mcBackendUrl}/api/v1/infrastructure/proxmox/vms`);
            if (!res.ok) return `Proxmox VMs API error: HTTP ${res.status}`;
            const data = await res.json();
            return JSON.stringify(data, null, 2);
          } catch (err) {
            return `Failed to get Proxmox VMs: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
    );
  }

  return tools;
}
