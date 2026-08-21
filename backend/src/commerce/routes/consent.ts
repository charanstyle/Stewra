import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { consentController } from '../controllers/consentController.js';
import { requireOrgMember } from '../../tenancy/middleware/requireOrgMember.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireEmailVerification } from '../../middleware/requireEmailVerification.js';

// `mergeParams` so `:orgId` from the parent mount reaches requireOrgMember.
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

/**
 * The consent surface, mounted under `/orgs/:orgId`.
 *
 * The role split is the point of this file. Reads are `viewer`: an agent looking at a thread needs
 * to be able to see why a contact cannot be messaged, and hiding that only produces confused retries.
 * Every write is `admin`, one step above the `agent` role that may reply in the inbox — recording
 * consent on a customer's behalf, lifting a block, and signing the lawful-opt-in attestation are all
 * statements the organization is answerable for if challenged, and the person answering messages is
 * not the person who should be making them.
 */

router.get('/contacts/:contactId/consents', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void consentController.listConsents(req, res);
});

router.post('/contacts/:contactId/consents', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void consentController.recordConsent(req, res);
});

router.get('/suppressions', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void consentController.listSuppressions(req, res);
});

router.post('/suppressions', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void consentController.createSuppression(req, res);
});

router.delete(
  '/suppressions/:platform/:externalId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void consentController.deleteSuppression(req, res);
  },
);

router.get('/messaging-policy', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void consentController.getPolicy(req, res);
});

router.put('/messaging-policy', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void consentController.updatePolicy(req, res);
});

// The attestation is `owner`, not `admin`: it is the one action here that is a signature rather than
// a setting, and the person who signs a compliance statement on the organization's behalf should be
// the person who owns the organization.
router.post(
  '/messaging-policy/attestation',
  requireAuth,
  verified,
  requireOrgMember('owner'),
  (req, res) => {
    void consentController.attest(req, res);
  },
);

export default router;
