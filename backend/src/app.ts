import express from 'express';
import type { Express, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { ApiResponse } from '@stewra/shared-types';
import { config } from './config/unifiedConfig.js';
import authRoutes from './routes/auth.js';
import emailVerificationRoutes from './routes/emailVerification.js';
import activityRoutes from './routes/activity.js';
import connectionRoutes from './routes/connections.js';
import insightRoutes from './routes/insights.js';
import feedbackRoutes from './routes/feedback.js';
import memoryRoutes from './routes/memory.js';
import processRulesRoutes from './routes/processRules.js';
import preferencesRoutes from './routes/preferences.js';
import contactsRoutes from './routes/contacts.js';
import conversationsRoutes from './routes/conversations.js';
import messagesRoutes from './routes/messages.js';
import usersRoutes from './routes/users.js';
import callsRoutes from './routes/calls.js';
import pushRoutes from './routes/push.js';
import mediaRoutes from './routes/media.js';
import homeRoutes from './routes/home.js';
import channelsRoutes from './routes/channels.js';
import runnerRoutes from './routes/runner.js';
import githubAppRoutes from './routes/githubApp.js';
import whatsappWebhookRoutes from './routes/whatsappWebhook.js';
import orgRoutes from './commerce/routes/organizations.js';
import metaWebhookRoutes from './commerce/routes/metaWebhook.js';
import { commerceIntentService } from './commerce/services/commerceIntentService.js';
import { commerceProposalExecutorRegistry, turnIntentRegistry } from './ports/turnIntent.js';
import { orgInviteEmailRegistry } from './ports/orgInviteEmail.js';
import { emailService } from './services/emailService.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

/**
 * Builds the Express app WITHOUT starting a listener, so tests (supertest) can exercise it and
 * `index.ts` can own the lifecycle. The middleware order is: security headers -> CORS -> the raw-body
 * webhook -> JSON body -> routes -> not-found -> terminal error handler.
 */
export function createApp(): Express {
  const app = express();

  // THE composition root for the two bounded contexts. `stewraConversationService` has to be able to
  // offer a Talk-to-Stewra turn to the commerce plane's business inbox, but `.dependency-cruiser.cjs`
  // forbids it from importing `commerce/` — so the dependency is inverted through `ports/turnIntent`
  // and joined up here, in one of the three files exempt from that rule. `register` is idempotent by
  // handler name, so repeated `createApp()` calls across a test suite cannot double-register it.
  //
  // The handler no-ops when META_COMMERCE_ENABLED is off, so registering unconditionally is safe and
  // keeps the wiring identical between the running process and supertest.
  // Two capabilities, one implementation: claiming a conversational turn, and executing a proposal the
  // app's Send/Cancel card names directly. Registering both here is what makes "yes" and the button
  // the same code path.
  turnIntentRegistry.register(commerceIntentService);
  commerceProposalExecutorRegistry.register(commerceIntentService);
  // Same inversion, other direction: the commerce plane cannot import `services/emailService`, so an
  // org invite reaches SMTP through this port. Registration is a plain overwrite — the last
  // `createApp()` wins with an identical binding, so re-creation in tests is harmless, and a test
  // that swaps in a scripted sender must do so AFTER building the app.
  orgInviteEmailRegistry.register({
    send: (email) => emailService.sendOrgInvite(email),
  });

  app.use(helmet());
  app.use(cors({ origin: config.web.appUrl, credentials: false }));

  // BEFORE express.json(), deliberately. Meta signs the RAW bytes (X-Hub-Signature-256), and
  // parse-then-re-serialize is not byte-identical — so letting the JSON parser touch this body first
  // would invalidate every signature. This router installs its own express.raw().
  app.use('/webhooks/whatsapp', whatsappWebhookRoutes);
  // Same reasoning, different Meta app: this one is the commerce plane's, and it carries traffic for
  // every connected organization rather than for Stewra's own number.
  app.use('/webhooks/meta', metaWebhookRoutes);

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
  app.use('/channels', channelsRoutes);
  app.use('/runner', runnerRoutes);
  app.use('/github-app', githubAppRoutes);
  app.use('/insights', insightRoutes);
  app.use('/insights', feedbackRoutes);
  app.use('/memory', memoryRoutes);
  app.use('/process-rules', processRulesRoutes);
  app.use('/preferences', preferencesRoutes);
  app.use('/contacts', contactsRoutes);
  // Commerce plane — a separate bounded context (backend/src/commerce/), scoped by org_id rather
  // than user_id. Nothing under here shares tables with the personal-assistant routes above.
  app.use('/orgs', orgRoutes);
  app.use('/conversations', conversationsRoutes);
  app.use('/messages', messagesRoutes);
  app.use('/users', usersRoutes);
  app.use('/calls', callsRoutes);
  app.use('/push', pushRoutes);
  app.use('/media', mediaRoutes);
  app.use('/home', homeRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
