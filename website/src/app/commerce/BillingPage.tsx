import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  CommerceInvoice,
  CommercePaymentMethodState,
  CommerceSubscriptionView,
  CommerceDelinquency,
} from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api } from '../../services/api';
import { useCommerceOrg } from './useCommerceOrg';
import { confirmCardSetup, loadStripe } from './stripeCardSetup';
import type { StripeCardElement } from './stripeCardSetup';
import styles from './CommercePage.module.css';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * Micros → a currency string. Every amount in this plane is bigint micros precisely so that no
 * float ever touches money; this is the one place it becomes text, and it stays integral all the
 * way to `Intl` by splitting rather than dividing.
 */
function formatMicros(micros: string, currency: string): string {
  const value = BigInt(micros);
  const whole = value / 1_000_000n;
  const fraction = value % 1_000_000n;
  const cents = Number(fraction) / 1_000_000;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
    Number(whole) + cents,
  );
}

function formatPeriod(invoice: CommerceInvoice): string {
  return new Date(`${invoice.periodStart}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Who is charging this org, in the org's own words.
 *
 * The distinction is not cosmetic. A subscription bought in the App Store is Apple's to bill,
 * cancel and refund; showing that org a card form would invite them to pay twice, and showing them
 * a Stewra invoice they can settle would be a bill that does not exist.
 */
function collectorNote(subscription: CommerceSubscriptionView): string | null {
  if (subscription.collector === 'apple') {
    return 'Apple bills this subscription. Your receipts and cancellation live in your Apple ID subscription settings — Stewra never charges this card.';
  }
  if (subscription.collector === 'google') {
    return 'Google Play bills this subscription. Your receipts and cancellation live in Play’s subscription settings — Stewra never charges this card.';
  }
  return null;
}

function delinquencyNote(delinquency: CommerceDelinquency): string | null {
  if (delinquency.state === 'current') return null;
  if (delinquency.state === 'warning') {
    return `An invoice is unpaid. Sending stops if it is still outstanding after ${delinquency.graceDays} days from its issue date.`;
  }
  return 'Sending is paused because an invoice is past due. Settling it restores sending immediately.';
}

/**
 * The org's money: what plan it is on, who bills it, the card on file, and every invoice.
 *
 * This page is the missing half of a payment system that was otherwise complete. The server could
 * open a card-capture flow and charge a stored method; nothing ever asked a customer for the card,
 * so `payment_method_ref` was never written and every charge refused before it reached the wire.
 *
 * The card is entered into Stripe's iframe. This page holds a client secret and hands back one
 * identifier — the setup's — and the server re-reads from Stripe what that setup attached. Nothing
 * here is ever in scope for a card number, and nothing this page claims about which card to charge
 * is believed.
 */
export default function BillingPage(): React.JSX.Element {
  const { orgId, role, loadError } = useCommerceOrg();

  const [subscription, setSubscription] = useState<CommerceSubscriptionView | null>(null);
  const [delinquency, setDelinquency] = useState<CommerceDelinquency | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<CommercePaymentMethodState | null>(null);
  const [invoices, setInvoices] = useState<ReadonlyArray<CommerceInvoice>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const cardMount = useRef<HTMLDivElement | null>(null);
  const cardElement = useRef<StripeCardElement | null>(null);
  const clientSecret = useRef<string | null>(null);

  const load = useCallback(async (id: string): Promise<void> => {
    const [billing, invoiceList] = await Promise.all([
      api.getOrgBilling(id),
      api.listOrgInvoices(id),
    ]);
    setSubscription(billing.subscription);
    setDelinquency(billing.delinquency);
    setPaymentMethod(billing.paymentMethod);
    setInvoices(invoiceList.invoices);
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    setError(null);
    setLoading(true);
    load(orgId)
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, [orgId, load]);

  // Tear the Stripe element down when this page goes away, so a remount does not leave an orphaned
  // iframe listening on a secret that is no longer current.
  useEffect(() => {
    return () => {
      cardElement.current?.destroy();
      cardElement.current = null;
      clientSecret.current = null;
    };
  }, []);

  const beginCapture = useCallback(async (): Promise<void> => {
    if (orgId === null || paymentMethod === null || paymentMethod.publishableKey === null) return;
    setCapturing(true);
    setError(null);
    setNotice(null);
    setCardError(null);
    try {
      const started = await api.startPaymentMethodSetup(orgId);
      clientSecret.current = started.clientSecret;
      const stripe = await loadStripe(paymentMethod.publishableKey);
      const card = stripe.elements().create('card', { hidePostalCode: false });
      card.on('change', (event) => setCardError(event.error?.message ?? null));
      const target = cardMount.current;
      if (target === null) {
        throw new Error('The card field has nowhere to mount; reload the page and try again.');
      }
      card.mount(target);
      cardElement.current = card;
    } catch (err) {
      setError(describeError(err));
      setCapturing(false);
    }
  }, [orgId, paymentMethod]);

  const saveCard = useCallback(async (): Promise<void> => {
    const card = cardElement.current;
    const secret = clientSecret.current;
    if (orgId === null || card === null || secret === null || paymentMethod === null) return;
    if (paymentMethod.publishableKey === null) return;
    setSaving(true);
    setError(null);
    setCardError(null);
    try {
      const stripe = await loadStripe(paymentMethod.publishableKey);
      const setupRef = await confirmCardSetup({ stripe, card, clientSecret: secret });
      // Only the setup id crosses this boundary. The server asks Stripe what it attached.
      const confirmed = await api.confirmPaymentMethod(orgId, { setupRef });
      setPaymentMethod(confirmed.paymentMethod);
      card.destroy();
      cardElement.current = null;
      clientSecret.current = null;
      setCapturing(false);
      setNotice('Card saved. Invoices are charged automatically from now on.');
      await load(orgId);
    } catch (err) {
      setCardError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [orgId, paymentMethod, load]);

  const cancelCapture = useCallback((): void => {
    cardElement.current?.destroy();
    cardElement.current = null;
    clientSecret.current = null;
    setCapturing(false);
    setCardError(null);
  }, []);

  const storeBilled =
    subscription !== null && (subscription.collector === 'apple' || subscription.collector === 'google');
  const canManage = role === 'owner' || role === 'admin';

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Billing</h1>
        <p className={styles.subtitle}>
          Your plan, how it is paid, and every invoice. Message charges are not billed here — Meta
          charges the payment method on your own WhatsApp Business Account directly. Templates and
          broadcasts live on <Link to="/commerce/campaigns">Campaigns</Link>.
        </p>

        {loadError !== null && <div className={styles.error}>{loadError}</div>}
        {error !== null && <div className={styles.error}>{error}</div>}
        {notice !== null && <div className={styles.notice}>{notice}</div>}
        {loading && <p className={styles.muted}>Loading…</p>}

        {!canManage && !loading && (
          <p className={styles.muted}>
            Billing is visible to owners and admins. Ask an owner of this organization if you need
            access.
          </p>
        )}

        {delinquency !== null && delinquencyNote(delinquency) !== null && (
          <div className={delinquency.state === 'delinquent' ? styles.error : styles.warning}>
            {delinquencyNote(delinquency)}
          </div>
        )}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Plan</h2>
          {subscription === null ? (
            <p className={styles.muted}>
              This organization is not on a plan yet. Nothing is being charged.
            </p>
          ) : (
            <>
              <p>
                <strong>{subscription.planName}</strong> — {}
                {formatMicros(subscription.platformFeeMicros, subscription.currency)} per month,
                charged in advance. Version {subscription.planVersion}, in force since{' '}
                {new Date(subscription.startedAt).toLocaleDateString()}.
              </p>
              {collectorNote(subscription) !== null && (
                <p className={styles.muted}>{collectorNote(subscription)}</p>
              )}
            </>
          )}
        </section>

        {/* No card section at all for a store-billed org: there is nothing here for them to do,
            and offering one would invite a second payment for the same month. */}
        {canManage && !storeBilled && paymentMethod !== null && paymentMethod.provider !== 'manual' && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Payment method</h2>
            {paymentMethod.stored ? (
              <p className={styles.muted}>
                A card is on file with Stripe. Invoices are charged automatically when they are
                issued.
              </p>
            ) : (
              <p className={styles.muted}>
                No card on file. Invoices will be issued but nothing can be collected until one is
                added.
              </p>
            )}

            {!capturing && (
              <button type="button" className={styles.primary} onClick={() => void beginCapture()}>
                {paymentMethod.stored ? 'Replace card' : 'Add a card'}
              </button>
            )}

            {/* Kept mounted whenever capturing, because Stripe's element attaches to this node. */}
            <div hidden={!capturing}>
              <div className={styles.input} ref={cardMount} />
              {cardError !== null && <div className={styles.error}>{cardError}</div>}
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={saving}
                  onClick={() => void saveCard()}
                >
                  {saving ? 'Saving…' : 'Save card'}
                </button>
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={saving}
                  onClick={cancelCapture}
                >
                  Cancel
                </button>
              </div>
              <p className={styles.muted}>
                Your card details go directly to Stripe and are never sent to or stored by Stewra.
              </p>
            </div>
          </section>
        )}

        {/* The `!storeBilled` guard repeats what the Stripe branch above does, for a sharper
            reason: this copy tells the reader to pay by transfer. Shown to an App Store subscriber
            it invites a second payment for a month Apple has already charged — and unlike a
            duplicate card charge, a bank transfer has no provider to reverse it. */}
        {canManage && !storeBilled && paymentMethod !== null && paymentMethod.provider === 'manual' && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Payment method</h2>
            <p className={styles.muted}>
              This installation settles invoices offline. There is no card to add — pay the invoice
              by transfer and it will be marked paid.
            </p>
          </section>
        )}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Invoices</h2>
          {invoices.length === 0 ? (
            <p className={styles.muted}>
              {storeBilled
                ? 'None — the App Store or Google Play issues the receipts for this subscription.'
                : 'No invoices yet.'}
            </p>
          ) : (
            <ul className={styles.list}>
              {invoices.map((invoice) => (
                <li key={invoice.id} className={styles.listRow}>
                  <span>{formatPeriod(invoice)}</span>
                  <span>{formatMicros(invoice.totalMicros, invoice.currency)}</span>
                  <span className={invoice.status === 'paid' ? styles.tag : styles.tagWarn}>
                    {invoice.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
