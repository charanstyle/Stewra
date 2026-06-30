import express from 'express';
import type { Express, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { ApiResponse } from '@stewra/shared-types';
import { config } from './config/unifiedConfig';
import authRoutes from './routes/auth';
import emailVerificationRoutes from './routes/emailVerification';
import activityRoutes from './routes/activity';
import connectionRoutes from './routes/connections';
import insightRoutes from './routes/insights';
import preferencesRoutes from './routes/preferences';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

/**
 * Builds the Express app WITHOUT starting a listener, so tests (supertest) can exercise it and
 * `index.ts` can own the lifecycle. The middleware order is: security headers -> CORS -> JSON body
 * -> routes -> not-found -> terminal error handler.
 */
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: config.web.appUrl, credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  // Liveness: the process is up. Ready: the DB is reachable (checked in index.ts via a probe route).
  app.get('/health', (_req: Request, res: Response) => {
    const body: ApiResponse<{ status: 'ok' }> = { success: true, data: { status: 'ok' } };
    res.status(200).json(body);
  });

  app.use('/auth', authRoutes);
  app.use('/email-verification', emailVerificationRoutes);
  app.use('/activity', activityRoutes);
  app.use('/connections', connectionRoutes);
  app.use('/insights', insightRoutes);
  app.use('/preferences', preferencesRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
