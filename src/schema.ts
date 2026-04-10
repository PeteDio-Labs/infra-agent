import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const InfraAgentInputSchema = z.object({
  task: z.string().describe('Description of the infrastructure task to perform'),
  gated: z.boolean().default(false)
    .describe('Whether destructive/write operations are permitted'),
});

export type InfraAgentInput = z.infer<typeof InfraAgentInputSchema>;

// TaskPayload.input typed as InfraAgentInput
export const InfraTaskPayloadSchema = TaskPayloadSchema.extend({
  input: InfraAgentInputSchema,
});
