import { z } from 'zod';

const RESOURCE_ADDR_RE = /^[A-Za-z_][\w.\-[\]"']*$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_./:-]+$/;
const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export const InfraAgentInputSchema = z.object({
  mode: z.enum([
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
    // ─── Terraform modes (Phase G) ─────────────────────────────────
    'tf:plan',
    'tf:output',
    'tf:state-list',
    'tf:apply',
    'tf:destroy',
    'tf:import',
  ]).default('check-capacity')
    .describe('Deterministic infrastructure action to execute'),
  task: z.string().optional()
    .describe('Legacy freeform task text. Retained for compatibility but not used by deterministic modes'),
  playbook: z.string().optional()
    .describe('Playbook filename for read-playbook, dry-run-playbook, or run-playbook'),
  extraVars: z.string().optional()
    .describe('Optional --extra-vars string for playbook execution'),
  tags: z.string().regex(/^[\w,-]+$/, 'tags must match /^[\\w,-]+$/').optional()
    .describe('Optional --tags string for playbook execution. Comma-separated, alphanumeric/dash/underscore only'),
  gated: z.boolean().default(false)
    .describe('Whether destructive/write operations are permitted'),

  // ─── Terraform-mode inputs ───────────────────────────────────────
  environment: z.string().regex(ENV_NAME_RE, 'environment must match /^[a-z0-9][a-z0-9_-]*$/i').optional()
    .describe('Terraform environment directory under infrastructure/terraform/environments/'),
  targets: z.array(z.string().regex(RESOURCE_ADDR_RE, 'target must be a valid HCL address')).optional()
    .describe('Optional -target=ADDR list for tf:plan / tf:apply / tf:destroy'),
  resource_address: z.string().regex(RESOURCE_ADDR_RE, 'resource_address must be a valid HCL address').optional()
    .describe('HCL resource address for tf:import (e.g. proxmox_virtual_environment_container.job_hunt)'),
  resource_id: z.string().regex(RESOURCE_ID_RE, 'resource_id contains forbidden characters').optional()
    .describe('Provider-side identifier for tf:import (e.g. pve02/118)'),
}).superRefine((input, ctx) => {
  if ((input.mode === 'read-playbook' || input.mode === 'dry-run-playbook' || input.mode === 'run-playbook') && !input.playbook) {
    ctx.addIssue({ code: 'custom', message: `${input.mode} requires playbook` });
  }

  // Terraform mode validation — every TF mode requires `environment`; tf:import
  // additionally requires resource_address + resource_id.
  if (input.mode.startsWith('tf:')) {
    if (!input.environment) {
      ctx.addIssue({ code: 'custom', message: `${input.mode} requires environment` });
    }
    if (input.mode === 'tf:import') {
      if (!input.resource_address) {
        ctx.addIssue({ code: 'custom', message: 'tf:import requires resource_address' });
      }
      if (!input.resource_id) {
        ctx.addIssue({ code: 'custom', message: 'tf:import requires resource_id' });
      }
    }
  }
});

export type InfraAgentInput = z.infer<typeof InfraAgentInputSchema>;

export type TerraformMode =
  | 'tf:plan'
  | 'tf:output'
  | 'tf:state-list'
  | 'tf:apply'
  | 'tf:destroy'
  | 'tf:import';

export const TERRAFORM_MODES: readonly TerraformMode[] = [
  'tf:plan',
  'tf:output',
  'tf:state-list',
  'tf:apply',
  'tf:destroy',
  'tf:import',
] as const;

export function isTerraformMode(mode: string): mode is TerraformMode {
  return (TERRAFORM_MODES as readonly string[]).includes(mode);
}
