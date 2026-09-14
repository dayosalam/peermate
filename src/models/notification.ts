import { z } from 'zod'

export const NotificationType = z.enum(['instant', 'digest', 'deadline_warning', 'reminder'])
export type NotificationType = z.infer<typeof NotificationType>

export const NotificationSchema = z.object({
  userPhone: z.string(),
  extractionId: z.string().nullable(),
  notificationType: NotificationType,
  /**
   * `suppressed` is a delivery rule holding it — a pause, a mute, quiet hours. It is
   * not a failure and nothing was lost, but it is the difference between "she never
   * got the warning because we were down" and "because she asked us to be quiet",
   * and until it was written down that question could only be answered from stdout.
   */
  status: z.enum(['sent', 'failed', 'suppressed']),
  /** The exception on a failure, or which rule held it on a suppression. */
  error: z.string().nullable().default(null),
  sentAt: z.date(),
})
export type Notification = z.infer<typeof NotificationSchema>
