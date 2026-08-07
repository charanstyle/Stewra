import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  AttestMessagingPolicyResponse,
  CreateSuppressionResponse,
  DeleteSuppressionResponse,
  GetMessagingPolicyResponse,
  ListContactConsentsResponse,
  ListSuppressionsResponse,
  RecordContactConsentResponse,
  UpdateMessagingPolicyResponse,
} from '@stewra/shared-types';
import {
  COMMERCE_PLATFORMS,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONSENT_STATES,
  SUPPRESSION_REASONS,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { consentService } from '../services/consentService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';

const contactParamsSchema = z.object({ contactId: z.string().uuid() });

const recordConsentSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  state: z.enum(CONSENT_STATES),
  source: z.enum(CONSENT_SOURCES),
  evidence: z.string().min(1).max(2048),
});

const listSuppressionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const createSuppressionSchema = z.object({
  platform: z.enum(COMMERCE_PLATFORMS),
  externalId: z.string().min(1).max(64),
  reason: z.enum(SUPPRESSION_REASONS),
  detail: z.string().max(2048).optional(),
});

const suppressionParamsSchema = z.object({
  platform: z.enum(COMMERCE_PLATFORMS),
  externalId: z.string().min(1).max(64),
});

const policySchema = z.object({
  // Length-bounded but not pattern-matched: the authoritative check is whether `Intl` can actually
  // resolve the zone, which the service performs against the same resolver the send gate uses. A
  // regex here would either reject valid zones or accept unresolvable ones.
  timezone: z.string().min(1).max(64),
  quietHoursStart: z.string().min(1).max(5),
  quietHoursEnd: z.string().min(1).max(5),
});

const attestSchema = z.object({ attestationText: z.string().min(1).max(4096) });

/**
 * The consent surface: history, suppression list, and messaging policy.
 *
 * Reads take `viewer`; every write takes `admin`, enforced on the routes. Recording consent on a
 * customer's behalf, lifting a block, and signing the attestation are statements the organization is
 * answerable for, and the role that works the inbox is not the role that should be making them.
 */
class ConsentController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /orgs/:orgId/contacts/:contactId/consents */
  async listConsents(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { contactId } = parse(contactParamsSchema, req.params);
      const consents = await consentService.listConsentHistory(orgId, contactId);
      const body: ListContactConsentsResponse = { consents };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.listConsents');
    }
  }

  /** POST /orgs/:orgId/contacts/:contactId/consents */
  async recordConsent(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { contactId } = parse(contactParamsSchema, req.params);
      const input = parse(recordConsentSchema, req.body);
      const consent = await consentService.recordConsent({
        orgId,
        contactId,
        // The platform comes from the contact row rather than the request: it is a property of who
        // this person is, and letting a caller assert it would let one payload record consent
        // against a platform the contact was never reached on.
        platform: await consentService.platformForContact(orgId, contactId),
        purpose: input.purpose,
        state: input.state,
        source: input.source,
        evidence: input.evidence,
        recordedByUserId: this.userId(req),
      });
      const body: RecordContactConsentResponse = { consent };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.recordConsent');
    }
  }

  /** GET /orgs/:orgId/suppressions */
  async listSuppressions(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { limit } = parse(listSuppressionsSchema, req.query);
      const suppressions = await consentService.listSuppressions(orgId, limit);
      const body: ListSuppressionsResponse = { suppressions };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.listSuppressions');
    }
  }

  /** POST /orgs/:orgId/suppressions */
  async createSuppression(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(createSuppressionSchema, req.body);
      const suppression = await consentService.suppress({
        orgId,
        platform: input.platform,
        externalId: input.externalId,
        reason: input.reason,
        detail: input.detail ?? null,
      });
      const body: CreateSuppressionResponse = { suppression };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.createSuppression');
    }
  }

  /** DELETE /orgs/:orgId/suppressions/:platform/:externalId */
  async deleteSuppression(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { platform, externalId } = parse(suppressionParamsSchema, req.params);
      await consentService.lift(orgId, platform, externalId);
      const body: DeleteSuppressionResponse = { lifted: true };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.deleteSuppression');
    }
  }

  /** GET /orgs/:orgId/messaging-policy */
  async getPolicy(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const policy = await consentService.getPolicy(orgId);
      const body: GetMessagingPolicyResponse = { policy };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.getPolicy');
    }
  }

  /** PUT /orgs/:orgId/messaging-policy */
  async updatePolicy(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(policySchema, req.body);
      const policy = await consentService.setQuietHours({ orgId, ...input });
      const body: UpdateMessagingPolicyResponse = { policy };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.updatePolicy');
    }
  }

  /** POST /orgs/:orgId/messaging-policy/attestation */
  async attest(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { attestationText } = parse(attestSchema, req.body);
      const policy = await consentService.attest({
        orgId,
        attestedByUserId: this.userId(req),
        attestationText,
      });
      const body: AttestMessagingPolicyResponse = { policy };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ConsentController.attest');
    }
  }
}

export const consentController = new ConsentController();
