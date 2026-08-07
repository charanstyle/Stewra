import React from 'react';
import { Link } from 'react-router';
import styles from './LegalPage.module.css';
import { COMPANY_NAME, LAST_UPDATED, PRODUCT_NAME } from './company';
import { StewraMark } from '../../components/StewraMark/StewraMark';

export interface TocEntry {
  readonly id: string;
  readonly label: string;
}

interface LegalShellProps {
  readonly title: string;
  readonly lede: React.ReactNode;
  readonly toc: readonly TocEntry[];
  readonly children: React.ReactNode;
}

/**
 * The frame both legal documents share: identity at the top, a table of contents, and cross-links
 * at the bottom.
 *
 * These two pages are deliberately **public** — mounted outside `ProtectedRoute`. Meta's App Review
 * opens the privacy policy logged out, and "the URL redirects to a sign-in screen" is one of the
 * most common review rejections there is. It is also just correct: someone deciding whether to hand
 * us their data should not have to hand us their email address first.
 */
export const LegalShell: React.FC<LegalShellProps> = ({ title, lede, toc, children }) => (
  <div className={styles.page}>
    <header className={styles.header}>
      <Link to="/" className={styles.brand}>
        <StewraMark size={28} />
        {PRODUCT_NAME}
      </Link>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.updated}>
        Last updated {LAST_UPDATED} · {PRODUCT_NAME} is operated by {COMPANY_NAME}
      </p>
      <p className={styles.lede}>{lede}</p>
    </header>

    <nav className={styles.toc} aria-label="Contents">
      <ol className={styles.tocList}>
        {toc.map((entry) => (
          <li key={entry.id}>
            <a href={`#${entry.id}`}>{entry.label}</a>
          </li>
        ))}
      </ol>
    </nav>

    {children}

    <footer className={styles.footer}>
      <Link to="/privacy">Privacy policy</Link>
      <Link to="/terms">Terms of service</Link>
      <Link to="/">Back to {PRODUCT_NAME}</Link>
    </footer>
  </div>
);

interface SectionProps {
  readonly id: string;
  readonly heading: string;
  readonly children: React.ReactNode;
}

export const Section: React.FC<SectionProps> = ({ id, heading, children }) => (
  <section id={id} className={styles.section}>
    <h2 className={styles.heading}>{heading}</h2>
    {children}
  </section>
);
