// Post-deploy smoke, deployed-stack half: the API behind the origin is up and the SPA is wired to it.
//
// Split out from `render.smoke.ts` on purpose. That file runs against a bare `vite preview` in CI,
// where there is no backend at all — folding these checks in would have meant a conditional skip,
// and a smoke gate that quietly skips half of itself is exactly the failure this suite is trying to
// stop being possible. Two files, two scripts, no flags: `test:smoke:preview` runs the render half,
// `test:smoke:deployed` runs both.
import { test, expect } from '@playwright/test';
import { env, required } from '../env.mjs';

// Same-origin under /api by default (nginx strips the prefix in production), overridable for a
// split-origin deployment. No literal fallback host: a smoke gate that invents a target and reports
// it healthy is worse than one that refuses to start.
const API = (env.E2E_SMOKE_API_URL || `${required(env.E2E_SMOKE_TARGET, 'E2E_SMOKE_TARGET')}/api`)
  .replace(/\/$/, '');

test.describe('smoke: the deployed stack', () => {
  test('API health responds through the public origin', async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.status(), `GET ${API}/health`).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { status: 'ok' } });
  });

  test('the auth endpoint is reachable and rejects a bad credential', async ({ request }) => {
    // Credential-free but not vacuous: a 401 proves the request reached the real auth handler and
    // the DB behind it, which a health check alone does not. A 502/504 here (nginx up, backend down)
    // is precisely the half-broken deploy this gate is for.
    const res = await request.post(`${API}/auth/login`, {
      data: { email: 'smoke-gate@stewra.invalid', password: 'not-a-real-password' },
      failOnStatusCode: false,
    });
    expect(
      [400, 401].includes(res.status()),
      `POST ${API}/auth/login with a bogus credential should be rejected by the app, ` +
        `got ${res.status()} — a 5xx means the backend behind the origin is not serving`,
    ).toBe(true);
  });
});
