import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, closeDb } from '../database/index.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { messageService } from '../services/messageService.js';

/**
 * The REJECTED leg of the confirmation gate.
 *
 * build-plan.md M6 asks the audit log to carry `proposed → approved/rejected → executed`. Two of
 * those three were recorded: `draft` when Stewra offers an email, `send` when the user approves one.
 * Declining wrote nothing at all, so the activity feed showed an offer and then silence — which reads
 * exactly like an offer that was quietly dropped, and left "did that actually go out?" answerable only
 * by inspecting a row in `messages`. For the one surface whose entire promise is that nothing is sent
 * without a human yes, the record of the no is not optional.
 *
 * Real Postgres, because the claim is about a row in an append-only table that a stubbed writer would
 * say nothing about.
 *
 * ⚠️ This suite deliberately does NOT delete its user. `audit_log.user_id` is `ON DELETE SET NULL`,
 * and SET NULL is an UPDATE, which the append-only trigger rejects — so a user who has generated even
 * one audit row can no longer be deleted at all. Every other DB-backed suite here cleans up its users
 * only because none of them writes an audit row. That interaction is a real defect in its own right
 * (it also breaks the "delete everything" promise in memory-and-learning.md §5); it is recorded here
 * rather than worked around silently.
 */

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);

const createdConversations: string[] = [];

interface Gate {
  readonly userId: string;
  readonly messageId: string;
}

/** A user with an assistant message carrying a pending proposed email — the state the gate acts on. */
async function proposalAwaitingDecision(to: string): Promise<Gate> {
  const user = await db
    .insertInto('users')
    .values({
      email: `email-gate-${randomUUID()}@stewra.invalid`,
      display_name: 'Email Gate Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const conversation = await conversationRepository.create({
    type: 'direct',
    title: null,
    createdBy: user.id,
    participantUserIds: [],
  });
  createdConversations.push(conversation.id);

  const message = await messageRepository.create({
    conversationId: conversation.id,
    senderId: null,
    senderKind: 'assistant',
    type: 'text',
    content: 'Want me to send this?',
    proposedEmail: {
      status: 'pending',
      to,
      subject: 'Thursday',
      body: 'Can we move it?',
      provider: null,
      failureReason: null,
    },
  });

  return { userId: user.id, messageId: message.id };
}

async function auditRowsFor(userId: string) {
  return db
    .selectFrom('audit_log')
    .selectAll()
    .where('user_id', '=', userId)
    .execute();
}

afterAll(async () => {
  if (createdConversations.length > 0) {
    await db.deleteFrom('conversations').where('id', 'in', createdConversations).execute();
  }
  await closeDb();
});

describe('declining a proposed email', () => {
  it('writes a dismiss row naming who it would have gone to', async () => {
    const gate = await proposalAwaitingDecision('alice@example.com');

    await messageService.confirmEmailAction(gate.userId, gate.messageId, 'cancel');

    const rows = await auditRowsFor(gate.userId);
    const dismissals = rows.filter((r) => r.action === 'dismiss');
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]?.resource_type).toBe('email');
    // The recipient is the fact that makes the row worth reading. "Dismissed a draft" would not tell
    // the user which of several offers they turned down.
    expect(dismissals[0]?.summary).toContain('alice@example.com');
    expect(dismissals[0]?.resource_id).toBe(gate.messageId);
  });

  it('records the dismissal as a success, not a failure', async () => {
    const gate = await proposalAwaitingDecision('bob@example.com');

    await messageService.confirmEmailAction(gate.userId, gate.messageId, 'cancel');

    const [row] = (await auditRowsFor(gate.userId)).filter((r) => r.action === 'dismiss');
    // Saying no is the gate working, not the gate failing. Logging it as `success: false` would put a
    // red mark in the activity feed against the safest thing the product can do.
    expect(row?.success).toBe(true);
  });

  it('never records a send for an email that was declined', async () => {
    const gate = await proposalAwaitingDecision('carol@example.com');

    await messageService.confirmEmailAction(gate.userId, gate.messageId, 'cancel');

    const rows = await auditRowsFor(gate.userId);
    expect(rows.filter((r) => r.action === 'send')).toHaveLength(0);
  });

  it('leaves the proposal terminal, so a dismissed draft cannot later be sent', async () => {
    const gate = await proposalAwaitingDecision('dave@example.com');

    const updated = await messageService.confirmEmailAction(gate.userId, gate.messageId, 'cancel');
    expect(updated.proposedEmail?.status).toBe('cancelled');

    // The second attempt is refused by status, not by the audit row — but if it were ever allowed,
    // the log would carry a dismissal followed by a send for the same proposal.
    await expect(
      messageService.confirmEmailAction(gate.userId, gate.messageId, 'send'),
    ).rejects.toThrow(/already cancelled/);

    const rows = await auditRowsFor(gate.userId);
    expect(rows.filter((r) => r.action === 'dismiss')).toHaveLength(1);
    expect(rows.filter((r) => r.action === 'send')).toHaveLength(0);
  });
});
