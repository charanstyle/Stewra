import type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
  PublicUser,
  ReadReceipt,
} from '@stewra/shared-types';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { contactService } from './contactService.js';
import { preferencesService } from './preferencesService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Conversations: 1:1 (`direct`), group, and the singleton Stewra-AI thread. This is the authorization
 * choke point for messaging — `assertParticipant` gates every read/write, and creating a `direct`
 * conversation (like placing a call) additionally requires the two users to be contacts, so strangers
 * can neither DM nor ring each other.
 */
class ConversationService {
  /**
   * Ensure the user is an ACTIVE participant of the conversation; returns their participant row. Throws
   * 404 if the conversation doesn't exist, 403 if the user isn't (or no longer is) a member.
   */
  async assertParticipant(
    userId: string,
    conversationId: string,
  ): Promise<{ conversation: Conversation; participant: ConversationParticipant }> {
    const conversation = await conversationRepository.findById(conversationId);
    if (conversation === undefined) throw new NotFoundError('Conversation not found');
    const participant = await conversationRepository.getActiveParticipant(conversationId, userId);
    if (participant === undefined) {
      throw new ForbiddenError('You are not a participant of this conversation');
    }
    return { conversation, participant };
  }

  /**
   * Create a `direct` or `group` conversation. `direct` requires exactly one other participant who must
   * be an active contact. Participant ids are de-duplicated and the creator is always included.
   */
  async create(
    userId: string,
    type: 'direct' | 'group',
    participantUserIds: ReadonlyArray<string>,
    title: string | null,
  ): Promise<Conversation> {
    const others = Array.from(new Set(participantUserIds.filter((id) => id !== userId)));
    if (others.length === 0) {
      throw new ValidationError('A conversation needs at least one other participant');
    }

    if (type === 'direct') {
      if (others.length !== 1) {
        throw new ValidationError('A direct conversation must have exactly one other participant');
      }
      const other = others[0];
      if (other === undefined || !(await contactService.canContact(userId, other))) {
        throw new ForbiddenError('You can only start a conversation with a contact');
      }
    }

    return conversationRepository.create({
      type,
      title: type === 'group' ? title : null,
      createdBy: userId,
      participantUserIds: others,
    });
  }

  /** The caller's conversations as list rows (most-recent-first), each with participants/unread/preview. */
  async list(userId: string): Promise<ConversationSummary[]> {
    const conversations = await conversationRepository.listForUser(userId);
    return Promise.all(conversations.map((c) => this.buildSummary(userId, c)));
  }

  /** A single conversation summary (the caller must be a participant). */
  async get(userId: string, conversationId: string): Promise<ConversationSummary> {
    const { conversation } = await this.assertParticipant(userId, conversationId);
    return this.buildSummary(userId, conversation);
  }

  /** Fetch (provisioning on first call) the caller's singleton Stewra-AI conversation. */
  async getOrCreateStewra(userId: string): Promise<ConversationSummary> {
    const conversation = await conversationRepository.getOrCreateStewra(userId);
    return this.buildSummary(userId, conversation);
  }

  /** Add participants to a group conversation (caller must be an admin of it). */
  async addParticipants(
    userId: string,
    conversationId: string,
    userIds: ReadonlyArray<string>,
  ): Promise<ConversationSummary> {
    const { conversation, participant } = await this.assertParticipant(userId, conversationId);
    if (conversation.type !== 'group') {
      throw new ValidationError('Only group conversations accept new participants');
    }
    if (participant.role !== 'admin') {
      throw new ForbiddenError('Only an admin can add participants');
    }
    const toAdd = Array.from(new Set(userIds.filter((id) => id !== userId)));
    await conversationRepository.addParticipants(conversationId, toAdd);
    return this.buildSummary(userId, conversation);
  }

  /** Soft-leave a conversation (Stewra-AI cannot be left — it is the user's own singleton). */
  async leave(userId: string, conversationId: string): Promise<void> {
    const { conversation } = await this.assertParticipant(userId, conversationId);
    if (conversation.type === 'stewra_ai') {
      throw new ValidationError('The Stewra conversation cannot be left');
    }
    await conversationRepository.leave(conversationId, userId);
  }

  /**
   * Advance the caller's read watermark to the given message's timestamp AND record a per-message read
   * receipt for every message up to it (activating the "seen by" surface). The durable watermark always
   * advances; the receipts (which the sender sees) are only written and returned when the caller shares
   * read receipts — a privacy opt-out suppresses the receipts without hiding the caller's own unread state.
   * Returns the applied timestamp plus the newly-created receipts (empty when receipts are disabled or
   * nothing new was seen), so the caller emits `chat:message-read` exactly for freshly-seen messages.
   */
  async markRead(
    userId: string,
    conversationId: string,
    upToMessageId: string,
  ): Promise<{ lastReadAt: Date; receipts: ReadReceipt[] }> {
    await this.assertParticipant(userId, conversationId);
    // Validate the message exists in THIS conversation (also blocks marking read against a foreign id).
    const at = await messageRepository.createdAtOf(upToMessageId, conversationId);
    if (at === undefined) throw new NotFoundError('Message not found in this conversation');
    // Pass the message id (not its truncated Date) so the watermark + receipts use full timestamp
    // precision and always include the boundary message itself.
    const lastReadAt = await conversationRepository.markRead(conversationId, userId, upToMessageId);
    const sharesReceipts = await preferencesService.readReceiptsEnabled(userId);
    const receipts = sharesReceipts
      ? await messageRepository.insertReceiptsUpTo(userId, conversationId, upToMessageId)
      : [];
    return { lastReadAt, receipts };
  }

  /** The ids of a conversation's active participants OTHER than the given user (no membership check). */
  async otherActiveParticipantIds(userId: string, conversationId: string): Promise<string[]> {
    const participants = await conversationRepository.listActiveParticipants(conversationId);
    return participants.filter((p) => p.userId !== userId).map((p) => p.userId);
  }

  /** Assemble a list row: other active participants + unread count + last-message preview. */
  private async buildSummary(
    userId: string,
    conversation: Conversation,
  ): Promise<ConversationSummary> {
    const participants = await conversationRepository.listActiveParticipants(conversation.id);
    const self = participants.find((p) => p.userId === userId);
    const otherIds = participants.filter((p) => p.userId !== userId).map((p) => p.userId);
    const [others, unreadCount, lastMessage] = await Promise.all([
      this.resolveUsers(otherIds),
      messageRepository.unreadCount(
        conversation.id,
        userId,
        self?.lastReadAt !== undefined && self.lastReadAt !== null
          ? new Date(self.lastReadAt)
          : null,
      ),
      messageRepository.lastPreview(conversation.id),
    ]);
    return { conversation, participants: others, unreadCount, lastMessage };
  }

  private async resolveUsers(ids: ReadonlyArray<string>): Promise<PublicUser[]> {
    if (ids.length === 0) return [];
    return userRepository.findPublicByIds(ids);
  }
}

export const conversationService = new ConversationService();
