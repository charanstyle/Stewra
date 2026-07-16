import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { BaseController } from './baseController.js';
import { mediaService } from '../services/mediaService.js';
import { NotFoundError } from '../utils/errors.js';
import { parse } from '../utils/validate.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

const idParamsSchema = z.object({ id: z.string().uuid() });

/** Serves owner/participant-authorized media binaries — the ONLY way stored audio/media is read. */
class MediaController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /media/:id — authorize (owner or conversation participant), then stream the file. */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const { id } = parse(idParamsSchema, req.params);
      const { asset, absPath } = await mediaService.resolveForDownload(userId, id);

      // Confirm the backing file exists BEFORE we commit response headers, so a missing file is a clean
      // 404 (JSON) rather than a half-written stream.
      const stats = await stat(absPath).catch(() => null);
      if (stats === null || !stats.isFile()) throw new NotFoundError('Media not found');

      res.setHeader('Content-Type', asset.mime);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Disposition', 'inline');

      const stream = createReadStream(absPath);
      // After headers are sent a JSON error is impossible; log and tear down the socket instead.
      stream.on('error', (err: unknown) => {
        logger.error('media stream failed', { assetId: id, err: String(err) });
        res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      this.handleError(error, res, 'MediaController.get');
    }
  }
}

export const mediaController = new MediaController();
