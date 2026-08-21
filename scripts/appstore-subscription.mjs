#!/usr/bin/env node
/**
 * Configure the App Store subscription this install sells, through the App Store Connect API.
 *
 * Why this exists rather than a page of dashboard instructions: the console cannot be reviewed,
 * cannot be repeated for a second install, and cannot tell you afterwards what it actually did.
 * Every command here reads back what it created, and the values it produces are the ones
 * `deploy/store-subscriptions.md` records.
 *
 *   ASC_ISSUER_ID=... ASC_KEY_ID=... ASC_KEY_PATH=... node scripts/appstore-subscription.mjs state
 *
 * The credential is an App Store Connect **team key** (Users and Access -> Integrations -> App
 * Store Connect API), role Admin or App Manager. Keep the .p8 out of the repo and out of
 * `stewra.env`: this key is tooling, and is NOT the In-App Purchase key the backend uses at
 * runtime (`APPLE_STORE_KEY_ID` / `APPLE_STORE_ISSUER_ID`). A key from the wrong section
 * authenticates here and then 401s against the App Store Server API.
 *
 * Commands:
 *   apps                    app records this key can see
 *   state                   groups, products, localizations, availability and prices as they are
 *   create                  subscription group + product + en-US localization (no price)
 *   pricepoints             US ladder near the target, and the cheapest point clearing the net floor
 *   availability            sell it in every territory Apple has (required before any price)
 *   setprice <pricePointId> price one territory, explicitly
 *   worldwide <pricePointId> price every territory from that point's equalization table
 *
 * WHAT THIS CANNOT DO, because Apple exposes no endpoint for it:
 *   - create the app record itself (only the bundle id); that is console or fastlane
 *   - sign the Paid Applications agreement, or report whether it is signed
 *   - upload the review screenshot that clears MISSING_METADATA
 *
 * Nothing here guesses. A step that cannot complete exactly as specified throws with Apple's own
 * error body attached; it never substitutes a near-enough value.
 */
import { sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The one product this install sells. Permanent — Apple will not rename or reuse a product id. */
const BUNDLE_ID = 'com.stewra.app';
const PRODUCT_ID = 'com.stewra.app.pro.monthly';
const GROUP_REFERENCE = 'Stewra';
const GROUP_CUSTOMER_NAME = 'Stewra';
const SUBSCRIPTION_REFERENCE = 'Stewra Pro Monthly';
const SUBSCRIPTION_DISPLAY_NAME = 'Stewra Pro';
/** Apple caps this at 55 characters and rejects the whole request if it is longer. */
const SUBSCRIPTION_DESCRIPTION = 'Your assistant for calendar, mail, money and WhatsApp.';
const LOCALE = 'en-US';
const TERRITORY = 'USA';
/**
 * The floor that actually matters. $149 net per month; the listed price is whatever preserves it
 * after Apple's commission, which is why no price is hardcoded here.
 */
const NET_FLOOR_USD = 149;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. This script has no default and will not invent one.`);
  }
  return value;
}

const ISSUER_ID = required('ASC_ISSUER_ID');
const KEY_ID = required('ASC_KEY_ID');
const PRIVATE_KEY = readFileSync(required('ASC_KEY_PATH'), 'utf8');

function bearer() {
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  // 20 minutes is Apple's ceiling for this audience; 15 keeps clock skew from mattering.
  const input = `${enc({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${enc({
    iss: ISSUER_ID,
    iat: now,
    exp: now + 900,
    aud: 'appstoreconnect-v1',
  })}`;
  // ieee-p1363 is the raw r||s encoding JWS wants; the default DER is rejected as malformed.
  const signature = cryptoSign('sha256', Buffer.from(input), {
    key: PRIVATE_KEY,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

async function api(method, path, body) {
  const url = path.startsWith('http') ? path : `https://api.appstoreconnect.apple.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${bearer()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Apple's error body IS the diagnosis (missing role, duplicate product id, unavailable
    // territory). Passing it through beats any summary this script could write.
    throw new Error(`${method} ${path.slice(0, 80)} -> ${res.status}\n${text}`);
  }
  return text === '' ? null : JSON.parse(text);
}

/** Follows `links.next`. Price points run to 800 rows per territory, so this is not optional. */
async function apiAll(path) {
  const data = [];
  const included = [];
  let next = path;
  while (next !== null && next !== undefined) {
    const page = await api('GET', next);
    if (Array.isArray(page.data)) data.push(...page.data);
    else data.push(page.data);
    if (page.included !== undefined) included.push(...page.included);
    next = page.links?.next ?? null;
  }
  return { data, included };
}

async function findApp() {
  const { data: apps } = await apiAll(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=200`,
  );
  const app = apps.find((a) => a.attributes.bundleId === BUNDLE_ID);
  if (app === undefined) {
    throw new Error(
      `No App Store Connect app record for ${BUNDLE_ID}. The API cannot create one — an app ` +
        `record is made in the console (My Apps -> +) or with fastlane. Visible to this key: ` +
        `${apps.map((a) => a.attributes.bundleId).join(', ') || "(none — check the key's role)"}`,
    );
  }
  return app;
}

async function findGroup(appId) {
  const { data } = await apiAll(`/v1/apps/${appId}/subscriptionGroups?limit=200`);
  return data.find((g) => g.attributes.referenceName === GROUP_REFERENCE) ?? null;
}

async function findSubscription(groupId) {
  const { data } = await apiAll(`/v1/subscriptionGroups/${groupId}/subscriptions?limit=200`);
  return data.find((s) => s.attributes.productId === PRODUCT_ID) ?? null;
}

/** Every command below this point needs the product; resolving it once keeps the errors uniform. */
async function requireSubscription() {
  const app = await findApp();
  const group = await findGroup(app.id);
  if (group === null) throw new Error(`No subscription group "${GROUP_REFERENCE}" — run \`create\`.`);
  const sub = await findSubscription(group.id);
  if (sub === null) throw new Error(`No subscription ${PRODUCT_ID} — run \`create\`.`);
  return { app, group, sub };
}

const command = process.argv[2];

if (command === 'apps') {
  const { data: apps } = await apiAll('/v1/apps?limit=200');
  console.log(`${apps.length} app record(s) visible to this key:`);
  for (const a of apps) console.log(`  ${a.attributes.bundleId}  "${a.attributes.name}"  id=${a.id}`);
} else if (command === 'state') {
  const { app, group, sub } = await requireSubscription();
  console.log(`app "${app.attributes.name}"  ${app.attributes.bundleId}  id=${app.id}`);
  console.log(`group "${group.attributes.referenceName}"  id=${group.id}`);
  const a = sub.attributes;
  console.log(`  ${a.productId}  "${a.name}"  ${a.subscriptionPeriod}  state=${a.state}  id=${sub.id}`);
  const { data: locales } = await apiAll(`/v1/subscriptions/${sub.id}/subscriptionLocalizations?limit=200`);
  for (const l of locales) {
    console.log(`  localization ${l.attributes.locale}: "${l.attributes.name}" — ${l.attributes.description}`);
  }
  const { data: avail } = await apiAll(`/v1/subscriptions/${sub.id}/subscriptionAvailability`);
  if (avail.length === 0 || avail[0] === null) {
    console.log('  availability: NONE — no price can be set until this exists');
  } else {
    const { data: terr } = await apiAll(
      `/v1/subscriptionAvailabilities/${avail[0].id}/availableTerritories?limit=200`,
    );
    console.log(
      `  availability: ${terr.length} territories, new territories ` +
        `${avail[0].attributes.availableInNewTerritories ? 'auto-enrolled' : 'NOT auto-enrolled'}`,
    );
  }
  const prices = await apiAll(`/v1/subscriptions/${sub.id}/prices?include=subscriptionPricePoint,territory&limit=200`);
  console.log(`  prices: ${prices.data.length} territories`);
  const points = prices.included.filter((i) => i.type === 'subscriptionPricePoints');
  for (const code of [TERRITORY, 'GBR', 'DEU', 'IND', 'JPN']) {
    const row = prices.data.find((r) => r.relationships.territory?.data?.id === code);
    if (row === undefined) continue;
    const pp = points.find((p) => p.id === row.relationships.subscriptionPricePoint.data.id);
    console.log(`    ${code}: ${pp?.attributes.customerPrice} (proceeds ${pp?.attributes.proceeds}, local currency)`);
  }
} else if (command === 'create') {
  const app = await findApp();
  console.log(`app "${app.attributes.name}" id=${app.id}`);

  let group = await findGroup(app.id);
  if (group === null) {
    group = (
      await api('POST', '/v1/subscriptionGroups', {
        data: {
          type: 'subscriptionGroups',
          attributes: { referenceName: GROUP_REFERENCE },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      })
    ).data;
    console.log(`created group "${GROUP_REFERENCE}" id=${group.id}`);
  } else {
    console.log(`group "${GROUP_REFERENCE}" already exists id=${group.id}`);
  }

  // Localization is checked independently of creation: a run that created the group and then failed
  // on the text would otherwise skip this forever on every later run.
  const { data: groupLocales } = await apiAll(
    `/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations?limit=200`,
  );
  if (groupLocales.some((l) => l.attributes.locale === LOCALE)) {
    console.log(`  group already localized for ${LOCALE}`);
  } else {
    await api('POST', '/v1/subscriptionGroupLocalizations', {
      data: {
        type: 'subscriptionGroupLocalizations',
        attributes: { name: GROUP_CUSTOMER_NAME, locale: LOCALE },
        relationships: { subscriptionGroup: { data: { type: 'subscriptionGroups', id: group.id } } },
      },
    });
    console.log(`  localized group -> "${GROUP_CUSTOMER_NAME}" (${LOCALE})`);
  }

  let sub = await findSubscription(group.id);
  if (sub === null) {
    sub = (
      await api('POST', '/v1/subscriptions', {
        data: {
          type: 'subscriptions',
          attributes: {
            name: SUBSCRIPTION_REFERENCE,
            productId: PRODUCT_ID,
            subscriptionPeriod: 'ONE_MONTH',
            familySharable: false,
            // One tier today, so level 1 is the only level in the group.
            groupLevel: 1,
          },
          relationships: { group: { data: { type: 'subscriptionGroups', id: group.id } } },
        },
      })
    ).data;
    console.log(`created subscription ${PRODUCT_ID} id=${sub.id}`);
  } else {
    console.log(`subscription ${PRODUCT_ID} already exists id=${sub.id}`);
  }

  const { data: subLocales } = await apiAll(`/v1/subscriptions/${sub.id}/subscriptionLocalizations?limit=200`);
  if (subLocales.some((l) => l.attributes.locale === LOCALE)) {
    console.log(`  already localized for ${LOCALE}`);
  } else {
    await api('POST', '/v1/subscriptionLocalizations', {
      data: {
        type: 'subscriptionLocalizations',
        attributes: {
          name: SUBSCRIPTION_DISPLAY_NAME,
          description: SUBSCRIPTION_DESCRIPTION,
          locale: LOCALE,
        },
        relationships: { subscription: { data: { type: 'subscriptions', id: sub.id } } },
      },
    });
    console.log(`  localized -> "${SUBSCRIPTION_DISPLAY_NAME}" (${LOCALE})`);
  }
  console.log(`\nnext: \`availability\`, then \`pricepoints\`, then \`worldwide <id>\`.`);
  console.log(`APPLE_STORE_PRODUCT_ID=${PRODUCT_ID}`);
  console.log(`EXPO_PUBLIC_STORE_PRODUCT_ID_IOS=${PRODUCT_ID}`);
} else if (command === 'pricepoints') {
  const { sub } = await requireSubscription();
  const { data: points } = await apiAll(
    `/v1/subscriptions/${sub.id}/pricePoints?filter[territory]=${TERRITORY}&limit=200`,
  );
  const rows = points.map((p) => ({
    id: p.id,
    price: Number(p.attributes.customerPrice),
    proceeds: Number(p.attributes.proceeds),
  }));
  // Apple sells from a fixed ladder, so "the price we want" is not always available. The question
  // that survives that is: what is the cheapest listed price whose proceeds still clear the floor?
  const clearing = rows.filter((p) => p.proceeds >= NET_FLOOR_USD).sort((a, b) => a.price - b.price);
  const best = clearing[0];
  console.log(`${rows.length} ${TERRITORY} price points; net floor $${NET_FLOOR_USD}.`);
  if (best === undefined) {
    console.log(`  NONE of them net $${NET_FLOOR_USD}.`);
  } else {
    const under = rows.filter((p) => p.price < best.price).sort((a, b) => b.price - a.price)[0];
    console.log(
      `  cheapest clearing the floor: $${best.price.toFixed(2)} -> proceeds ` +
        `$${best.proceeds.toFixed(2)} (margin $${(best.proceeds - NET_FLOOR_USD).toFixed(2)})`,
    );
    console.log(`  id=${best.id}`);
    if (under !== undefined) {
      console.log(
        `  next one down, $${under.price.toFixed(2)}, nets $${under.proceeds.toFixed(2)} — short by ` +
          `$${(NET_FLOOR_USD - under.proceeds).toFixed(2)}.`,
      );
    }
  }
} else if (command === 'availability') {
  // A price is per-territory, and Apple refuses one in a territory the product is not sold in. The
  // error it returns for that says only RELATIONSHIP.INVALID and names neither cause nor fix, so
  // this runs first, always.
  const { sub } = await requireSubscription();
  const { data: territories } = await apiAll('/v1/territories?limit=200');
  const created = await api('POST', '/v1/subscriptionAvailabilities', {
    data: {
      type: 'subscriptionAvailabilities',
      attributes: { availableInNewTerritories: true },
      relationships: {
        subscription: { data: { type: 'subscriptions', id: sub.id } },
        availableTerritories: {
          data: territories.map((t) => ({ type: 'territories', id: t.id })),
        },
      },
    },
  });
  console.log(`availability set: ${territories.length} territories, new ones auto-enrolled (id=${created.data.id})`);
} else if (command === 'setprice' || command === 'worldwide') {
  const pricePointId = process.argv[3];
  if (pricePointId === undefined) {
    throw new Error(`usage: ${command} <pricePointId>  (take one from \`pricepoints\`)`);
  }
  const { sub } = await requireSubscription();
  const priced = new Set(
    (await apiAll(`/v1/subscriptions/${sub.id}/prices?include=territory&limit=200`)).included
      .filter((i) => i.type === 'territories')
      .map((i) => i.id),
  );

  const targets =
    command === 'setprice'
      ? [{ id: pricePointId, territory: null }]
      : // Apple's own equalization table — the API behind the console's "generate prices for other
        // storefronts" button. These are local-currency prices whose proceeds are local-currency
        // too, so the net floor is a US guarantee and not a worldwide one.
        (await apiAll(`/v1/subscriptionPricePoints/${pricePointId}/equalizations?include=territory&limit=200`)).data.map(
          (p) => ({ id: p.id, territory: p.relationships?.territory?.data?.id ?? null }),
        );

  let done = 0;
  let skipped = 0;
  const failed = [];
  for (const target of targets) {
    if (target.territory !== null && priced.has(target.territory)) {
      skipped++;
      continue;
    }
    try {
      await api('POST', '/v1/subscriptionPrices', {
        data: {
          type: 'subscriptionPrices',
          attributes: { preserveCurrentPrice: false },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: sub.id } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: target.id } },
          },
        },
      });
      done++;
    } catch (err) {
      failed.push(`${target.territory ?? target.id}: ${String(err.message).split('\n')[0]}`);
    }
  }
  console.log(`priced ${done}, already priced ${skipped}, failed ${failed.length}`);
  for (const f of failed) console.log(`  ${f}`);
  // A partial run is a real outcome, not a warning: half a world priced is a state somebody has to
  // finish, so it exits non-zero rather than reading as success in CI or in a scrollback.
  if (failed.length > 0) process.exit(1);
} else {
  console.log('commands: apps | state | create | pricepoints | availability | setprice <id> | worldwide <id>');
  process.exit(2);
}
