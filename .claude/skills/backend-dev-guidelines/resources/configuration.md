# Configuration Management - UnifiedConfig Pattern

Complete guide to managing configuration in backend microservices.

## Table of Contents

- [UnifiedConfig Overview](#unifiedconfig-overview)
- [NEVER Use process.env Directly](#never-use-processenv-directly)
- [Configuration Structure](#configuration-structure)
- [Environment-Specific Configs](#environment-specific-configs)
- [Secrets Management](#secrets-management)
- [Migration Guide](#migration-guide)

---

## UnifiedConfig Overview

### Why UnifiedConfig?

**Problems with process.env:**
- ❌ No type safety
- ❌ No validation
- ❌ Hard to test
- ❌ Scattered throughout code
- ❌ No default values
- ❌ Runtime errors for typos

**Benefits of unifiedConfig:**
- ✅ Type-safe configuration
- ✅ Single source of truth
- ✅ Validated at startup
- ✅ Easy to test with mocks
- ✅ Clear structure
- ✅ Fallback to environment variables

---

## NEVER Use process.env Directly

### The Rule

```typescript
// ❌ NEVER DO THIS
const timeout = parseInt(process.env.TIMEOUT_MS || '5000');
const dbHost = process.env.DB_HOST || 'localhost';

// ✅ ALWAYS DO THIS
import { config } from './config/unifiedConfig';
const timeout = config.timeouts.default;
const dbHost = config.database.host;
```

### Why This Matters

**Example of problems:**
```typescript
// Typo in environment variable name
const host = process.env.DB_HSOT; // undefined! No error!

// Type safety
const port = process.env.PORT; // string! Need parseInt
const timeout = parseInt(process.env.TIMEOUT); // NaN if not set!
```

**With unifiedConfig:**
```typescript
const port = config.server.port; // number, guaranteed
const timeout = config.timeouts.default; // number, with fallback
```

---

## Configuration Structure

### UnifiedConfig Interface

```typescript
export interface UnifiedConfig {
    database: {
        // One URL, not five parts. Assembling a connection string from separate host/port/user/
        // password fields invites exactly the per-field defaulting that points dev at prod.
        url: string;
    };
    server: {
        port: number;
        sessionSecret: string;
    };
    auth: {
        jwtSecret: string;
        accessTtl: string;
        refreshTtl: string;
        bcryptRounds: number;
    };
    vault: {
        keyHex: string;
    };
    web: {
        appUrl: string;
    };
    google: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        scopes: string;
    };
    redis: {
        url: string;
    };
    aws: {
        region: string;
        emailQueueUrl: string;
        accessKeyId: string;
        secretAccessKey: string;
    };
    sentry: {
        dsn: string;
        environment: string;
        tracesSampleRate: number;
    };
    // ... more sections
}
```

### Implementation Pattern

**File:** `backend/src/config/unifiedConfig.ts`

Environment variables, parsed once through a Zod schema at import time. There is no `config.ini`
in this repo.

```typescript
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Load backend/.env once, here. This is the ONE place process.env is read directly;
// everything else imports `config` from this module.
loadEnv();

const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // A behaviour knob carries a sensible default — it names HOW the app runs.
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

    // A setting that names WHAT the app acts on gets NO default. Absent = refuse to boot,
    // naming the variable.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    WEB_APP_URL: z.string().url('WEB_APP_URL must be a valid URL'),
    VAULT_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'VAULT_KEY must be 64 hex chars (32 bytes)'),
});

const env = EnvSchema.parse(process.env);   // throws at boot, naming the offending key

export const config = {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    database: { url: env.DATABASE_URL },
};
```

### ❌ The anti-pattern this replaced

The block below is what *not* to write. Every `||` chain ending in a literal is a silent
wrong-target run waiting to happen — `DB_HOST` unset does not fail, it quietly points production at
`localhost`; `DB_NAME` unset picks `blog_dev`. `~/.claude/hooks/fallback-guard.py` denies this
shape at write time.

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as ini from 'ini';

const configPath = path.join(__dirname, '../../config.ini');
const iniConfig = ini.parse(fs.readFileSync(configPath, 'utf-8'));

export const config: UnifiedConfig = {
    database: {
        host: iniConfig.database?.host || process.env.DB_HOST || 'localhost',
        port: parseInt(iniConfig.database?.port || process.env.DB_PORT || '3306'),
        username: iniConfig.database?.username || process.env.DB_USER || 'root',
        password: iniConfig.database?.password || process.env.DB_PASSWORD || '',
        database: iniConfig.database?.database || process.env.DB_NAME || 'blog_dev',
    },
    server: {
        port: parseInt(iniConfig.server?.port || process.env.PORT || '3002'),
        sessionSecret: iniConfig.server?.sessionSecret || process.env.SESSION_SECRET || 'dev-secret',
    },
    // ... more configuration
};

// Validate critical config
if (!config.tokens.jwt) {
    throw new Error('JWT secret not configured!');
}
```

**Key Points:**
- One `loadEnv()`, one `.parse()`, at import time — a bad deploy fails at boot, not on first request
- **Never default a setting that names a target.** Database, host, bucket, region, repo, queue,
  endpoint, credential: absent must throw. Refusing to start is the feature
- Defaults belong on knobs that name *behaviour* — `PORT`, `LOG_LEVEL`, `MAX_RETRIES`
- The Zod message is what the operator reads at 3am; write it as an instruction
- Type-safe access downstream, inferred from the schema

---

## Environment-Specific Configs

### Where the values come from

One mechanism, everywhere: environment variables.

| Context | Source |
| --- | --- |
| Local dev | `backend/.env` (gitignored), loaded by `loadEnv()` |
| Tests | `backend/.env.test`, loaded by `src/tests/setupEnv.ts` — **throws** if the file is missing |
| Production | Real environment variables, supplied by `docker-compose.prod.yml` from `stewra.env` on the deploy host |

`.env.example` at the repo root is the checked-in catalogue of every key, with prose describing what
it does. Adding a variable to `EnvSchema` means adding it there in the same change — that file is how
an operator discovers the key exists at all.

### Environment Overrides

```bash
# backend/.env — local development
DATABASE_URL=postgres://stewra@127.0.0.1:5432/stewra_dev
DB_PASSWORD=secure-password
PORT=3001
```

**Precedence:** `dotenv` never overwrites a variable that is already set, so a real environment
variable always beats the `.env` file. That is what lets a test pin one flag
(`process.env.WHATSAPP_PERSONAL_ENABLED = 'true'`) before importing the config and still inherit
`DATABASE_URL` from the shared file.

There is no third tier. A key set nowhere either has a schema default — behaviour knobs only — or
stops the process at boot.

---

## Secrets Management

### DO NOT Commit Secrets

```gitignore
# .gitignore
.env
.env.test
.env.e2e
*.pem
*.key
```

`.env.example` IS committed — it carries the key names and prose, never values.

### Use Environment Variables in Production

Same schema, same parse, different source. Production values arrive as real environment variables
(`docker-compose.prod.yml` reads them from `stewra.env` on the deploy host, which is deliberately
uncommitted); development values arrive from `backend/.env`. Nothing in the code branches on which.

```typescript
// ❌ Never. An empty-string fallback means a missing secret boots a running service that
//    signs tokens with "" — a silent, exploitable success instead of a loud failure.
const jwtSecret = process.env.JWT_SECRET || '';

// ✅ The schema refuses to parse, and the process never starts.
JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
```

---

## Migration Guide

### Find All process.env Usage

```bash
# Should return exactly one hit: the loadEnv()/EnvSchema.parse() in unifiedConfig.ts itself.
git grep -n "process\.env" -- backend/src --and --not -e tests
```

### Migration Example

**Before:**
```typescript
// Scattered throughout code
const timeout = parseInt(process.env.GOOGLE_HTTP_TIMEOUT_MS || '15000');
const webAppUrl = process.env.WEB_APP_URL;
const jwtSecret = process.env.JWT_SECRET;
```

**After:**
```typescript
import { config } from './config/unifiedConfig.js';

const timeout = config.google.httpTimeoutMs;
const webAppUrl = config.web.appUrl;
const jwtSecret = config.tokens.jwt;
```

**Benefits:**
- Type-safe
- Centralized
- Easy to test
- Validated at startup

---

**Related Files:**
- [SKILL.md](../SKILL.md)
- [testing-guide.md](testing-guide.md)
