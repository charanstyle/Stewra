import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { messagesController } from '../controllers/messagesController';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';
import { config } from '../config/unifiedConfig';

const router = Router();

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

// In-memory upload (the service writes the buffer to UPLOADS_DIR itself), size-capped by config so a
// large clip fails loud at the edge rather than filling disk. One `audio` file part per voice turn.
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1 },
}).single('audio');

router.post('/', requireAuth, verified, (req, res) => {
  void messagesController.send(req, res);
});

router.post('/voice', requireAuth, verified, uploadAudio, (req, res) => {
  void messagesController.sendVoice(req, res);
});

router.get('/', requireAuth, verified, (req, res) => {
  void messagesController.list(req, res);
});

router.get('/:id/receipts', requireAuth, verified, (req, res) => {
  void messagesController.listReceipts(req, res);
});

router.post('/:id/react', requireAuth, verified, (req, res) => {
  void messagesController.react(req, res);
});

router.delete('/:id', requireAuth, verified, (req, res) => {
  void messagesController.delete(req, res);
});

export default router;
