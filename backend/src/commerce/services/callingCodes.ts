/**
 * ITU E.164 country calling codes, for grouping a broadcast audience by country.
 *
 * Meta prices WhatsApp messages per recipient country, so a cost forecast has to say "1,200 to +91,
 * 300 to +44" rather than one flat count. The assignments are the ITU-T E.164 plan, which is
 * prefix-free — no assigned code is a prefix of another — so matching longest-first yields exactly
 * one answer for any well-formed number.
 *
 * This is reference data, not configuration: the plan changes on the order of years (the last new
 * assignment predates this codebase), and when it does, a number under a new code shows up under
 * {@link countryCallingCode}'s null return, counted but unattributed, rather than misfiled.
 */
const CALLING_CODES: ReadonlySet<string> = new Set([
  // Zone 1 (NANP) and zone 7 (Russia/Kazakhstan) are the only single-digit codes.
  '1',
  '7',
  // Two-digit codes.
  '20', '27', '30', '31', '32', '33', '34', '36', '39',
  '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86',
  '90', '91', '92', '93', '94', '95', '98',
  // Three-digit codes: Africa (2xx).
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227',
  '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240',
  '241', '242', '243', '244', '245', '246', '247', '248', '249', '250', '251', '252', '253',
  '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267',
  '268', '269', '290', '291', '297', '298', '299',
  // Europe (3xx).
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '370', '371', '372', '373', '374', '375', '376', '377', '378', '379',
  '380', '381', '382', '383', '385', '386', '387', '389',
  '420', '421', '423',
  // Americas (5xx).
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  // Oceania and south-east Asia (6xx).
  '670', '672', '673', '674', '675', '676', '677', '678', '679',
  '680', '681', '682', '683', '685', '686', '687', '688', '689',
  '690', '691', '692',
  // East Asia (8xx).
  '850', '852', '853', '855', '856', '880', '886',
  // Middle East and central Asia (9xx).
  '960', '961', '962', '963', '964', '965', '966', '967', '968',
  '970', '971', '972', '973', '974', '975', '976', '977',
  '992', '993', '994', '995', '996', '998',
]);

/**
 * The calling code of an E.164 number (`+14155550100` → `1`), or null when none matches.
 *
 * Null is an honest "this number's country is not identifiable" — a malformed number, or a code
 * assigned after this table was written. The caller counts it rather than dropping it: a message to
 * an unattributable number still gets billed.
 */
export function countryCallingCode(phoneE164: string): string | null {
  if (!phoneE164.startsWith('+')) return null;
  const digits = phoneE164.slice(1);
  // Longest first: the plan is prefix-free, but an unassigned three-digit string (e.g. '999') must
  // not shadow its valid one-digit parent, and checking short-first would return '9' for '998'
  // territory if '9' were ever assigned. Explicit order removes the question.
  for (const length of [3, 2, 1]) {
    const candidate = digits.slice(0, length);
    if (candidate.length === length && CALLING_CODES.has(candidate)) return candidate;
  }
  return null;
}
