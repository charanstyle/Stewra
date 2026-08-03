# Testing Guide — how backend tests are written in this repo

**`TESTING.md` at the repo root is the authority.** It has the setup commands, the tunnel, the
per-suite notes and the "what a green run does NOT prove" caveats. This file exists only to answer
the question a session actually has mid-task: *given this repo's rules, what does a good test look
like?* When the two disagree, `TESTING.md` wins.

## The runner is Vitest. There is no Jest here.

`git grep '"jest' -- '*package.json'` returns nothing. Every workspace uses **Vitest `^3.2.0`**:

```bash
npm test                      # backend + bridge + runner + provisioner, in that order
npm test -w backend           # one workspace  (= `vitest run`)
npm test -w backend -- hostedRunnerService   # one suite, by filename substring
```

`backend/vitest.config.ts` sets `globals: true`, so `describe`/`it`/`expect`/`vi` are ambient — no
imports needed in backend suites. Bridge and runner import them from `'vitest'` explicitly; match the
file you are editing.

Two settings there are load-bearing, not style:

- **`fileParallelism: false`** — every suite shares the one `stewra_test` database, and the DB-backed
  ones pin `process.env` before a dynamic `import()` of the config. Concurrent files would race.
- **`setupFiles: ['./src/tests/setupEnv.ts']`** — loads `backend/.env.test` and **throws** if it is
  missing. Skipping DB suites when credentials are absent would turn "I have no test database" into a
  green run, which is the failure mode these tests exist to rule out. Do not add a skip-if-unset.

There is **no coverage tooling** in this repo and no coverage target. Do not add
`--coverage` to a command or quote a percentage; it measures lines executed, not behaviour asserted,
and this codebase is deliberately optimised for the second.

## Do not mock. Use the real collaborator.

This is the single strongest convention here. The whole codebase contains **one** `vi.mock` string,
and it is a comment at `backend/src/tests/whatsappChannel.test.ts:12` explaining that the mocked
version was deleted. Commit `992a4e5` ("Cover whatsapp.ts and bridge.ts without mocks: extract the
logic, test the real thing") exists precisely to remove mock-based tests.

The reason: a service test built on a stubbed repository asserts that a call was made. It says
nothing about whether the SQL is valid, the column exists, or the transaction rolls back — which is
the entire class of bug that reaches production.

### Real Postgres and real Redis

Suites that touch storage open a real connection to the `stewra_test` database and Redis db 15, over
the SSH tunnels `npm run tunnel` brings up. Insert your own fixtures, track their ids, and delete
them in `afterAll`:

```ts
const createdUsers: string[] = [];

async function createUser(): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ email: `something-${randomUUID()}@stewra.invalid`, /* … */ })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}
```

`@stewra.invalid` is deliberate — a reserved TLD that can never be delivered to.

### Real HTTP, real routes, real middleware

To test a route, mount the **real router** on a real Express app on a real port and make real
requests — either with `supertest` (`whatsappChannel.test.ts`) or `fetch`
(`hostedRunnerService.test.ts:300-312`):

```ts
const app = express();
app.use(express.json());
app.use('/api/runner', runnerRouter);
app.use(errorHandler);
const api = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => api.once('listening', r));
const API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
```

Port `0` means "any free port" — never hardcode one, or two suites collide. Close the server in
`afterAll`.

Calling the controller function directly is not the same test. When what is under test is an
authorization boundary, the middleware chain *is* the subject: `hostedRunnerService.test.ts:302-305`
says so explicitly — "calling past it would assert nothing about the door being shut."

Authenticate the way a caller does. Mint a genuine token through the real code path
(`deviceRepo.registerDevice()` returns one) and send it as a real `Authorization: Bearer …` header.
Do not stub the auth middleware to inject a fake identity.

### Scripted-but-real, when the collaborator is external

Third-party services still get a real socket, not a spy. Stand up an HTTP server that behaves the way
the real one does — *including its refusals*:

- `backend/src/tests/hostedRunnerService.test.ts:91-262` runs a fake GitHub API and a fake
  provisioner. Both check bearer tokens, and the provisioner refuses an image that is not its own and
  refuses environment it was not configured for. It records `rejections`, which the suite asserts is
  empty — so a test that "passes" by sending a malformed request cannot go unnoticed.
- `runner/src/tests/fixtures/fake-acp-agent.mjs` is a real subprocess speaking real ACP over real
  stdio.
- `provisioner/src/tests/provisioner.test.ts` uses a **real Docker daemon** and real containers.

Nothing patches `globalThis.fetch`.

### Extract the pure logic instead of mocking around it

When something is hard to test because it is welded to a socket or a daemon, the fix is to pull the
decision out into a pure module and test that directly against real input shapes — not to mock the
socket. `bridge/src/core/waMapping.ts` and `bridge/src/core/closePolicy.ts` exist for exactly this;
`waMapping.test.ts` feeds them genuine Baileys protobuf objects (`proto.WebMessageInfo.fromObject`),
which is the shape a live socket emits, minus the socket.

## Config is parsed for real, so env must be set before import

`unifiedConfig` parses its Zod schema at **import time**. A suite that needs a specific configuration
pins `process.env`, calls `vi.resetModules()`, and then pulls the modules under test in with
`await import(...)` — static imports would have already run:

```ts
process.env['HOSTED_RUNNER_ENABLED'] = 'true';
process.env['HOSTED_RUNNER_PROVISIONER_URL'] = PROVISIONER_URL;

vi.resetModules();
const { hostedRunnerService } = await import('../services/hostedRunnerService.js');
```

`dotenv` never overwrites an already-set variable, which is what lets a suite pin one flag and still
inherit `DATABASE_URL` from `.env.test`.

Never hardcode a secret in a fixture. Generate it (`randomBytes`, `randomUUID`) — a literal would be a
committed secret, and generating it also proves the value plumbs through rather than a baked-in
default being used.

## Skips are failures wearing a disguise

`TESTING.md` states it: *"a suite that skips silently reads exactly like a suite that passed."*

If a precondition is missing, the test must say so loudly — either by failing (the `setupEnv.ts`
pattern, correct when the precondition is a developer setup step) or by skipping with a **named,
counted reason** that a reporter surfaces (the Playwright suite's `skip-reporter.mjs`, correct when
the precondition is genuinely optional). A bare `it.skip` with no reason is not acceptable, and
neither is `it.only` left behind.

## What a green backend suite does NOT prove

Vitest resolves CommonJS through Vite, which is **more** forgiving than Node's own ESM↔CJS interop. A
green suite therefore does not prove `node dist/index.js` can import `pg`, `socket.io`,
`jsonwebtoken` or the still-CommonJS `@stewra/*` workspaces. The check for that is booting the built
backend against the same tunnelled Postgres and Redis. See `TESTING.md` → "Not wired into CI".

---

**Related files:**
- [`TESTING.md`](../../../../TESTING.md) — the authority: setup, per-suite notes, e2e, caveats
- [SKILL.md](../SKILL.md)
- [services-and-repositories.md](services-and-repositories.md)
</content>
</invoke>
