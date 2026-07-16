import type { Request, Response } from 'express';
import type { UploadAvatarResponse } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { mediaService } from '../services/mediaService.js';
import { userRepository } from '../repositories/userRepository.js';
import { ValidationError } from '../utils/errors.js';

/** Accepted profile-photo mimes. Kept in lockstep with mediaService's image extension table. */
const ALLOWED_AVATAR_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Profile-photo REST surface (behind requireAuth + requireEmailVerification). */
class AvatarController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /**
   * POST /users/me/avatar — multipart: a single image part (`avatar`). Stores it as an owner-scoped
   * `avatar` asset, points the user row at it (replacing any previous photo), and returns the new
   * relative URL. The old asset row is left in place — orphaned, but harmless and audit-friendly.
   */
  async upload(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const file = req.file;
      if (file === undefined) throw new ValidationError('An image file is required');
      if (!ALLOWED_AVATAR_MIMES.has(file.mimetype)) {
        throw new ValidationError('Uploaded file must be a JPEG, PNG, WebP, or GIF image');
      }

      const asset = await mediaService.saveUpload({
        ownerId: userId,
        conversationId: null,
        kind: 'avatar',
        mime: file.mimetype,
        buffer: file.buffer,
      });
      await userRepository.setAvatarAssetId(userId, asset.id);

      const body: UploadAvatarResponse = { avatarUrl: mediaService.urlFor(asset) };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'AvatarController.upload');
    }
  }
}

export const avatarController = new AvatarController();
