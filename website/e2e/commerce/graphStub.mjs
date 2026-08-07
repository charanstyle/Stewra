// A real HTTP server playing Meta's Graph host for the commerce e2e stack.
//
// The backend under test points `META_COMMERCE_GRAPH_BASE_URL` at this process, so it makes real
// `fetch` calls over a real socket — nothing patches `globalThis.fetch`, and the whole connect
// service runs exactly as it does in production. This mirrors the stand-in Graph inside
// `backend/src/tests/commerceConnect.test.ts`; the difference is that this one is a separate
// process, because here the backend is one too.
//
// Meta cannot be called for real in a test: Embedded Signup returns a code minted by Meta for a
// live WhatsApp Business Account owned by a real business. Standing in for Graph at the network
// boundary is what makes the browser half testable without inventing a fake of our own code.
import { createServer } from 'node:http';

/** Whatever the test last asked for, so a spec can choose which shape of number Meta reports. */
const state = {
  /**
   * Which WhatsApp Business Account the grant covers.
   *
   * Controllable because `channel_accounts` is uniquely indexed on `(platform, external_account_id)`
   * — one WABA belongs to exactly one organization, by design. Two specs connecting the same id
   * from two orgs would hit that conflict and fail for a reason having nothing to do with what they
   * are testing, so each spec claims its own.
   */
  wabaId: 'waba-e2e-1',
  /** `CONNECTED` needs no registration PIN; anything else does. */
  phoneStatus: 'CONNECTED',
  /** The PIN this stub accepts at `/register`. Any other PIN is rejected the way Meta rejects one. */
  pin: '123456',
  /** Every call the backend made, so a spec can assert what did and did not reach Meta. */
  calls: [],
  /** Counts outbound sends, so each reply comes back with a distinct provider message id. */
  outbound: 0,
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Starts the stub and resolves with its origin plus a handle for the control endpoints.
 *
 * `appId`/`appSecret` are checked on the code exchange rather than ignored: a backend that
 * presented the wrong app credentials would still connect against a permissive stub, and the test
 * would prove nothing about the half of the flow that actually needs the secret.
 */
export async function startGraphStub({ appId, appSecret }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams.entries());

    // Control surface for the specs. Namespaced under `__stub` so it can never collide with a
    // Graph path, and served before the version prefix is stripped.
    if (url.pathname === '/__stub/state') {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const patch = JSON.parse(raw);
          if (patch.wabaId !== undefined) state.wabaId = patch.wabaId;
          if (patch.phoneStatus !== undefined) state.phoneStatus = patch.phoneStatus;
          if (patch.pin !== undefined) state.pin = patch.pin;
          if (patch.resetCalls === true) state.calls = [];
          json(res, 200, { ok: true });
        });
        return;
      }
      json(res, 200, {
        wabaId: state.wabaId,
        phoneStatus: state.phoneStatus,
        calls: state.calls,
      });
      return;
    }

    // Strip the pinned Graph version prefix so the cases below read as the endpoints they are.
    const pathname = url.pathname.replace(/^\/v\d+\.\d+\//, '').replace(/^\//, '');
    state.calls.push({ method: req.method ?? '', pathname });

    if (pathname === 'oauth/access_token') {
      if (query['client_id'] !== appId || query['client_secret'] !== appSecret) {
        json(res, 401, { error: { message: 'bad app credentials' } });
        return;
      }
      json(res, 200, { access_token: `biz-token-${query['code'] ?? ''}` });
      return;
    }

    if (pathname === 'debug_token') {
      json(res, 200, {
        data: {
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: [state.wabaId] },
            { scope: 'business_management', target_ids: ['business-e2e-1'] },
          ],
        },
      });
      return;
    }

    if (pathname.endsWith('/phone_numbers')) {
      json(res, 200, {
        data: [
          {
            id: 'phone-e2e-1',
            display_phone_number: '+1 555 010 0100',
            verified_name: 'Acme Coffee',
            quality_rating: 'GREEN',
            status: state.phoneStatus,
          },
        ],
      });
      return;
    }

    if (pathname.endsWith('/subscribed_apps')) {
      json(res, 200, { success: true });
      return;
    }

    if (pathname.endsWith('/messages')) {
      // The wamid shape matters: the backend stores it as the provider message id and the inbox
      // renders whatever came back, so a placeholder that is not id-shaped would hide a bug.
      state.outbound += 1;
      json(res, 200, {
        messaging_product: 'whatsapp',
        messages: [{ id: `wamid.E2E${state.outbound}` }],
      });
      return;
    }

    if (pathname.endsWith('/register')) {
      if (query['pin'] !== state.pin) {
        // Graph's real shape for this, near enough that the message the client sees is realistic.
        json(res, 400, { error: { message: 'Two-step verification PIN mismatch', code: 133005 } });
        return;
      }
      json(res, 200, { success: true });
      return;
    }

    // A bare `GET /{waba-id}` — the display metadata read.
    json(res, 200, { id: pathname, name: 'Acme Coffee' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}
