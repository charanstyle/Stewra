import React from 'react';
import { LegalShell, Section, type TocEntry } from './LegalShell';
import styles from './LegalPage.module.css';
import { COMPANY_NAME, CONTACT_EMAIL, PRODUCT_NAME } from './company';

// The terms of service. Section 6 is the one that matters commercially: a business connecting its
// WhatsApp account is taking on the consent and opt-in obligations, and both Meta's policies and UK
// law hold it there. Stating that plainly is what makes it enforceable, and Meta's App Review reads
// these terms to check we have not promised customers something their platform forbids.

const TOC: readonly TocEntry[] = [
  { id: 'who', label: 'Who we are' },
  { id: 'accept', label: 'Accepting these terms' },
  { id: 'service', label: 'What Stewra provides' },
  { id: 'account', label: 'Your account' },
  { id: 'acceptable', label: 'Acceptable use' },
  { id: 'business', label: 'Using Stewra for your business' },
  { id: 'platforms', label: 'Third-party platforms' },
  { id: 'fees', label: 'Fees and messaging charges' },
  { id: 'availability', label: 'Availability' },
  { id: 'ip', label: 'Intellectual property' },
  { id: 'liability', label: 'Liability' },
  { id: 'termination', label: 'Suspension and termination' },
  { id: 'law', label: 'Governing law' },
  { id: 'changes', label: 'Changes to these terms' },
  { id: 'contact', label: 'Contact us' },
];

const TermsPage: React.FC = () => (
  <LegalShell
    title="Terms of service"
    toc={TOC}
    lede={
      <>
        These terms are the agreement between you and {COMPANY_NAME} for your use of {PRODUCT_NAME}.
        Section 6 is the one to read closely if you are connecting a business account — it sets out
        obligations you take on personally.
      </>
    }
  >
    <Section id="who" heading="Who we are">
      <p>
        {PRODUCT_NAME} is operated by {COMPANY_NAME}. In these terms, &quot;we&quot;, &quot;us&quot;
        and &quot;our&quot; mean {COMPANY_NAME}; &quot;you&quot; means the person or organisation
        using {PRODUCT_NAME}.
      </p>
      <p>
        How we handle personal data is covered separately in our{' '}
        <a href="/privacy">privacy policy</a>, which forms part of these terms.
      </p>
    </Section>

    <Section id="accept" heading="Accepting these terms">
      <p>
        Creating an account, or using {PRODUCT_NAME} in any way, means you accept these terms. If you
        are agreeing on behalf of an organisation, you confirm you have authority to bind it, and
        &quot;you&quot; then means that organisation.
      </p>
      <p>You must be at least 16 years old to use {PRODUCT_NAME}.</p>
    </Section>

    <Section id="service" heading="What Stewra provides">
      <p>{PRODUCT_NAME} is two things sharing one account:</p>
      <ul>
        <li>
          <strong>A personal assistant</strong> — messaging, calls, memory, and optional connections
          to your own email and calendar, acting on your instructions.
        </li>
        <li>
          <strong>A commercial messaging platform</strong> — letting a business connect its own
          WhatsApp Business account and run its customer conversations, campaigns and follow-up
          through {PRODUCT_NAME}.
        </li>
      </ul>
      <p>
        We build features, retire features and change how they work. Where a change materially reduces
        something you rely on, we will give reasonable notice.
      </p>
      <div className={styles.callout}>
        <p>
          <strong>The assistant makes mistakes.</strong> {PRODUCT_NAME} uses large language models,
          which can be confidently wrong. Check anything that matters — money, deadlines, legal or
          medical decisions, or messages going to your customers — before you rely on it. You remain
          responsible for what is sent from your account.
        </p>
      </div>
    </Section>

    <Section id="account" heading="Your account">
      <ul>
        <li>Give accurate registration details and keep them current.</li>
        <li>Keep your password and devices secure; you are responsible for activity under your account.</li>
        <li>Tell us promptly at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> if you suspect unauthorised access.</li>
        <li>Do not share one account between people who should have their own.</li>
      </ul>
    </Section>

    <Section id="acceptable" heading="Acceptable use">
      <p>You must not use {PRODUCT_NAME} to:</p>
      <ul>
        <li>send unsolicited bulk messages, or message anyone who has not opted in or has opted out;</li>
        <li>break any law, or infringe anyone&apos;s rights;</li>
        <li>impersonate a person or organisation, or misrepresent who a message is from;</li>
        <li>send malware, run phishing, or attempt fraud;</li>
        <li>harass, threaten, or distribute material that sexualises children or incites violence;</li>
        <li>circumvent rate limits, opt-out handling, or any platform policy that applies to a connected channel;</li>
        <li>probe or attack our infrastructure, or attempt to access another customer&apos;s data;</li>
        <li>resell or white-label {PRODUCT_NAME} without our written agreement.</li>
      </ul>
      <p>
        We may suspend an account immediately where we reasonably believe one of these is happening,
        because the alternative is our whole platform losing access to the networks everyone depends on.
      </p>
    </Section>

    <Section id="business" heading="Using Stewra for your business">
      <div className={styles.callout}>
        <p>
          <strong>You are the data controller for your customers.</strong> We process their data on
          your instructions. That means the obligations below are yours, not ours, and we cannot
          discharge them for you.
        </p>
      </div>
      <p>By connecting a business messaging account, you confirm and agree that:</p>
      <ul>
        <li>
          <strong>You have a lawful basis to message every person you message.</strong> For marketing
          messages under UK PECR and the UK GDPR, that normally means prior explicit opt-in, and you
          must be able to evidence when and how it was given.
        </li>
        <li>
          <strong>You honour opt-outs promptly.</strong> When somebody asks to stop, they stop —
          across every channel, not only the one they asked on.
        </li>
        <li>
          <strong>You own or are authorised to use the account you connect.</strong> You must not
          connect a WhatsApp Business account, phone number or brand that is not yours to connect.
        </li>
        <li>
          <strong>You give your own customers a privacy notice</strong> covering the fact that a
          processor handles their messages on your behalf.
        </li>
        <li>
          <strong>You comply with the platform policies of every channel you use</strong>, including
          the WhatsApp Business Messaging Policy and Meta&apos;s Commerce Policies.
        </li>
        <li>
          <strong>You are responsible for the content of your messages</strong>, including any drafted
          or suggested by the assistant.
        </li>
      </ul>
      <p>
        You indemnify us against claims, fines and costs arising from your breach of this section. We
        say that bluntly because a single customer sending unlawful bulk messages can get every
        customer&apos;s number blocked by the underlying network.
      </p>
      <p>
        Where we act for you, we do so under written processing terms. Ask us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> for a data processing agreement.
      </p>
    </Section>

    <Section id="platforms" heading="Third-party platforms">
      <p>
        {PRODUCT_NAME} connects to services we do not control — Meta&apos;s WhatsApp Business
        Platform, Google, and others you choose to link. Your use of each is also governed by that
        provider&apos;s own terms, and you must comply with them.
      </p>
      <p>
        Those providers can change their APIs, pricing, policies or approval decisions at any time,
        and can suspend or terminate access to an account for their own reasons. We are not
        responsible for their decisions, their outages, or their charges, and a change on their side
        may force a change on ours at short notice.
      </p>
    </Section>

    <Section id="fees" heading="Fees and messaging charges">
      <p>
        Where {PRODUCT_NAME} is offered on a paid plan, the price, billing period and what is included
        are the ones shown to you when you subscribe. Fees are payable in advance and, except where the
        law requires otherwise, are non-refundable for a period already started.
      </p>
      <p>
        <strong>Messaging is metered by the network, not by us.</strong> Meta charges per WhatsApp
        message on its own published rates, which it changes from time to time. Depending on your
        plan, those charges are either billed to you by Meta directly or passed through to you at
        cost. We will always tell you which arrangement applies before you send anything chargeable.
      </p>
      <p>We will give at least 30 days&apos; notice before any price increase.</p>
    </Section>

    <Section id="availability" heading="Availability">
      <p>
        We work to keep {PRODUCT_NAME} available and to protect your data, but we do not promise
        uninterrupted service. Maintenance, faults, and failures at the platforms we depend on all
        cause downtime. Unless we have separately agreed a service level with you in writing,{' '}
        {PRODUCT_NAME} is provided without warranties of any kind, to the extent the law allows.
      </p>
      <p>
        Keep your own records of anything you cannot afford to lose. We take backups for our own
        resilience; they are not a substitute for your archive.
      </p>
    </Section>

    <Section id="ip" heading="Intellectual property">
      <p>
        We own {PRODUCT_NAME} — the software, the brand, and everything in the product other than your
        content. You get a limited, non-exclusive, non-transferable right to use it while these terms
        are in force.
      </p>
      <p>
        <strong>Your content stays yours.</strong> Your messages, contacts and files remain yours, and
        you grant us only the licence needed to operate the service for you: storing, transmitting and
        processing that content to do what you asked. We do not use your content to train
        machine-learning models.
      </p>
    </Section>

    <Section id="liability" heading="Liability">
      <p>
        Nothing in these terms limits liability for death or personal injury caused by negligence, for
        fraud or fraudulent misrepresentation, or for anything else that cannot lawfully be limited.
      </p>
      <p>Subject to that:</p>
      <ul>
        <li>
          We are not liable for loss of profit, revenue, business, goodwill, or anticipated savings, or
          for indirect or consequential loss.
        </li>
        <li>
          Our total liability arising in any 12-month period is capped at the greater of the fees you
          paid us in that period, or £100.
        </li>
      </ul>
      <p>
        If you use {PRODUCT_NAME} for a business, you accept these limits are reasonable given what the
        service costs relative to the value of the messages passing through it.
      </p>
    </Section>

    <Section id="termination" heading="Suspension and termination">
      <p>
        You can close your account at any time; our <a href="/privacy#delete">deletion process</a>{' '}
        explains what happens to your data.
      </p>
      <p>
        We may suspend or terminate your account if you materially breach these terms, if we are
        required to by law or by a platform we depend on, or if your use puts other customers at risk.
        Except where a breach is serious or urgent, we will give notice and a chance to put it right
        first.
      </p>
      <p>
        On termination your right to use {PRODUCT_NAME} ends. Give us reasonable notice and we will
        help you export your data before it is deleted.
      </p>
    </Section>

    <Section id="law" heading="Governing law">
      <p>
        These terms are governed by the law of England and Wales, and the courts of England and Wales
        have exclusive jurisdiction. If you are a consumer, this does not deprive you of the
        protection of the mandatory law of the country where you live.
      </p>
      <p>
        If any provision is found unenforceable, the rest continues in force. Our not enforcing
        something immediately is not a waiver of the right to enforce it later.
      </p>
    </Section>

    <Section id="changes" heading="Changes to these terms">
      <p>
        We may update these terms. The date at the top always shows the current version. For material
        changes we will give at least 30 days&apos; notice in the app or by email, and continuing to
        use {PRODUCT_NAME} after they take effect means you accept them. If you do not, close your
        account before that date.
      </p>
    </Section>

    <Section id="contact" heading="Contact us">
      <p>
        {COMPANY_NAME} · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </Section>
  </LegalShell>
);

export default TermsPage;
