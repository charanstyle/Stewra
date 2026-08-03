# Database Patterns — Kysely, not an ORM

This backend uses **Kysely `^0.29.4`** over **`pg`**. There is no Prisma, no TypeORM, no Sequelize —
`git grep prisma -- backend/` returns nothing. Kysely is a typed query builder, not an ORM: there is
no model layer, no lazy loading, no `include`. You write SQL shapes, and TypeScript checks them
against the schema.

## Table of Contents

- [The `db` handle](#the-db-handle)
- [The schema type](#the-schema-type)
- [Repository pattern](#repository-pattern)
- [Reads](#reads)
- [Writes and upserts](#writes-and-upserts)
- [Transactions](#transactions)
- [Joins and N+1](#joins-and-n1)
- [Errors](#errors)

---

## The `db` handle

One process-wide `Kysely<Database>` over one `pg.Pool`, in `backend/src/database/index.ts`:

```ts
import { db } from '../database/index.js';
```

Never construct a second `Kysely` or a second `Pool` — the pool is capped at 10 connections and the
tunnelled test database is shared by every suite. `assertDbConnection()` runs at startup and throws
if the database is unreachable; `closeDb()` destroys the pool (suites call it in `afterAll`).

Note the `.js` extension on the import. The backend is ESM; extensionless relative imports do not
resolve at runtime even though `tsc` accepts them.

---

## The schema type

`backend/src/database/types.ts` declares one interface per table plus the `Database` map that keys
them by table name. It is **hand-written and hand-maintained** — there is no generator. A migration
that adds a column must add it here in the same change, or the column is invisible to every query.

Columns are `snake_case` (they are literally the SQL names). Domain models are `camelCase`. The
repository is where that translation happens, via a `toModel(row)` function — see
`runnerDeviceRepository.ts:48-62`. Do not leak a raw row past the repository boundary.

Kysely's column helpers carry the write/read asymmetry:

```ts
import type { ColumnType, Generated } from 'kysely';

export interface RunnerDevicesTable {
  id: Generated<string>;          // DB supplies it — not required on insert
  user_id: string;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
}
```

`Selectable<T>` is the row as it comes back, and it is what `toModel` should take:

```ts
import type { Selectable } from 'kysely';

function toModel(row: Selectable<RunnerDevicesTable>): RunnerDevice { /* … */ }
```

---

## Repository pattern

Every table's access lives in `backend/src/repositories/<name>Repository.ts` (25 of them). Services
call repositories; **controllers never touch `db` directly**. The repository owns the SQL, the
row→model mapping, and the tenancy scoping.

**Scope by `user_id` in the `WHERE` clause, not with a check beforehand.** This is the security
convention here, and `bridgeDeviceRepository.ts:168-170` states why: a caller who passes someone
else's id then changes nothing, rather than being told the row exists. A pre-check leaks existence;
a scoped predicate does not.

```ts
async revoke(userId: string, deviceId: string): Promise<boolean> {
  const result = await db
    .deleteFrom('bridge_devices')
    .where('id', '=', deviceId)
    .where('user_id', '=', userId)     // ← tenancy, in the predicate
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}
```

---

## Reads

```ts
// Zero-or-one. Returns `undefined` when absent — not null, not a fabricated empty object.
const row = await db
  .selectFrom('runner_devices')
  .selectAll()
  .where('id', '=', id)
  .where('user_id', '=', userId)
  .executeTakeFirst();

// Must exist. Throws `NoResultError` if not — correct when absence is a bug, not a case.
const row = await db
  .selectFrom('users')
  .select(['id', 'email'])
  .where('id', '=', id)
  .executeTakeFirstOrThrow();

// Many.
const rows = await db
  .selectFrom('suggestions')
  .selectAll()
  .where('user_id', '=', userId)
  .orderBy('updated_at', 'desc')
  .limit(50)
  .execute();
```

Prefer an explicit column list over `selectAll()` for hot paths, and hoist it to a shared
`MODEL_COLUMNS` constant when several queries feed the same `toModel` — `agentMemoryRepository.ts`
does this, which is what keeps `toModel`'s input type honest.

`executeTakeFirst()` returning `undefined` is an honest answer and may be returned as `null` from the
repository. Never convert it into `[]`, `{}`, `''` or an invented placeholder — the caller could not
then tell "no such row" from a real result. See the fallback rules in `CLAUDE.md`.

---

## Writes and upserts

```ts
const row = await db
  .insertInto('users')
  .values({ email, display_name: name, password_hash: hash, role: 'user' })
  .returning(['id', 'created_at'])
  .executeTakeFirstOrThrow();
```

`RETURNING` is how you get the generated id — there is no post-insert refetch. Use
`executeTakeFirstOrThrow()`: an insert that returned nothing is a failure, and silently continuing
with `undefined` is exactly the substituted-value bug the repo bans.

Upsert is `onConflict`, keyed on a real unique constraint (`agentMemoryRepository.ts:99-110`):

```ts
import { sql } from 'kysely';

await db
  .insertInto('agent_memory')
  .values({ user_id: userId, source_insight_id: insightId, label, /* … */ })
  .onConflict((oc) =>
    oc.columns(['user_id', 'source_insight_id']).doUpdateSet({
      label,
      updated_at: sql`now()`,
    }),
  )
  .returning(MODEL_COLUMNS)
  .executeTakeFirstOrThrow();
```

`sql\`now()\`` puts the clock in the database, where it is monotonic across app instances. Use the
`sql` template tag for raw fragments; never build SQL by string concatenation.

---

## Transactions

```ts
return db.transaction().execute(async (trx) => {
  const result = await trx.deleteFrom('bridge_devices').where('id', '=', deviceId).executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) return false;
  await trx.deleteFrom('whatsapp_chats').where('user_id', '=', userId).execute();
  return true;
});
```

Inside the callback use **`trx`**, never `db` — a stray `db` call runs on a different connection
outside the transaction and will not roll back with it. Anything that must not half-happen goes in
one: `bridgeDeviceRepository.revoke` deletes the device and its orphaned chats together, so there is
no state where the data outlives the device or the reverse.

A repository method that may be called both standalone and as part of a larger transaction takes an
optional `trx` and branches once, as `contactRepository.ts:111` does:

```ts
await (trx ? run(trx) : db.transaction().execute(run));
```

---

## Joins and N+1

There is no `include`. Fetch related rows with a real join or a batched `in` — never a loop of
queries.

```ts
// ❌ N+1
for (const device of devices) {
  const sessions = await db.selectFrom('runner_sessions').where('device_id', '=', device.id).execute();
}

// ✅ one round trip, grouped in memory
const sessions = await db
  .selectFrom('runner_sessions')
  .selectAll()
  .where('device_id', 'in', devices.map((d) => d.id))
  .execute();

// ✅ or a join, when you want the shape flattened
const rows = await db
  .selectFrom('runner_sessions as s')
  .innerJoin('runner_devices as d', 'd.id', 's.device_id')
  .select(['s.id', 's.status', 'd.name as device_name'])
  .where('d.user_id', '=', userId)
  .execute();
```

`.where(col, 'in', [])` with an empty array is valid SQL and returns nothing — but guard it anyway
when the empty case means "skip the query entirely".

---

## Errors

Kysely does not wrap driver errors, so what surfaces is a **`pg` error with a Postgres SQLSTATE** in
`.code`. Translate only the constraint violations you have a genuine domain answer for, and let
everything else propagate:

```ts
import { DatabaseError } from 'pg';
import { ConflictError, ValidationError } from '../utils/errors.js';

try {
  return await db.insertInto('users').values(data).returning('id').executeTakeFirstOrThrow();
} catch (error) {
  if (error instanceof DatabaseError && error.code === '23505') {
    throw new ConflictError('Email already registered');   // unique_violation
  }
  if (error instanceof DatabaseError && error.code === '23503') {
    throw new ValidationError('Invalid reference');        // foreign_key_violation
  }
  throw error;   // ← everything else propagates, untouched
}
```

Do not add a `catch` that returns `null`/`[]`/`{}` to "handle" a database error. A failed query and
an empty result are different facts, and collapsing them hides an outage as a legitimately empty
page. Catch only where the recovery is real, and say in a comment why it is correct.

A `CHECK` constraint the code believes is unreachable still gets a loud throw if it fires — see
`runnerDeviceRepository.ts:74-78`, which raises rather than skipping a hosted row whose container
nothing can address.

---

## Migrations

Numbered TypeScript modules under `backend/src/database/migrations/` (`001_users.ts`,
`002_audit_log.ts`, …), each exporting `up` and `down` built with Kysely's schema builder:

```ts
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('users').execute();
}
```

Applied by `npm run db:migrate -w backend`; `migrate.ts` runs each inside a transaction and records
it in the `migrations` table. Write `down` even when you doubt you will use it — a migration you
cannot reverse is a deploy you cannot roll back.

Adding a column means: write the migration **and** update `database/types.ts` in the same change.
Nothing generates the second from the first.

---

**Related Files:**
- [SKILL.md](../SKILL.md)
- [services-and-repositories.md](services-and-repositories.md)
- [testing-guide.md](testing-guide.md) — repository tests run against real Postgres, not a stub
- [async-and-errors.md](async-and-errors.md)
</content>
</invoke>
