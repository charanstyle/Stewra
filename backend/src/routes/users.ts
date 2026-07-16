import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { avatarController } from '../controllers/avatarController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';
import { config } from '../config/unifiedConfig.js';

const router = Router();

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

// In-memory upload (the service writes the buffer to UPLOADS_DIR itself), size-capped by config so a
// large image fails loud at the edge rather than filling disk. One `avatar` file part per request.
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1 },
}).single('avatar');

router.post('/me/avatar', requireAuth, verified, uploadAvatar, (req, res) => {
  void avatarController.upload(req, res);
});

export default router;
