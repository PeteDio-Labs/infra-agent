import { z } from 'zod';

export const InfraAgentInputSchema = z.object({
  mode: z.enum([
    'list-playbooks',
    'read-playbook',
    'get-inventory',
    'dry-run-playbook',
    'run-playbook',
    'check-capacity',
    'list-vms',
  ]).default('check-capacity')
    .describe('Deterministic infrastructure action to execute'),
  task: z.string().optional()
    .describe('Legacy freeform task text. Retained for compatibility but not used by deterministic modes'),
  playbook: z.string().optional()
    .describe('Playbook filename for read-playbook, dry-run-playbook, or run-playbook'),
  extraVars: z.string().optional()
    .describe('Optional --extra-vars string for playbook execution'),
  gated: z.boolean().default(false)
    .describe('Whether destructive/write operations are permitted'),
}).superRefine((input, ctx) => {
  if ((input.mode === 'read-playbook' || input.mode === 'dry-run-playbook' || input.mode === 'run-playbook') && !input.playbook) {
    ctx.addIssue({ code: 'custom', message: `${input.mode} requires playbook` });
  }
});

export type InfraAgentInput = z.infer<typeof InfraAgentInputSchema>;
