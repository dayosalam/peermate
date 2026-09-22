import { describe, expect, it, vi } from 'vitest'
import type { SendMailOptions } from 'nodemailer'
import { SignupEmailService } from '../src/services/signup-email.service.js'

function harness() {
  const messages: SendMailOptions[] = []
  const transport = {
    sendMail: vi.fn(async (message: SendMailOptions) => {
      messages.push(message)
      return { messageId: String(messages.length) }
    }),
  }
  const service = new SignupEmailService(transport as never, {
    enabled: true,
    from: 'PeerMate <hello@peermate.example>',
    adminWaitlistEmail: 'admin@peermate.example',
    whatsappUrl: 'https://wa.me/15076046411',
  })

  return { messages, service }
}

describe('signup email delivery', () => {
  it('notifies the admin and welcomes the submitted name', async () => {
    const { messages, service } = harness()

    await service.sendSignupEmails({ email: 'ada@example.com', name: 'Ada Student' })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      from: 'PeerMate <hello@peermate.example>',
      to: 'admin@peermate.example',
      replyTo: 'ada@example.com',
    })
    expect(messages[0]?.text).toContain('Name: Ada Student')
    expect(messages[0]?.text).toContain('Email: ada@example.com')
    expect(messages[1]).toMatchObject({
      from: 'PeerMate <hello@peermate.example>',
      to: 'ada@example.com',
    })
    expect(messages[1]?.text).toContain('Hello Ada Student,')
  })

  it('uses Sir/Ma when the signup did not provide a name', async () => {
    const { messages, service } = harness()

    await service.sendSignupEmails({ email: 'visitor@example.com', name: null })

    expect(messages[0]?.text).toContain('Name: Not provided')
    expect(messages[1]?.text).toContain('Hello Sir/Ma,')
  })
})
