import React from 'react';
import { LegalShell, Section, type TocEntry } from './LegalShell';
import styles from './LegalPage.module.css';
import { COMPANY_NAME, CONTACT_EMAIL, PRODUCT_NAME } from './company';

/**
 * The public account-deletion page.
 *
 * Google Play's Data safety form requires a URL, reachable **without signing in**, that names the
 * app, explains how to request deletion, and says what is deleted versus retained. So this page is
 * mounted outside `ProtectedRoute` alongside the privacy policy and terms — a link that bounces a
 * reviewer to a sign-in screen is one of the most common rejections there is, and it would be
 * self-defeating here anyway: someone who has lost access to their account is exactly the person
 * most likely to be reading it.
 *
 * It must stay consistent with the in-app flow in
 * `frontend/src/components/settings/DeleteAccountCard.tsx`. If one changes, so does the other.
 */

const TOC: readonly TocEntry[] = [
  { id: 'in-app', label: 'Delete it yourself, in the app' },
  { id: 'by-email', label: 'If you cannot sign in' },
  { id: 'what-goes', label: 'What is deleted' },
  { id: 'what-stays', label: 'What is kept, and why' },
  { id: 'subscriptions', label: 'Subscriptions are separate' },
  { id: 'organizations', label: 'If you belong to an organization' },
];

const AccountDeletionPage: React.FC = () => (
  <LegalShell
    title="Deleting your account"
    toc={TOC}
    lede={
      <>
        You can delete your {PRODUCT_NAME} account and its data at any time, from inside the app,
        without asking us. This page explains exactly what that removes, the few things it does not,
        and what to do if you can no longer sign in.
      </>
    }
  >
    <Section id="in-app" heading="Delete it yourself, in the app">
      <p>
        Open {PRODUCT_NAME} and go to <strong>Settings → Danger zone → Delete account</strong>. The
        same control is on the web, under <strong>Settings</strong>.
      </p>
      <p>
        Before anything is deleted you are shown a summary of what will go — including any
        organization that would be destroyed along with you, and any store subscription that would
        keep billing you. You then re-enter your password to confirm. We ask for the password even
        though you are already signed in, because an unlocked phone is not proof of ownership and
        this cannot be undone.
      </p>
      <div className={styles.callout}>
        <p>
          <strong>Deletion is immediate and permanent.</strong> There is no grace period, no recycle
          bin and no way for us to restore the account afterwards. If you want a copy of anything,
          take it first.
        </p>
      </div>
    </Section>

    <Section id="by-email" heading="If you cannot sign in">
      <p>
        Email{' '}
        <a href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20account`}>{CONTACT_EMAIL}</a> from
        the address on the account, with the subject &quot;Delete my account&quot;. We will verify it
        is you, delete the account and all associated personal data within 30 days, and confirm in
        writing when it is done.
      </p>
      <p>
        We ask you to write from the account&apos;s own address because we have to be sure the
        request is really yours — an account-deletion request honoured for the wrong person is itself
        a serious data breach. If you no longer control that mailbox, write to us anyway and we will
        find another way to verify you.
      </p>
    </Section>

    <Section id="what-goes" heading="What is deleted">
      <p>Deleting your account permanently removes, from our systems:</p>
      <ul>
        <li>Your profile, email address and password.</li>
        <li>
          Your messages, conversations and calls, including anything stored encrypted. Messages you
          sent into a group chat that other people are still in remain in that chat, with your name
          removed — we cannot delete other participants&apos; copy of a conversation they took part
          in.
        </li>
        <li>Everything {PRODUCT_NAME} had learned about you: memories, style rules and insights.</li>
        <li>
          Files you uploaded — voice notes, images and your profile photo — erased from disk, not
          merely unlinked.
        </li>
        <li>
          Synced email and calendar data, bank account and transaction data, and the encrypted access
          tokens for every connected account.
        </li>
        <li>Push notification tokens, linked devices, and any runner container and its contents.</li>
      </ul>
      <p>
        We also actively <strong>revoke</strong> the access we hold at other companies rather than
        just forgetting it: your Google token is revoked with Google, your bank connection is removed
        at our aggregator, and any {PRODUCT_NAME} GitHub App installation is uninstalled. If one of
        those providers does not confirm, we tell you which one on the confirmation screen so you can
        check it in that provider&apos;s own security settings.
      </p>
    </Section>

    <Section id="what-stays" heading="What is kept, and why">
      <p>Two things survive, and neither identifies you afterwards:</p>
      <ul>
        <li>
          <strong>The activity log, with your name removed.</strong> {PRODUCT_NAME} keeps a
          tamper-evident record of actions taken. Deleting your account unlinks every one of your
          entries from you — the entry stays, the person does not. We do this rather than erase the
          log because a record that can be silently rewritten is not a record.
        </li>
        <li>
          <strong>Business records the law requires us to keep</strong> — invoices, for example —
          for the retention period it sets. Where those name you, the name is removed.
        </li>
      </ul>
      <p>
        Backups age out within 30 days of deletion. Until then a copy may exist in an encrypted
        backup that is never used for anything except restoring a failure.
      </p>
    </Section>

    <Section id="subscriptions" heading="Subscriptions are separate">
      <div className={styles.callout}>
        <p>
          <strong>
            If you subscribed through the App Store or Google Play, deleting your account does not
            cancel it.
          </strong>{' '}
          Only the store can — nobody else, including us, is able to stop a subscription it owns.
          Cancel it in the App Store or Google Play <em>first</em>, or you will keep being charged
          for a service you no longer have an account for. The app warns you before deleting if we
          can see an active store subscription.
        </p>
      </div>
    </Section>

    <Section id="organizations" heading="If you belong to an organization">
      <p>
        {PRODUCT_NAME} organizations are shared: a business account outlives any one person in it. So
        what happens depends on who else is there.
      </p>
      <ul>
        <li>
          <strong>Other members remain</strong> — the organization continues without you. You are
          removed from it; its customers, campaigns and history are unaffected.
        </li>
        <li>
          <strong>You are the only member</strong> — the organization is deleted with you, including
          its contacts, campaigns, templates and message history. Nobody else could ever reach it
          again, so keeping it would mean holding a customer list with no one responsible for it. The
          app names any organization in this position before you confirm.
        </li>
        <li>
          <strong>You are the only owner, but others are members</strong> — deletion is refused until
          you make someone else an owner. Otherwise the organization would be left with people in it
          and nobody able to invite, pay or administer it. Promote another owner on the Team page and
          then delete your account.
        </li>
      </ul>
      <p>
        If a business messaged you through {PRODUCT_NAME} and you want that business to erase you,
        ask the business directly — they control that data and we act on their instructions. Write to{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> too and we will help you reach them.
      </p>
      <p>
        {COMPANY_NAME} is the data controller for your personal {PRODUCT_NAME} account. The full
        detail is in our <a href="/privacy">privacy policy</a>.
      </p>
    </Section>
  </LegalShell>
);

export default AccountDeletionPage;
