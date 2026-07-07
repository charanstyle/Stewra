import React from 'react';
import type { Briefing } from '@stewra/shared-types';
import styles from './BriefingCard.module.css';

interface BriefingCardProps {
  readonly briefing: Briefing | null;
}

/**
 * The natural-language "here's your day" summary at the top of the Today page. Renders nothing when
 * there's no briefing yet — TodayPage's empty state covers that case, this card only ever shows one.
 */
export const BriefingCard: React.FC<BriefingCardProps> = ({ briefing }) => {
  if (briefing === null) {
    return null;
  }

  return (
    <div className={styles.card}>
      <p className={styles.summary}>{briefing.summary}</p>
      {briefing.sections.length > 0 && (
        <div className={styles.sections}>
          {briefing.sections.map((section, i) => (
            <div key={`${section.heading}-${i}`} className={styles.section}>
              <h3 className={styles.sectionHeading}>{section.heading}</h3>
              <p className={styles.sectionBody}>{section.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default BriefingCard;
