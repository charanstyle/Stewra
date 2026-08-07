import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CommerceCostSummary,
  GetCommerceCostsResponse,
  ListCommerceJobsResponse,
} from '@stewra/shared-types';
import { COMMERCE_JOB_STATUSES } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { commerceInboxRepository } from '../repositories/commerceInboxRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';
import { ValidationError } from '../../utils/errors.js';

const costsQuerySchema = z.object({
  // Both required, no defaults. A billing period whose boundary was guessed is a bill whose total
  // was guessed — the caller says which period they are closing.
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

const jobsQuerySchema = z.object({
  status: z.enum(COMMERCE_JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * The operational surface: what the queue is doing, and what Meta charged.
 *
 * `/costs` is the pass-through line on the client's invoice — message spend at Meta's price plus
 * the flat platform fee is the whole pricing model, so this endpoint is billing input, not
 * analytics decoration. `/jobs` exists because a broadcast IS a chain of jobs, and without it
 * "nothing has happened yet" and "it died eleven minutes ago" look identical from the campaign
 * screen.
 */
class OperationsController extends BaseController {
  /** GET /orgs/:orgId/costs */
  async costs(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const query = parse(costsQuerySchema, req.query);
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (from.getTime() >= to.getTime()) {
        throw new ValidationError('Validation failed', [
          { field: 'from', message: '`from` must be before `to`.' },
        ]);
      }

      const counts = await commerceInboxRepository.costSummary({ orgId, from, to });
      const summary: CommerceCostSummary = {
        orgId,
        from: from.toISOString(),
        to: to.toISOString(),
        billableByCategory: counts.billableByCategory,
        billableUncategorized: counts.billableUncategorized,
        freeMessages: counts.freeMessages,
        unpricedMessages: counts.unpricedMessages,
      };
      const body: GetCommerceCostsResponse = { summary };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OperationsController.costs');
    }
  }

  /** GET /orgs/:orgId/jobs */
  async jobs(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const query = parse(jobsQuerySchema, req.query);
      const [jobs, counts] = await Promise.all([
        jobRepository.listForOrg(orgId, query.limit, query.status),
        jobRepository.countsByStatus(orgId),
      ]);
      const body: ListCommerceJobsResponse = { jobs, counts };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OperationsController.jobs');
    }
  }
}

export const operationsController = new OperationsController();
