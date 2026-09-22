import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer'
import { config } from '../config.js'
import type { LandingSignup } from '../models/index.js'

type SignupContact = Pick<LandingSignup, 'email' | 'name'>
type MailTransport = Pick<Transporter, 'sendMail'>

export interface SignupEmailSettings {
  enabled: boolean
  from: string
  adminWaitlistEmail: string
  whatsappUrl: string
}

export class SignupEmailConfigurationError extends Error {}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character]!,
  )
}

export class SignupEmailService {
  constructor(
    private readonly transport: MailTransport,
    private readonly settings: SignupEmailSettings,
  ) {}

  async sendSignupEmails(signup: SignupContact): Promise<void> {
    if (!this.settings.enabled) {
      throw new SignupEmailConfigurationError('Signup email is not configured')
    }

    const name = signup.name?.trim() || null
    const salutation = name || 'Sir/Ma'
    const adminName = name || 'Not provided'
    const safeName = escapeHtml(adminName)
    const safeEmail = escapeHtml(signup.email)
    const safeSalutation = escapeHtml(salutation)
    const safeWhatsappUrl = escapeHtml(this.settings.whatsappUrl)

    const messages: SendMailOptions[] = [
      {
        from: this.settings.from,
        to: this.settings.adminWaitlistEmail,
        replyTo: signup.email,
        subject: 'New PeerMate signup',
        text: `A new person joined the PeerMate waitlist.\n\nName: ${adminName}\nEmail: ${signup.email}`,
        html: `<p>A new person joined the PeerMate waitlist.</p><p><strong>Name:</strong> ${safeName}<br><strong>Email:</strong> ${safeEmail}</p>`,
      },
      {
        from: this.settings.from,
        to: signup.email,
        subject: 'Welcome to PeerMate',
        text: `Hello ${salutation},\n\nThank you for signing up for PeerMate. You can now chat with PeerMate on WhatsApp: ${this.settings.whatsappUrl}\n\nThe PeerMate team`,
        html: `<p>Hello ${safeSalutation},</p><p>Thank you for signing up for PeerMate.</p><p><a href="${safeWhatsappUrl}">Chat with PeerMate on WhatsApp</a></p><p>The PeerMate team</p>`,
      },
    ]

    const results = await Promise.allSettled(
      messages.map((message) => this.transport.sendMail(message)),
    )
    const failures = results.filter((result) => result.status === 'rejected')

    if (failures.length > 0) {
      throw new Error(`Could not deliver ${failures.length} of 2 signup emails`, {
        cause: failures[0]?.reason,
      })
    }
  }
}

const signupEmailTransport = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.secure,
  requireTLS: config.email.requireTls,
  auth:
    config.email.username && config.email.password
      ? { user: config.email.username, pass: config.email.password }
      : undefined,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
})

export const signupEmailService = new SignupEmailService(signupEmailTransport, {
  enabled: config.email.enabled,
  from: config.email.from,
  adminWaitlistEmail: config.email.adminWaitlistEmail,
  whatsappUrl: config.landing.whatsappUrl,
})
