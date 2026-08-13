import { describe, expect, it } from 'vitest';
import { withMoneyFraming } from '../services/briefingService.js';
import type { BriefingSection } from '@stewra/shared-types';

/**
 * The "informational, not financial advice" framing is a product requirement, not a style choice —
 * so it is appended in code whenever money facts fed the briefing, never left to the model. These
 * tests pin that: present exactly when money facts were present, absent otherwise, and appended
 * even on the degraded (model-less) path where sections start empty.
 */

const SECTIONS: ReadonlyArray<BriefingSection> = [
  { heading: 'Inbox', body: 'Two threads are waiting on you.' },
];

describe('money advice framing', () => {
  it('appends the informational-only note when money facts fed the briefing', () => {
    const framed = withMoneyFraming(SECTIONS, true);
    expect(framed).toHaveLength(2);
    expect(framed[0]).toEqual(SECTIONS[0]);
    const note = framed[1];
    expect(note?.body).toContain('informational only');
    expect(note?.body).toContain('not financial advice');
  });

  it('adds nothing when no money facts were present', () => {
    expect(withMoneyFraming(SECTIONS, false)).toEqual(SECTIONS);
  });

  it('survives the degraded path, where the model produced no sections at all', () => {
    const framed = withMoneyFraming([], true);
    expect(framed).toHaveLength(1);
    expect(framed[0]?.body).toContain('not financial advice');
  });
});
