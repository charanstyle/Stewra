import React from 'react';
import { LegalShell, Section, type TocEntry } from './LegalShell';
import styles from './LegalPage.module.css';
import { COMPANY_NAME, CONTACT_EMAIL, PRODUCT_NAME } from './company';

// The privacy policy. Written against what the system actually does rather than from a template:
// the vault, the model providers, the 24-hour WhatsApp window and the two-controller split are all
// real properties of this codebase, and Meta's App Review checks that a policy describes the
// permissions the app requested. A generic policy is a rejection.

const TOC: readonly TocEntry[] = [
  { id: 'who-we-are', label: 'Who we are' },
  { id: 'two-roles', label: 'The two roles we play' },
  { id: 'collect', label: 'What we collect' },
  { id: 'use', label: 'How we use it' },
  { id: 'sharing', label: 'Who we share it with' },
  { id: 'security', label: 'Where it lives, and security' },
  { id: 'retention', label: 'How long we keep it' },
  { id: 'rights', label: 'Your rights' },
  { id: 'delete', label: 'Deleting your data' },
  { id: 'whatsapp', label: 'WhatsApp and Meta' },
  { id: 'browser', label: 'Cookies and browser storage' },
  { id: 'children', label: 'Children' },
  { id: 'changes', label: 'Changes to this policy' },
  { id: 'contact', label: 'Contact us' },
];

const PrivacyPage: React.FC = () => (
  <LegalShell
    title="Privacy policy"
    toc={TOC}
    lede={
      <>
        {PRODUCT_NAME} handles messages, and messages are among the most personal data there is. This
        policy says plainly what we collect, why, who else ever sees it, and how to make us delete it.
      </>
    }
  >
    <Section id="who-we-are" heading="Who we are">
      <p>
        {PRODUCT_NAME} is operated by {COMPANY_NAME}. For the purposes of the UK GDPR and the Data
        Protection Act 2018, {COMPANY_NAME} is the data controller for the personal data described in
        this policy, except where section 2 says otherwise.
      </p>
      <p>
        You can reach us about anything in this policy at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </Section>

    <Section id="two-roles" heading="The two roles we play">
      <p>
        {PRODUCT_NAME} does two different jobs, and the privacy relationship is different in each.
        This distinction matters, so it comes before everything else.
      </p>

      <h3 className={styles.subheading}>1. Your personal assistant — we are the controller</h3>
      <p>
        When you use {PRODUCT_NAME} for yourself — messaging, calls, memory, connected email and
        calendar — we decide how that data is handled, and everything in this policy applies to us
        directly.
      </p>

      <h3 className={styles.subheading}>2. A business platform — we are the processor</h3>
      <p>
        When a business uses {PRODUCT_NAME} to talk to <em>its own</em> customers, that business is
        the controller of its customers&apos; data and we are its processor. We act on that
        business&apos;s instructions. If you are a member of the public who messaged a business
        through {PRODUCT_NAME} and you want your data deleted, the fastest route is to ask that
        business — though you can also write to us and we will pass it on and help.
      </p>
      <div className={styles.callout}>
        <p>
          <strong>If you are that business:</strong> you are responsible for having a lawful basis to
          message the people you message, for honouring opt-outs, and for your own privacy notice to
          your customers. Our terms set this out in full, and it is not a formality — it is the
          condition on which your account exists.
        </p>
      </div>
    </Section>

    <Section id="collect" heading="What we collect">
      <h3 className={styles.subheading}>Account information</h3>
      <p>
        Your email address, your display name, and a password we keep only in bcrypt-hashed form — we
        never hold your password itself and cannot recover it. Also the timestamps and IP-derived
        metadata that come with signing in.
      </p>

      <h3 className={styles.subheading}>What you send and receive</h3>
      <p>
        Messages, conversations and contacts you create in {PRODUCT_NAME}. Voice notes you record for
        the assistant are transcribed to text, and the transcript is stored with the conversation.
        Audio and video calls are carried peer-to-peer between the participants&apos; devices and are{' '}
        <strong>not recorded or stored by us</strong>; we hold only the fact that a call happened, when,
        and with whom.
      </p>

      <h3 className={styles.subheading}>Things you choose to connect</h3>
      <p>
        If you connect a Google account, we access the Gmail and Calendar data the permissions you
        granted allow, in order to do what you asked for. If you connect a WhatsApp Business account,
        we access the messages and contact details of the people who message that number. Connecting
        anything is always your action, we only ever request the narrowest permissions the feature
        needs, and disconnecting stops the access immediately.
      </p>

      <h3 className={styles.subheading}>What the assistant remembers</h3>
      <p>
        {PRODUCT_NAME} derives and stores facts from your conversations so it can be useful later.
        Everything it has remembered is visible to you on the Memory page, and you can edit or delete
        any of it.
      </p>

      <h3 className={styles.subheading}>Technical and diagnostic data</h3>
      <p>
        Error reports, performance traces and server logs, used to find and fix faults. These can
        incidentally contain identifiers like a user id or a request path.
      </p>
      <p>
        We do <strong>not</strong> use advertising trackers, we do not sell personal data, and we do
        not build profiles for advertising.
      </p>
    </Section>

    <Section id="use" heading="How we use it">
      <ul>
        <li>To provide the service you asked for — delivering messages, connecting calls, running the assistant.</li>
        <li>To authenticate you and keep your account secure.</li>
        <li>To send transactional email like verification and security notices.</li>
        <li>To diagnose faults and improve reliability.</li>
        <li>To meet legal obligations and enforce our terms.</li>
      </ul>
      <p>
        Our lawful bases are <strong>performance of a contract</strong> (providing the service you
        signed up for), <strong>legitimate interests</strong> (security, fault diagnosis, preventing
        abuse), <strong>consent</strong> (anything you explicitly connect, which you can withdraw at
        any time), and <strong>legal obligation</strong> where one applies.
      </p>
      <p>
        We do not use the content of your messages to train machine-learning models, and we do not
        permit our providers to do so on our behalf.
      </p>
    </Section>

    <Section id="sharing" heading="Who we share it with">
      <p>
        We share personal data only with the providers needed to run the service, and only what each
        one needs.
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Who</th>
              <th>What they receive</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>AI model providers (Anthropic, and where configured OpenAI, Google or xAI)</td>
              <td>The content of the turn being processed, plus the context the assistant needs to answer it</td>
              <td>Generating the assistant&apos;s replies. Nothing is sent unless you use the assistant.</td>
            </tr>
            <tr>
              <td>Meta Platforms</td>
              <td>WhatsApp message content and the phone numbers of sender and recipient</td>
              <td>Delivering WhatsApp messages. Unavoidable — Meta operates the network.</td>
            </tr>
            <tr>
              <td>Google</td>
              <td>Only the Gmail and Calendar scopes you granted</td>
              <td>Only if you connect a Google account.</td>
            </tr>
            <tr>
              <td>Sentry</td>
              <td>Error and performance diagnostics</td>
              <td>Detecting and fixing faults.</td>
            </tr>
            <tr>
              <td>Our email provider</td>
              <td>Your address and the message being sent</td>
              <td>Verification and security email.</td>
            </tr>
            <tr>
              <td>Hosting and infrastructure</td>
              <td>Data at rest and in transit on servers we control</td>
              <td>Running the service.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        We may also disclose data where the law requires it, or to establish or defend legal claims.
        If we are ever involved in a merger or acquisition, we will tell you before your data moves.
      </p>
      <p>
        Some of these providers are outside the UK and EEA — Meta and the model providers in
        particular. Where personal data is transferred internationally we rely on the UK
        International Data Transfer Agreement, the UK Addendum to the EU Standard Contractual Clauses,
        or an adequacy decision, whichever applies.
      </p>
    </Section>

    <Section id="security" heading="Where it lives, and security">
      <p>
        Data is held in a PostgreSQL database on infrastructure we control, and moves over TLS.
        Specifically:
      </p>
      <ul>
        <li>
          <strong>Third-party credentials are encrypted at rest</strong> with AES-256-GCM in a
          dedicated vault. Access tokens for your Google account or your WhatsApp Business account are
          never stored in plaintext and are never returned to the browser.
        </li>
        <li>
          <strong>Passwords are bcrypt-hashed</strong>, never stored or logged in any recoverable form.
        </li>
        <li>
          <strong>Sessions use short-lived tokens</strong> that expire and are refreshed, so a leaked
          token has a limited life.
        </li>
        <li>
          <strong>Sensitive actions are written to an append-only audit log</strong> that the
          application cannot rewrite.
        </li>
      </ul>
      <p>
        No system is perfectly secure, and we will not pretend otherwise. If a breach affects your
        rights and freedoms we will notify the ICO within 72 hours and tell you without undue delay.
      </p>
    </Section>

    <Section id="retention" heading="How long we keep it">
      <ul>
        <li><strong>Account data</strong> — while your account exists, then deleted on request or on closure.</li>
        <li><strong>Messages and conversations</strong> — until you delete them or close your account.</li>
        <li><strong>Bridged personal WhatsApp messages</strong> — a rolling window, 30 days by default.</li>
        <li><strong>Diagnostic logs and error reports</strong> — up to 90 days.</li>
        <li><strong>Audit records</strong> — retained where we have a legal or security obligation to.</li>
      </ul>
      <p>
        Backups are deleted on their own cycle, so data you delete may persist in a backup for a short
        period after it disappears from the live service.
      </p>
    </Section>

    <Section id="rights" heading="Your rights">
      <p>Under UK data protection law you have the right to:</p>
      <ul>
        <li>be told what we hold about you, and get a copy of it;</li>
        <li>have inaccurate data corrected;</li>
        <li>have your data deleted;</li>
        <li>restrict or object to how we process it;</li>
        <li>receive your data in a portable, machine-readable form;</li>
        <li>withdraw consent at any time, without that affecting what was lawful before you did.</li>
      </ul>
      <p>
        Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will respond within
        one month. There is no charge. If you are unhappy with our response you can complain to the
        Information Commissioner&apos;s Office at <a href="https://ico.org.uk" rel="noreferrer">ico.org.uk</a>,
        but we would rather you gave us the chance to put it right first.
      </p>
    </Section>

    <Section id="delete" heading="Deleting your data">
      <div className={styles.callout}>
        <p>
          <strong>To delete everything:</strong> email{' '}
          <a href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20data`}>{CONTACT_EMAIL}</a> from the
          address on your account, with the subject &quot;Delete my data&quot;. We will verify it is
          you, delete your account and all associated personal data within 30 days, and confirm in
          writing when it is done. Backups age out within a further 30 days.
        </p>
      </div>
      <p>
        <strong>To delete part of it, yourself, right now:</strong>
      </p>
      <ul>
        <li>Individual memories — the Memory page, delete any entry.</li>
        <li>Conversations and messages — delete them in the app.</li>
        <li>
          A connected Google account — disconnect it in Activity. This revokes our token with Google
          immediately. You can also revoke it from{' '}
          <a href="https://myaccount.google.com/permissions" rel="noreferrer">
            your Google account permissions
          </a>
          .
        </li>
        <li>
          A connected WhatsApp Business account — disconnect it on the Commerce page. This deletes the
          stored access token and stops all further access to that account.
        </li>
      </ul>
      <p>
        If a business messaged you through {PRODUCT_NAME} and you want that business to erase you, ask
        the business directly — they control that data and we act on their instructions. Write to us
        too if you would like help reaching them.
      </p>
    </Section>

    <Section id="whatsapp" heading="WhatsApp and Meta">
      <p>
        {PRODUCT_NAME} connects to WhatsApp through Meta&apos;s official WhatsApp Business Platform.
        Some specifics worth stating plainly:
      </p>
      <ul>
        <li>
          <strong>We never ask for your WhatsApp password</strong>, because no such thing is involved.
          Connecting a business account happens inside Meta&apos;s own dialog and grants us a scoped
          token which you can revoke at any time from your Meta Business settings.
        </li>
        <li>
          <strong>We request only two permissions</strong> — to manage and to send from the WhatsApp
          Business account you choose. We do not request access to your Facebook Pages, your ad
          accounts, your catalogues or your Instagram accounts.
        </li>
        <li>
          <strong>Message content passes through Meta</strong>, which operates the network and applies
          its own privacy terms. Meta&apos;s handling of that data is governed by their policies, not
          ours.
        </li>
        <li>
          <strong>Meta enforces a 24-hour service window.</strong> Outside it, a business can only
          reach a customer with a message template Meta has pre-approved — a deliberate anti-spam
          control, and one we do not attempt to work around.
        </li>
      </ul>
    </Section>

    <Section id="browser" heading="Cookies and browser storage">
      <p>
        We do not use advertising or analytics cookies, so there is no consent banner to dismiss. We
        store your session tokens in your browser&apos;s local storage because the app cannot keep you
        signed in without them. Clearing your browser storage signs you out.
      </p>
    </Section>

    <Section id="children" heading="Children">
      <p>
        {PRODUCT_NAME} is not intended for anyone under 16, and we do not knowingly collect their
        data. If you believe a child has given us personal data, tell us and we will delete it.
      </p>
    </Section>

    <Section id="changes" heading="Changes to this policy">
      <p>
        When this policy changes we update the date at the top. If a change materially affects how we
        handle your data, we will tell you in the app or by email before it takes effect, rather than
        relying on you to notice.
      </p>
    </Section>

    <Section id="contact" heading="Contact us">
      <p>
        {COMPANY_NAME} · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
      <p>
        For a data protection question, a deletion request, or a complaint, that address reaches a
        person, not a queue.
      </p>
    </Section>
  </LegalShell>
);

export default PrivacyPage;
