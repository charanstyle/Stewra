import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';

/** For interpolating user-supplied names into HTML mail bodies — an org name is arbitrary input. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Thin wrapper over a Mailu/SMTP transport (nodemailer), mirroring the pattern the other apps on the
 * host use. The transport is created lazily and reused. Sending FAILS LOUDLY — a verification flow
 * that silently swallows a send error would leave the user stuck with no code and no signal.
 */
class EmailService {
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (this.transporter === null) {
      this.transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: { user: config.email.user, pass: config.email.password },
      });
      logger.info(`Email transport ready (${config.email.host}:${config.email.port})`);
    }
    return this.transporter;
  }

  /** Email a verification code in Stewra's plain, reassuring voice. */
  async sendVerificationCode(to: string, code: string, ttlMinutes: number): Promise<void> {
    const subject = 'Your Stewra verification code';
    const text =
      `Your Stewra verification code is ${code}.\n\n` +
      `Enter it on the verification screen to confirm your email. It expires in ${ttlMinutes} minutes.\n\n` +
      `If you didn't create a Stewra account, you can safely ignore this email — nothing happens until you act.`;
    const html =
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">` +
      `<h1 style="font-size:20px;margin:0 0 4px">Stewra</h1>` +
      `<p style="color:#555;margin:0 0 24px">A careful advisor that only reads — and never acts without you.</p>` +
      `<p style="margin:0 0 8px">Your verification code is:</p>` +
      `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>` +
      `<p style="color:#555;margin:0 0 24px">Enter it on the verification screen to confirm your email. It expires in ${ttlMinutes} minutes.</p>` +
      `<p style="color:#888;font-size:13px;margin:0">If you didn't create a Stewra account, you can safely ignore this email — nothing happens until you act.</p>` +
      `</div>`;

    await this.getTransporter().sendMail({ from: config.email.from, to, subject, text, html });
    logger.info(`Verification code emailed to ${to}`);
  }

  /** Email a password-reset code. Same voice/shape as the verification code; distinct wording + subject. */
  async sendPasswordResetCode(to: string, code: string, ttlMinutes: number): Promise<void> {
    const subject = 'Your Stewra password reset code';
    const text =
      `Your Stewra password reset code is ${code}.\n\n` +
      `Enter it on the reset screen along with your new password. It expires in ${ttlMinutes} minutes.\n\n` +
      `If you didn't ask to reset your Stewra password, you can safely ignore this email — your ` +
      `password stays unchanged until this code is used.`;
    const html =
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">` +
      `<h1 style="font-size:20px;margin:0 0 4px">Stewra</h1>` +
      `<p style="color:#555;margin:0 0 24px">A careful advisor that only reads — and never acts without you.</p>` +
      `<p style="margin:0 0 8px">Your password reset code is:</p>` +
      `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>` +
      `<p style="color:#555;margin:0 0 24px">Enter it on the reset screen with your new password. It expires in ${ttlMinutes} minutes.</p>` +
      `<p style="color:#888;font-size:13px;margin:0">If you didn't ask to reset your password, you can safely ignore this email — nothing changes until this code is used.</p>` +
      `</div>`;

    await this.getTransporter().sendMail({ from: config.email.from, to, subject, text, html });
    logger.info(`Password reset code emailed to ${to}`);
  }

  /**
   * Email a contact invitation. `inviterName` is the sender's display name; `inviteUrl` is the link the
   * invitee follows to accept (it carries the opaque server token). Fails loudly like the code email.
   */
  async sendContactInvite(to: string, inviterName: string, inviteUrl: string): Promise<void> {
    const subject = `${inviterName} invited you to connect on Stewra`;
    const text =
      `${inviterName} invited you to connect on Stewra.\n\n` +
      `Open this link to accept: ${inviteUrl}\n\n` +
      `Stewra is a careful advisor that only reads — and never acts without you. ` +
      `If you don't know ${inviterName}, you can safely ignore this email.`;
    const html =
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">` +
      `<h1 style="font-size:20px;margin:0 0 4px">Stewra</h1>` +
      `<p style="color:#555;margin:0 0 24px">A careful advisor that only reads — and never acts without you.</p>` +
      `<p style="margin:0 0 16px"><strong>${inviterName}</strong> invited you to connect on Stewra.</p>` +
      `<p style="margin:0 0 24px"><a href="${inviteUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Accept invitation</a></p>` +
      `<p style="color:#888;font-size:13px;margin:0">If you don't know ${inviterName}, you can safely ignore this email — nothing happens until you act.</p>` +
      `</div>`;

    await this.getTransporter().sendMail({ from: config.email.from, to, subject, text, html });
    logger.info(`Contact invite emailed to ${to}`);
  }

  /**
   * Email an organization invite for the commerce plane. Reached through the `orgInviteEmail` port
   * (`ports/orgInviteEmail.ts`) rather than imported by commerce directly — the plane boundary
   * forbids that import. `acceptUrl` carries the one-time token and arrives pre-assembled.
   */
  async sendOrgInvite(params: {
    to: string;
    inviterName: string;
    orgName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): Promise<void> {
    const { to, inviterName, orgName, role, acceptUrl, expiresAt } = params;
    // Escaped copies for the HTML body only; subject and text/plain must stay literal.
    const inviterHtml = escapeHtml(inviterName);
    const orgHtml = escapeHtml(orgName);
    const expiresOn = expiresAt.toUTCString();
    const subject = `${inviterName} invited you to join ${orgName} on Stewra`;
    const text =
      `${inviterName} invited you to join ${orgName} on Stewra as ${role}.\n\n` +
      `Open this link to accept: ${acceptUrl}\n\n` +
      `The link works until ${expiresOn}. You'll need a Stewra account on this email address — ` +
      `the invite is tied to it and cannot be accepted from another one.\n\n` +
      `If you weren't expecting this, you can safely ignore this email — nothing happens until you act.`;
    const html =
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">` +
      `<h1 style="font-size:20px;margin:0 0 4px">Stewra</h1>` +
      `<p style="color:#555;margin:0 0 24px">A careful advisor that only reads — and never acts without you.</p>` +
      `<p style="margin:0 0 16px"><strong>${inviterHtml}</strong> invited you to join <strong>${orgHtml}</strong> as <strong>${role}</strong>.</p>` +
      `<p style="margin:0 0 24px"><a href="${acceptUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Accept invitation</a></p>` +
      `<p style="color:#555;font-size:13px;margin:0 0 8px">The link works until ${expiresOn}, and only for a Stewra account on this email address.</p>` +
      `<p style="color:#888;font-size:13px;margin:0">If you weren't expecting this, you can safely ignore this email — nothing happens until you act.</p>` +
      `</div>`;

    await this.getTransporter().sendMail({ from: config.email.from, to, subject, text, html });
    logger.info(`Org invite emailed to ${to}`);
  }
}

export const emailService = new EmailService();
