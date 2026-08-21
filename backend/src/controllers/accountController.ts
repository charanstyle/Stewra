import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  DeleteAccountResponse,
  GetAccountDeletionPreviewResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { accountDeletionService } from '../services/accountDeletionService.js';
import { authService } from '../services/authService.js';
import { parse } from '../utils/validate.js';

// Only the password. Nothing else about a deletion is parameterisable — there is no "delete but
// keep X" — and an option that looked like one would be a promise this cannot keep.
const deleteAccountSchema = z.object({
  password: z.string().min(1),
});

class AccountController extends BaseController {
  /**
   * GET /users/me/deletion-preview — what deletion would do, and anything that blocks it.
   *
   * Safe to call at any time: it reads and destroys nothing. The client shows this BEFORE asking
   * for the password, because it is the only place the user learns that an organization will be
   * destroyed with them, or that a store subscription will keep billing them afterwards.
   */
  async deletionPreview(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('deletionPreview() requires requireAuth middleware');
      }
      const preview = await accountDeletionService.preview(userId);
      const body: GetAccountDeletionPreviewResponse = { preview };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'AccountController.deletionPreview');
    }
  }

  /**
   * DELETE /users/me — destroy the account and everything belonging to it. Irreversible.
   *
   * The password is re-verified even though `requireAuth` already passed. A valid session proves
   * possession of an unlocked phone, which is not the same as being the account's owner, and the
   * blast radius here is every message, memory and connected account the person has. This is the
   * same gate the approve-to-send-email toggle uses (`authService.reverifyPassword`), applied to the
   * one action in the product that cannot be undone.
   *
   * Deliberately NOT gated on `requireEmailVerification`: a user who never verified their address
   * still has an account, still has data, and is arguably the most entitled to delete it. Making
   * erasure conditional on completing onboarding would be a trap.
   *
   * 200 with a body rather than 204, because the result reports what could not be confirmed at a
   * third party — the one thing the user may still need to act on, and their last chance to read it.
   */
  async deleteAccount(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('deleteAccount() requires requireAuth middleware');
      }
      const { password } = parse(deleteAccountSchema, req.body);
      await authService.reverifyPassword(userId, password);

      const result = await accountDeletionService.delete(userId);
      const body: DeleteAccountResponse = { result };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'AccountController.deleteAccount');
    }
  }
}

export const accountController = new AccountController();
