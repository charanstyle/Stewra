import { Router } from 'express';
import channelsRoutes from './channels.js';
import conversationsRoutes from './conversations.js';
import consentRoutes from './consent.js';
import audienceRoutes from './audience.js';
import campaignRoutes from './campaigns.js';

/**
 * THE COMMERCE PLANE'S ORG-SCOPED SURFACE, as one router to mount at `/orgs/:orgId`.
 *
 * These five sub-routers used to be mounted by `routes/organizations.ts` itself. That file is now
 * `tenancy/routes/organizations.ts` — organizations are an install-wide primitive, not a commerce
 * concept — and tenancy may not import commerce. So the mounts moved out here, and `app.ts`, the
 * composition root, joins the two halves back onto the same path prefix.
 *
 * `mergeParams` so `:orgId` from the parent mount reaches `requireOrgMember`; every sub-router already
 * declares it, and this one must too or the parameter dies at this hop. Each sub-router still declares
 * its own minimum role per route — nothing here is reachable without a membership check.
 *
 * The URLs are byte-identical to what they were before the move.
 */
const router = Router({ mergeParams: true });

router.use('/channels', channelsRoutes);
router.use('/conversations', conversationsRoutes);
// Consent, the suppression list and messaging policy. Mounted at the org root rather than under a
// prefix of its own because its routes span two resources — `/contacts/:id/consents` and
// `/suppressions` — and inventing a shared prefix would put a made-up noun in every client URL.
router.use('/', consentRoutes);
// Contacts, tags and segments. Mounted at the org root for the same reason as consent: its routes
// span three resources, and a shared prefix would be a noun nobody uses.
router.use('/', audienceRoutes);
// Templates and broadcasts. Org root again — `/templates` and `/broadcasts` are separate resources,
// and a `/campaigns` prefix would put a word in the URL that no part of the API actually models.
router.use('/', campaignRoutes);

export default router;
