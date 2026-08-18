# App Store and Google Play subscriptions — console setup

Everything the code needs is already written and tested (`backend/src/commerce/services/stores/`,
`frontend/src/services/iap.ts`, migrations 060/061). What is missing is entirely outside this
repo: two store consoles that have accounts and nothing configured in them. This is that work,
in the order it has to happen, with the exact env key each step produces.

Nothing here can be automated or verified from the repo. Both consoles are dashboard-only —
`scripts/meta-commerce-status.mjs` has no equivalent for Apple or Google, and neither store
exposes "is my product configured" over an API you can call before the product exists.

## The money, restated, because the console asks for a number

The platform fee is **$149/month net to Stewra in every channel**.

- Web (Stripe): the customer is charged **$149**. Stripe's fee comes out of that; it is small and
  is treated as a cost of collection, not a listing decision.
- App Store and Play: the customer is charged **$213**, which is `$149 ÷ 0.70` — priced against
  the headline 30% commission so that $149 survives it. Revenue is recognised **net**.

`$213` is what you type into both consoles. It is not a rounding of anything; if you enter $149
there, the business takes $104.30 and the whole billing plane is quietly wrong in a direction
nobody complains about.

Both listings are the **same plan** as far as this install is concerned. `COMMERCE_STORE_PLAN_NAME`
names one row in `commerce_plans`, and a store purchase puts the org on it. The store and web
listings differ only in who collects.

## Before either console: the plan must exist

**The backend refuses to boot** if `COMMERCE_STORE_PLAN_NAME` names a plan that is not loaded, or
one carrying no versions — a store-enabled install that cannot say what a purchase buys does not
start. The claim path refuses too, but by then the store has taken the customer's money for an
entitlement nobody can grant, so the check runs at startup and names the plans that *are* loaded
(a case difference is the mismatch that actually ships). Load the plan **before** setting the
store flags, as an install admin (`INSTALL_ADMIN_EMAILS`):

```
PUT /api/platform/billing/plans
{ "name": "Stewra Pro", "platformFeeMicros": "149000000", "currency": "USD",
  "note": "why this rate is being loaded — required, 1-2000 chars" }
```

`platformFeeMicros` is the **net** figure ($149). The $213 lives only in the store consoles —
this install never issues an invoice for a store subscription, because Apple's receipt *is* the
bill and a second document is a second charge.

Identifiers this repo already commits to (`frontend/app.config.ts`):

| | value |
|---|---|
| iOS bundle id | `com.stewra.app` |
| Android package | `com.stewra.app` |
| Expo owner / slug | `nurturinglab` / `stewra` |

---

## 1. App Store Connect

### 1.1 The app record

An app record must exist for `com.stewra.app` before any in-app purchase can be created. If the
bundle id is not yet registered, create it first in the Developer portal (Certificates,
Identifiers & Profiles → Identifiers), with **In-App Purchase** capability enabled.

### 1.2 The subscription

App Store Connect → your app → **Subscriptions**.

1. Create a **subscription group**. The group is what Apple upgrades/downgrades within; one group
   is correct here because there is one tier today. Name it something the customer will see on
   their receipt — "Stewra".
2. Inside it, create an **auto-renewable subscription**:
   - **Product ID** — this is the string that must match `APPLE_STORE_PRODUCT_ID` **and**
     `EXPO_PUBLIC_STORE_PRODUCT_ID_IOS` exactly. Suggested: `com.stewra.app.pro.monthly`.
     It is permanent; Apple will not let you reuse or rename it.
   - **Duration**: 1 month.
   - **Price**: **$213.00 USD** (Apple will generate the other storefronts from it; review that
     table rather than accepting it blindly if you sell outside the US).
   - **Localization**: display name and description, at minimum for English (U.S.).
   - **Review information**: screenshot of the subscription screen and a note telling the reviewer
     how to reach it. Apple rejects subscriptions with no review screenshot.

The product stays in "Ready to Submit" until it goes through review with a build. **Sandbox
purchases work before that** — which is what makes step 4 possible now.

### 1.3 The In-App Purchase key (`.p8`)

Users and Access → **Integrations** → **In-App Purchase** → add a key.

- Download the `.p8` **once** — Apple will not serve it again.
- Record the **Key ID** shown next to it → `APPLE_STORE_KEY_ID`.
- Record the **Issuer ID** shown at the top of that page → `APPLE_STORE_ISSUER_ID`.

This is *not* the App Store Connect API key and not the push key. A key from the wrong section
authenticates fine and then 401s against the App Store Server API.

### 1.4 Server notifications

App Store Connect → your app → **App Information** → App Store Server Notifications.

- **Version 2** (the adapter parses V2 signed payloads; V1 is not handled).
- Production URL **and** Sandbox URL: `https://www.stewra.com/api/webhooks/stores/apple`

Both point at the same URL on purpose — Apple sends sandbox and production notifications to the
same place and distinguishes them only inside the payload. `APPLE_STORE_ENVIRONMENT` is what
decides which ledger this install honours, and it is deliberately not discovered at runtime: an
install that accepted whichever ledger answered would grant real, paid entitlements to anyone
holding a sandbox tester account.

Use Apple's **"Request a Test Notification"** button once the URL is saved. A verified test ping
returns `ignored` from `handleNotification` — that is the success case, not a failure.

### 1.5 Sandbox tester

Users and Access → **Sandbox** → Test Accounts → add one. Use an email address that has never
been an Apple ID. Sign the **device** into it under Settings → Developer → Sandbox Apple Account
(not the main iCloud login).

### 1.6 Env

```
APPLE_STORE_ENABLED=true
APPLE_STORE_BUNDLE_ID=com.stewra.app
APPLE_STORE_PRODUCT_ID=com.stewra.app.pro.monthly
APPLE_STORE_ISSUER_ID=<issuer id from 1.3>
APPLE_STORE_KEY_ID=<key id from 1.3>
APPLE_STORE_PRIVATE_KEY=<contents of the .p8, newlines as literal \n>
APPLE_STORE_ENVIRONMENT=sandbox
COMMERCE_STORE_PLAN_NAME=Stewra Pro
```

`APPLE_STORE_ENABLED=true` makes bundle id, issuer id, key id, private key and product id
**required at boot** — a half-configured App Store deploy refuses to start rather than discovering
the gap when a renewal notification arrives (Apple retries for about a day, then stops, and the
subscription silently reads as expired).

---

## 2. Google Play

Play authenticates in a completely different place from Apple, and this is the thing to understand
before configuring it: **Google signs nothing in the notification body.** A Real-time Developer
Notification is an ordinary Pub/Sub push — plain JSON to a public URL anyone can POST to. The
entire proof is the OIDC token in the `Authorization` header, and three separate things about it
are checked: signed by Google, minted for *this* endpoint (`aud`), minted by *our* push
subscription (`email`). Skip the third and every Google Cloud customer on earth can point a push
subscription at the URL and be believed — which is why both Pub/Sub values are required at boot.

### 2.1 The subscription

Play Console → your app → **Monetize** → **Subscriptions** → create.

- **Product ID** → `GOOGLE_PLAY_PRODUCT_ID` and `EXPO_PUBLIC_STORE_PRODUCT_ID_ANDROID`.
  Suggested: `stewra-pro-monthly`. Play's ids are issued independently of Apple's and need not
  match; the two env vars exist precisely because they usually differ.
- Add a **base plan**: auto-renewing, monthly, **$213.00 USD**, then set regional prices.
- Activate the base plan. A subscription with no active base plan is invisible to the app and the
  purchase flow fails with an unhelpful error.

An app must have at least one build on a track (internal testing is enough) before Play will let
purchases be made against it.

### 2.2 The Android Publisher service account

The claim path and every notification follow-up call `purchases.subscriptionsv2.get` — the
notification carries a purchase token and an event number and nothing else, by Google's design, so
asking is mandatory.

1. In the Google Cloud project linked to the Play Console account, create a **service account**
   and download its **JSON key**.
2. Enable the **Google Play Android Developer API** on that project.
3. Play Console → **Users and permissions** → invite the service account's email → grant it access
   to this app with **View financial data** and **Manage orders and subscriptions**.

From the JSON: `client_email` → `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`, `private_key` →
`GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY` (newlines may be written as literal `\n`).

Permission grants in Play take several minutes to propagate; a fresh grant 401ing is normal for
the first few minutes and is not a configuration error.

### 2.3 Real-time developer notifications

1. Google Cloud → Pub/Sub → create a **topic**, e.g. `play-rtdn`.
2. Grant **Pub/Sub Publisher** on that topic to
   `google-play-developer-notifications@system.gserviceaccount.com`. Play refuses the topic
   without it, and this is the single most common thing to get wrong here.
3. Play Console → **Monetize** → **Monetization setup** → paste the full topic name
   (`projects/<project>/topics/play-rtdn`) and save. Use **Send test notification** — it should
   come back `ignored`.
4. Create a **push subscription** on that topic:
   - **Endpoint**: `https://www.stewra.com/api/webhooks/stores/google`
   - **Enable authentication**: on. Pick (or create) a service account for it — this one only
     mints tokens, it needs no Play permissions. Its email →
     `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL`.
   - **Audience**: `https://www.stewra.com/api/webhooks/stores/google`.

The audience is compared by **exact string equality** against `GOOGLE_PLAY_PUBSUB_AUDIENCE`. If
you leave the audience field blank, Pub/Sub defaults it to the endpoint URL — which is the same
string here, so either works, but setting it explicitly means a later endpoint change cannot
silently change the audience too. Note the `/api` prefix: nginx strips it before proxying
(`deploy/nginx-stewra-tunnel.conf`), so the backend sees `/webhooks/stores/google` while the token
was minted for the public URL. The configured value must be the **public** one.

### 2.4 License testers

Play Console (account level) → **Setup** → **License testing** → add the Google account that will
buy on the test device. A license tester's purchase is free but comes back from the *same* API as
a paying customer's, flagged `testPurchase` on the purchase itself — Play has no sandbox host.
`GOOGLE_PLAY_ENVIRONMENT` is what says which kind this install honours, so a tester cannot hold a
real, free entitlement in production.

### 2.5 Env

```
GOOGLE_PLAY_ENABLED=true
GOOGLE_PLAY_PACKAGE_NAME=com.stewra.app
GOOGLE_PLAY_PRODUCT_ID=stewra-pro-monthly
GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL=<client_email from 2.2>
GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY=<private_key from 2.2, newlines as literal \n>
GOOGLE_PLAY_PUBSUB_AUDIENCE=https://www.stewra.com/api/webhooks/stores/google
GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL=<push subscription service account from 2.3>
GOOGLE_PLAY_ENVIRONMENT=sandbox
COMMERCE_STORE_PLAN_NAME=Stewra Pro
```

---

## 3. The app build

`frontend/.env` (or the EAS build profile's env) needs the two product ids, and they must equal
the backend's:

```
EXPO_PUBLIC_STORE_PRODUCT_ID_IOS=com.stewra.app.pro.monthly
EXPO_PUBLIC_STORE_PRODUCT_ID_ANDROID=stewra-pro-monthly
```

A mismatch is a purchase the customer pays for and cannot use, and **neither store will tell you**,
because from their side the sale succeeded. The server refuses a claim for any other product —
that refusal is the only thing standing between a mismatch and a silent free entitlement.

A missing value does not stop the app booting; it throws when the Subscription screen opens, which
is the first moment it is actually needed.

Store purchases do not work in a simulator or on Expo Go. Both halves of step 4 need a real device
and a real signed build (TestFlight or an internal-track APK/AAB).

---

## 4. Testing it on live devices (backlog #56)

Both stores, same shape: buy on a device, then prove the *server* — not the app — recorded it.

**iOS, sandbox.** Install a TestFlight build (or a development build on a provisioned device —
see `TESTING.md` for the provisioning-profile requirements). Sign the device into the sandbox
tester from 1.5. Open the Subscription screen, buy. Then check:

- `POST /api/orgs/:orgId/billing/store-purchase` succeeded, and
- `GET /api/orgs/:orgId/billing` returns the org on the plan with `collector: 'apple'`, and
- the billing page at `/commerce/billing` shows the Apple note, **no payment-method section**, and
  no invoice — Apple's receipt is the bill.

Sandbox subscriptions renew on an accelerated clock (a month is minutes), so leave it running and
confirm a `DID_RENEW` notification lands and updates the row. Then cancel from
Settings → Sandbox Account and confirm the expiry is observed.

**Android, internal track.** Upload a build to internal testing, install it as the license tester
from 2.4, buy. Same three checks, with `collector: 'google'`. Cancel from Play → Subscriptions and
confirm the RTDN arrives and the state follows.

The one thing worth deliberately trying to break: buy on device A, then replay the same receipt
from device B against a different org. It must be refused — purchase references travel through the
app, the store and any proxy in between, so the unique constraint is the real guard.

## 5. Going live

When the sandbox runs clean and the app has cleared review:

1. Flip `APPLE_STORE_ENVIRONMENT` / `GOOGLE_PLAY_ENVIRONMENT` to `production`.
2. Restart the backend and confirm it boots (the boot guard is the check that nothing is missing).
3. Buy once, for real, on a production build, and refund it from the console.

That last step is the only end-to-end proof that exists, and it is worth its $213 — **there is no
refund surface in the product today.** A refund can only be issued from the store console (or the
Stripe dashboard, for web). Whether to build one is still an open decision.
