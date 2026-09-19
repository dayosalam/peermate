import { z } from 'zod'

export const DeletionStep = z.enum([
  'outbox',
  'renders',
  'media',
  'vectors',
  'messages',
  'collections',
  'conversation',
  'schedules',
  'attempts',
  'assignments',
  'notifications',
  'user',
])
export type DeletionStep = z.infer<typeof DeletionStep>

/** Durable progress for the one destructive workflow that crosses every store. */
export const DeletionJobSchema = z.object({
  phone: z.string(),
  mediaKeys: z.array(z.string()).default([]),
  completedSteps: z.array(DeletionStep).default([]),
  status: z.enum(['pending', 'running', 'done']).default('pending'),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable().default(null),
})
export type DeletionJob = z.infer<typeof DeletionJobSchema>
