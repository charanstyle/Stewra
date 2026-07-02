import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { contactsController } from '../controllers/contactsController';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';

const router = Router();

// Every contacts route requires a signed-in, email-verified account.
const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.get('/search', requireAuth, verified, (req, res) => {
  void contactsController.search(req, res);
});

router.get('/', requireAuth, verified, (req, res) => {
  void contactsController.list(req, res);
});

router.post('/invites', requireAuth, verified, (req, res) => {
  void contactsController.invite(req, res);
});

router.get('/invites', requireAuth, verified, (req, res) => {
  void contactsController.listInvites(req, res);
});

router.post('/invites/:id/respond', requireAuth, verified, (req, res) => {
  void contactsController.respondInvite(req, res);
});

router.post('/block', requireAuth, verified, (req, res) => {
  void contactsController.block(req, res);
});

export default router;
