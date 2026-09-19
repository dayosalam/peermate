import { z } from 'zod'

export const MemoryCollectionSchema = z.object({
  collectionId: z.string(),
  userPhone: z.string(),
  name: z.string(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type MemoryCollection = z.infer<typeof MemoryCollectionSchema>
