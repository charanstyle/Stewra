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
- Play: the customer is charged **$213**, which is `$149 ÷ 0.70` — priced against the headline 30%
  commission so that $149 survives it. Play accepts an arbitrary price, so $213 is exact there.
- App Store: **$214.99**. Apple does not accept an arbitrary price — it sells from a fixed ladder
  of price points, and **$213 is not on it**. Of all 800 US points, $214.99 is the *cheapest* whose
  proceeds still clear the $149 floor: it returns **$150.50**. The next one down, $209.99, returns
  $147.00 and is $2.00/month short. Verified against Apple's own price-point table, not computed
  by hand; re-check with `pricePoints` on the subscription if the commission ever changes.

Revenue is recognised **net** in all three. The number to preserve is the $149 floor, not the
$213 — if you enter $149 in a store console the business takes $104.30, and the whole billing
plane is quietly wrong in a direction nobody complains about.

Outside the US, App Store prices come from Apple's **equalization table** for the $214.99 point,
which is what the console's "generate other storefronts" button uses. Those are local-currency
prices and their proceeds are local-currency too, so **$149 net is a US guarantee, not a worldwide
one** — FX and per-territory commission move it either way (Germany nets €147.05 on €249.99; the
UK nets £115.96 on £199.99).

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

`platformFeeMicros` is the **net** figure ($149). The store-facing price lives only in the store
consoles ($214.99 on the App Store, $213 on Play) —
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

### 1.1 The app record — DONE 2026-08-18

Created via the App Store Connect API, not the dashboard, so the values are recorded rather than
remembered:

| | |
|---|---|
| Bundle id | `com.stewra.app`, portal id `RW6T593FF5`, In-App Purchase capability on |
| App record | **Stewra**, app id `6802676118`, SKU `stewra-001`, primary language en-US |

The name `Stewra` was free at the time of registration. An app record cannot be created through
the API — only the bundle id can — so that step went through fastlane's session against the
account holder login.

### 1.2 The subscription — DONE 2026-08-18

| | |
|---|---|
| Group | `Stewra`, id `22317605`, customer-facing name "Stewra" (en-US) |
| Product id | **`com.stewra.app.pro.monthly`**, id `6802680088` — permanent, Apple will not rename or reuse it |
| Duration | 1 month, group level 1, family sharing off |
| Display name | "Stewra Pro" |
| Description | "Your assistant for calendar, mail, money and WhatsApp." |
| Availability | all **175** territories, new territories auto-enrolled |
| Price | **$214.99** US (proceeds $150.50) + 174 equalized storefronts |

Two things Apple enforces that are worth knowing before editing any of this by hand:

- **The description is capped at 55 characters** and the API rejects the whole request if it is
  longer — it does not truncate.
- **A price cannot be set before availability.** Apple refuses a price in a territory the product
  is not sold in, and the error it returns says only `ENTITY_ERROR.RELATIONSHIP.INVALID` with
  "An error occurred while processing the pricing information", which names neither cause nor fix.
  Set availability first, always.

The product now sits in **`MISSING_METADATA`**, which is expected and is not a configuration
error: it wants review assets (§1.7). **Sandbox purchases work in this state** — which is what
makes step 4 possible before any submission.

### 1.3 The In-App Purchase key (`.p8`)

Users and Access → **Integrations** → **In-App Purchase** → add a key.

- Download the `.p8` **once** — Apple will not serve it again.
- Record the **Key ID** shown next to it → `APPLE_STORE_KEY_ID`.
- Record the **Issuer ID** shown at the top of that page → `APPLE_STORE_ISSUER_ID`.

This is *not* the App Store Connect API key and not the push key.

An earlier revision of this document claimed a key from the wrong section "authenticates fine and
then 401s against the App Store Server API". **That is not true today** — measured 2026-08-18 by
calling `GET /inApps/v1/subscriptions/{id}` on `api.storekit-sandbox.itunes.apple.com` with the
Admin **team** key from §1.8: Apple answered `404 {"errorCode":4040010,"errorMessage":"Transaction
id not found."}`, which is the authenticated response. An unauthenticated caller gets 401 before
the lookup happens. So the team key would work.

Use a dedicated In-App Purchase key anyway, for a reason that has nothing to do with whether it
authenticates: the team key carries the **Admin** role over the whole account — it can create apps,
change prices, and add users — and `APPLE_STORE_PRIVATE_KEY` lives in `stewra.env` on a public-
facing host. An In-App Purchase key can do exactly one thing, which is the thing the backend
actually needs. §1.8 says the team key must never appear in `stewra.env`; that still stands.

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

**Done** — `GET /v2/sandboxTesters` returns one: `charanstyle+sandbox@gmail.com`, territory USA,
renewal rate `MONTHLY_RENEWAL_EVERY_FIVE_MINUTES` (a sandbox month is five real minutes, which is
what makes a renewal observable inside one sitting), `interruptPurchases=false`.

Note which builds actually need it. A **TestFlight** build already runs StoreKit against the
sandbox using the tester's own App Store Apple ID — the purchase sheet says `[Environment:
Sandbox]` and charges nothing. The sandbox tester account is for builds installed **outside**
TestFlight (Xcode run, or the `adhoc` profile in §3.1). Apple exposes testers read-only
(`GET /v2/sandboxTesters`, `PATCH` for territory and renewal rate); there is no create endpoint,
so a second one has to be added in the console.

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

### 1.7 What is still outstanding on the Apple side

The product exists and is priced. These are the things between it and taking money, in the order
they bite:

1. **Paid Applications agreement** (App Store Connect → Business). Must be *active*, with bank
   details and tax forms complete. Free apps do not need it; a subscription does. This is the one
   with real lead time — bank verification and tax review take days, and nothing about it is
   visible from the API, so it has to be checked in the console. **Does not block sandbox.**
2. **The In-App Purchase key** from §1.3 — the one remaining blocker for a sandbox purchase,
   because `claimPurchase` → `readSubscription` asks Apple's App Store Server API what the
   reference actually is, and that call is authenticated with this key. Console-only, verified
   2026-08-18 rather than assumed:
   - Public ASC API has no key surface. `/v1/apiKeys`, `/v1/inAppPurchaseKeys`,
     `/v1/subscriptionKeys`, `/v1/keys`, `/v1/integrations` all return 404, against a
     `/v1/userInvitations` control that returns 200 with data on the same token.
   - fastlane cannot either. `Spaceship::Portal::Key` (fastlane 2.238.0) covers *developer-portal*
     keys only — its `create` takes `apns:`, `device_check:`, `music_id:` and hardcodes those three
     service ids, with no passthrough. That is developer.apple.com → Keys, a different system from
     ASC → Users and Access → Integrations. Spaceship's internal ASC client (`spaceship/tunes/`)
     has `iap*.rb` and `sandbox_tester.rb` but no key model at all.
3. **Server notification URLs** (§1.4). Not needed to make a first purchase, needed before a
   renewal or a cancellation can be honoured.

**Done since this list was written:**

- ~~Review assets~~ — the paywall screenshot was captured off the tethered iPhone 13 and uploaded
  through `/v1/subscriptionAppStoreReviewScreenshots` (2026-08-18). The subscription moved
  `MISSING_METADATA` → **`READY_TO_SUBMIT`**, confirming the missing screenshot was the sole cause.
- ~~Sandbox tester~~ — see §1.5; one exists.

Worth recording because it was an open question: **`MISSING_METADATA` never blocked StoreKit.**
While the subscription was still in that state, the app on the device fetched the product and
`SubscriptionScreen` rendered `$214.99` from `product.displayPrice`. That screen has no hardcoded
price and no fallback — it renders "The store has no price for this product yet." when the fetch
returns nothing — so a rendered price is proof of a live store fetch, not of a local constant.

### 1.8 The App Store Connect API key (tooling, not runtime)

Creating the app record, subscription, availability and prices was driven through the App Store
Connect API with a **team key** (Users and Access → Integrations → App Store Connect API), role
Admin, issuer `6d7e0959-7c53-4142-b027-a4f225142c88`, key id `8RDCL892YB`, private key at
`~/.appstoreconnect/private_keys/AuthKey_8RDCL892YB.p8` on the dev machine (mode 0600).

This key is **not** used by the backend and must never appear in `stewra.env`. It exists so the
console work is repeatable and reviewable instead of a sequence of clicks nobody can audit. Apple
serves the `.p8` exactly once; losing it means revoking and re-issuing, which costs nothing but
the two minutes.

---

## 2. Google Play

Play authenticates in a completely different place from Apple, and this is the thing to understand
before configuring it: **Google signs nothing in the notification body.** A Real-time Developer
Notification is an ordinary Pub/Sub push — plain JSON to a public URL anyone can POST to. The
entire proof is the OIDC token in the `Authorization` header, and three separate things about it
are checked: signed by Google, minted for *this* endpoint (`aud`), minted by *our* push
subscription (`email`). Skip the third and every Google Cloud customer on earth can point a push
subscription at the URL and be believed — which is why both Pub/Sub values are required at boot.

### 2.1 The subscription — DONE 2026-08-18

The app record itself is dashboard-only (Play exposes no create-app API), but everything after it
was driven through the Android Publisher API, so the values are recorded rather than remembered:

| | |
|---|---|
| App | **Stewra**, package `com.stewra.app` |
| Product id | **`stewra.pro.monthly`** → `GOOGLE_PLAY_PRODUCT_ID`, `EXPO_PUBLIC_STORE_PRODUCT_ID_ANDROID` |
| Listing | title "Stewra Pro", description "Your assistant for calendar, mail, money and WhatsApp." (en-US) |
| Base plan | `monthly`, auto-renewing `P1M`, grace `P7D`, account hold `P30D`, resubscribe on |
| State | **ACTIVE** — `newSubscriberAvailability` true |
| Price | **$213.00 USD** + 172 regional prices, regions version `2025/03` |

Three things Play enforces that are worth knowing before touching this by hand:

- **A product id cannot contain hyphens.** It is `a-z`, `0-9`, `_` and `.` only — an earlier
  revision of this file suggested `stewra-pro-monthly`, which the API rejects outright with
  `Subscription ID is malformed`. Base plan ids are the opposite (RFC-1034, hyphens fine, no
  underscores). Product ids are permanent and non-reusable, so this is worth getting right on the
  first call rather than deleting and retrying.
- **`state` is output-only.** A base plan is always created `DRAFT`; `basePlans:activate` is the
  only way to make it `ACTIVE`, and a subscription with no active base plan is invisible to the
  app — the purchase flow fails with an unhelpful error rather than saying so.
- **Regional prices come from Play, not from arithmetic.** `pricing:convertRegionPrices` is the API
  behind the console's "set regional prices" button; it returns all 173 regions *and* the current
  `regionsVersion` (a required parameter), so neither is hardcoded. Note it suggests **$214.99**
  for the US rather than $213 — its own rounding to a familiar price point. It is overridden: Play
  accepts arbitrary prices and $213 = $149 ÷ 0.70 is the decision this file records.

Play ids are issued independently of Apple's and need not match — the two env vars exist precisely
because they differ, and here they do (`com.stewra.app.pro.monthly` vs `stewra.pro.monthly`).

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

**The same JSON is what `eas submit` authenticates with**, so `eas.json`'s
`submit.production.android.serviceAccountKeyPath` reads it from `$GOOGLE_PLAY_KEY_PATH` — a path,
not a value, and an env reference rather than a literal for the same reason as the iOS
`$ASC_KEY_PATH` beside it: the key must never be committed. Keep it with the Apple one, outside
the repo, and export both before submitting:

```
set -a && . ~/.stewra-asc.env && . ./.env && set +a
export GOOGLE_PLAY_KEY_PATH=~/.config/stewra/play-publisher.json
```

Google serves the private material exactly once at creation, unlike the Play *console* settings
which can all be re-read through the API. A lost key is not recoverable — mint a new one
(`gcloud iam service-accounts keys create`) and delete the orphan, which costs nothing.

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
GOOGLE_PLAY_PRODUCT_ID=stewra.pro.monthly
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
EXPO_PUBLIC_STORE_PRODUCT_ID_ANDROID=stewra.pro.monthly
```

A mismatch is a purchase the customer pays for and cannot use, and **neither store will tell you**,
because from their side the sale succeeded. The server refuses a claim for any other product —
that refusal is the only thing standing between a mismatch and a silent free entitlement.

A missing value does not stop the app booting; it throws when the Subscription screen opens, which
is the first moment it is actually needed.

Store purchases do not work in a simulator or on Expo Go. Both halves of step 4 need a real device
and a real signed build (TestFlight or an internal-track APK/AAB).

### 3.1 Getting a build onto a tethered iPhone without TestFlight

The `production` profile signs `method: app-store`. Such a profile carries no device list and sets
`get-task-allow=false`, so iOS refuses to install that `.ipa` directly — it is reachable *only*
through TestFlight, and TestFlight's Update button cannot be triggered from a script. Every
iteration therefore costs an upload, Apple's processing, and a human tap on the phone.

The `adhoc` profile exists to remove that loop. It `extends` `production`, so it keeps
`environment: "production"` — the point is to test against the real backend, and `preview` would
silently point the app at preview env vars and write test orgs into the wrong database. Two
deliberate overrides: `distribution: "internal"` (ad hoc signing, embedding the registered devices)
and `autoIncrement: false`, so device builds do not burn remote build numbers that TestFlight
builds are counting on.

```
set -a && . ~/.stewra-asc.env && . ./.env && set +a
eas build --platform ios --profile adhoc --local --non-interactive
unzip -q build-*.ipa -d /tmp/stewra-adhoc
xcrun devicectl device install app --device <udid> /tmp/stewra-adhoc/Payload/Stewra.app
```

`devicectl` installs an app *bundle*; it has no idea what an `.ipa` is, hence the unzip. `xcrun
devicectl list devices` shows whether the phone is reachable, but note its `Identifier` column is
the CoreDevice UUID, **not** the UDID — `--device` accepts either, the portal only knows the UDID.

The device must already be registered in the Apple developer portal, or the ad hoc profile will not
include it and the install fails at signature validation rather than at build time.

Sandbox StoreKit works on an ad hoc build exactly as it does on TestFlight, so nothing in step 4
changes — only who has to press the button.

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

Sandbox subscriptions renew on an accelerated clock, but **the rate is a console setting, not a
constant** — App Store Connect → Users and Access → Sandbox → the tester's renewal rate. Observed
on this account 2026-08-18: renewal did **not** arrive on the "a month is five minutes" schedule
the rate table implies, so check what the tester is actually set to before concluding the
notification pipeline is broken. Leave it running, confirm a `DID_RENEW` lands and updates the
row, then cancel from Settings → Sandbox Account and confirm the expiry is observed.

**Android, internal track.** Upload a build to internal testing, install it as the license tester
from 2.4, buy. Same three checks, with `collector: 'google'`. Cancel from Play → Subscriptions and
confirm the RTDN arrives and the state follows.

The one thing worth deliberately trying to break: buy on device A, then replay the same receipt
from device B against a different org. It must be refused — purchase references travel through the
app, the store and any proxy in between, so the unique constraint is the real guard.

## 5. Going live

Three channels go live independently. Stripe does not wait for App Review; the stores do.

### 5.1 The stores

When the sandbox runs clean and the app has cleared review:

1. Flip `APPLE_STORE_ENVIRONMENT` / `GOOGLE_PLAY_ENVIRONMENT` to `production`.
2. Restart the backend and confirm it boots (the boot guard is the check that nothing is missing).
3. Buy once, for real, on a production build, and refund it from the console.

Nothing else changes for Apple: the same `.p8`, issuer and key id serve both ledgers, and
`apiBaseUrl` follows the environment. What the flip actually arms is the refusal in
`appleStore.ts` — every notification and lookup carries the ledger it came from *inside the
signed payload*, and `assertOurs` rejects any payload whose ledger disagrees with this env var.
So a stale `sandbox` after launch does not quietly accept real purchases; it refuses them
loudly. That is the intended failure, but it is still an outage — flip it in the same restart
that ships the production build, not after.

### 5.2 Stripe, test → live

Independent of the stores, and the one channel that has never moved a real dollar. Four values
change together, all in `stewra.env`:

| Key | From | To |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_live_…` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | `pk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | test endpoint's `whsec_…` | **live endpoint's** `whsec_…` |
| `COMMERCE_BILLING_PROVIDER` | `stripe` | unchanged |

Two traps, in order of how much they cost:

**The webhook secret is per-endpoint, not per-account.** A live-mode endpoint is a *separate*
endpoint in the Stripe dashboard with its own signing secret, and both modes' secrets are
spelled `whsec_`. Carrying the test secret into live means every live delivery fails signature
verification — charges succeed at Stripe and the invoice never settles here. The boot guard
cannot catch this one (the string carries no mode), so it is on the person doing the cutover.
Create the live endpoint at `https://www.stewra.com/api/webhooks/payments` subscribed to
`payment_intent.succeeded` and `payment_intent.payment_failed` — the only two events
`stripeProvider.verifyWebhook` consumes — and copy *that* endpoint's secret.

**Mixed key modes are refused at boot.** `sk_live_` with `pk_test_` is caught by the guard in
`unifiedConfig.ts` and the backend will not start. This is deliberate: the failure it prevents
is a customer typing a card into a SetupIntent opened on the other ledger, which Stripe answers
with "No such setupintent".

The publishable key is served to the browser from `GET /orgs/:orgId/billing`, not baked into the
website bundle — so no website rebuild is needed. Restart the backend and the card form picks up
the live key on the next load.

Then prove it: put a real card on file at `/commerce/billing`, have an operator charge one
invoice from `POST /platform/billing/invoices/:invoiceId/charge`, confirm the `payment_intent.
succeeded` delivery verified and the invoice settled, and refund it from the Stripe dashboard.

### 5.3 What "live" still does not include

**There is no refund surface in the product.** A refund can only be issued from the store console
or the Stripe dashboard. Whether to build one is still an open decision.
