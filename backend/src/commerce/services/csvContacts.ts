import {
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONSENT_STATES,
  type ConsentPurpose,
  type ConsentSource,
  type ConsentState,
  type ContactImportSkipReason,
} from '@stewra/shared-types';
import { ATTRIBUTE_VALUE_MAX, attributeKeySchema } from './segmentQuery.js';
import { MAX_ATTRIBUTES } from './audienceService.js';
import { normalizeE164 } from './callingCodes.js';

/**
 * How many data rows one upload may carry.
 *
 * A ceiling rather than none, because every row of an accepted file becomes a row in the import
 * ledger and a claim about a person's consent. The number is far above a real list and far below the
 * size at which one upload monopolizes a worker for an hour.
 */
export const MAX_IMPORT_ROWS = 50_000;

/** The columns this reader understands by name. Everything else in the header is an attribute. */
const RESERVED_COLUMNS = [
  'phone',
  'name',
  'tags',
  'consent_purpose',
  'consent_state',
  'consent_source',
  'consent_evidence',
] as const;

/**
 * The consent columns, all of which must be present. Listed separately from {@link RESERVED_COLUMNS}
 * because their absence is a refusal of the whole file rather than a column the reader does without.
 */
const REQUIRED_COLUMNS = [
  'phone',
  'consent_purpose',
  'consent_state',
  'consent_source',
  'consent_evidence',
] as const;

/** Tags share one cell, separated by semicolons — the comma is already spoken for by the format. */
const TAG_SEPARATOR = ';';

/** A row that can be attempted against the database. */
export interface ParsedContactRow {
  readonly ok: true;
  readonly rowNumber: number;
  readonly rawPhone: string;
  readonly phoneE164: string;
  readonly displayName: string | null;
  readonly tags: readonly string[];
  readonly attributes: Readonly<Record<string, string>>;
  readonly consent: {
    readonly purpose: ConsentPurpose;
    readonly state: ConsentState;
    readonly source: ConsentSource;
    readonly evidence: string;
  };
}

/** A row the reader will not attempt, and the sentence explaining why. */
export interface RejectedContactRow {
  readonly ok: false;
  readonly rowNumber: number;
  readonly rawPhone: string;
  readonly reason: ContactImportSkipReason;
  readonly detail: string;
}

export type ImportRow = ParsedContactRow | RejectedContactRow;

export type ParseResult =
  | { readonly ok: true; readonly rows: readonly ImportRow[] }
  /** The file itself is unusable. Nothing is imported and no ledger is written. */
  | { readonly ok: false; readonly reason: string };

/**
 * Split CSV text into cells.
 *
 * Written here rather than pulled in, because the format is small and the dependency is not: a quoted
 * field, a doubled quote inside one, and a newline inside a quoted field are the entire grammar, and
 * all three appear in real exports — an address with a comma, a company called O"Brien's, a notes
 * field someone pressed Enter in.
 *
 * A lone `\r` is treated as a line ending alongside `\r\n` and `\n`, because a spreadsheet saved on
 * an old Mac still opens in Excel and the person uploading it has no idea which one they have.
 */
function splitCsv(text: string): string[][] {
  // Strip a UTF-8 BOM. Excel writes one by default, and left in place it becomes part of the first
  // header cell — so `phone` silently is not `phone`, and the file is refused for missing the column
  // the operator is looking straight at.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  // The last line, when the file does not end in a newline. Skipped when it is a single empty cell,
  // which is what a file that DOES end in a newline leaves behind.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((cells) => !(cells.length === 1 && cells[0]?.trim() === ''));
}

/** Header cells are matched case- and separator-insensitively: `Consent Source` finds the column. */
function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isReserved(name: string): boolean {
  return RESERVED_COLUMNS.some((reserved) => reserved === name);
}

/**
 * Read an uploaded list into rows that can be attempted, and rows that already cannot.
 *
 * Everything decidable without the database is decided here — the number parses, the consent words
 * are words we know, the file does not name the same person twice — so the handler's loop is left
 * doing one thing per row and the rules are testable without a Postgres.
 *
 * The one thing this cannot judge is whether a contact already exists; that is the handler's.
 *
 * **A row is never repaired.** A missing country code is not guessed at, a consent source that is
 * nearly one of ours is not rounded to it, an empty evidence cell is not filled with the filename.
 * Every one of those would produce a contact the send gate is willing to message on the strength of
 * something nobody wrote down.
 */
export function parseContactCsv(text: string): ParseResult {
  const table = splitCsv(text);
  if (table.length === 0) return { ok: false, reason: 'That file is empty.' };

  const headerCells = table[0] ?? [];
  const header = headerCells.map(normalizeHeader);

  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `This file is missing the column(s): ${missing.join(', ')}. Every row has to say how that ` +
        'person agreed to be messaged — a list without that provenance is the one thing an import ' +
        'must not create.',
    };
  }

  const duplicateColumn = header.find((name, index) => name !== '' && header.indexOf(name) !== index);
  if (duplicateColumn !== undefined) {
    return {
      ok: false,
      reason: `The column "${duplicateColumn}" appears twice, so which one holds the value is a guess.`,
    };
  }

  // Attribute columns are validated ONCE, against the same key rules the segment compiler accepts —
  // a bad column name is a fact about the file, and reporting it nine hundred times as nine hundred
  // skipped rows would bury the single sentence that fixes it.
  const attributeColumns: Array<{ index: number; key: string }> = [];
  for (const [index, name] of header.entries()) {
    if (name === '' || isReserved(name)) continue;
    const original = headerCells[index]?.trim() ?? name;
    const parsedKey = attributeKeySchema.safeParse(original);
    if (!parsedKey.success) {
      return {
        ok: false,
        reason:
          `The column "${original}" cannot be stored as an attribute: ` +
          `${parsedKey.error.issues[0]?.message ?? 'invalid name'}. Rename it — a field segments ` +
          'cannot reference is one you could fill in and never target.',
      };
    }
    attributeColumns.push({ index, key: original });
  }
  if (attributeColumns.length > MAX_ATTRIBUTES) {
    return {
      ok: false,
      reason: `A contact may carry at most ${MAX_ATTRIBUTES} attributes; this file has ${attributeColumns.length} extra columns.`,
    };
  }

  const dataRows = table.slice(1);
  if (dataRows.length === 0) return { ok: false, reason: 'That file has a header and no rows.' };
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      reason: `That file has ${dataRows.length} rows; the limit for one import is ${MAX_IMPORT_ROWS}. Split it.`,
    };
  }

  const columnOf = (name: string): number => header.indexOf(name);
  const phoneAt = columnOf('phone');
  const nameAt = columnOf('name');
  const tagsAt = columnOf('tags');
  const purposeAt = columnOf('consent_purpose');
  const stateAt = columnOf('consent_state');
  const sourceAt = columnOf('consent_source');
  const evidenceAt = columnOf('consent_evidence');

  const seen = new Map<string, number>();
  const rows: ImportRow[] = [];

  for (const [offset, cells] of dataRows.entries()) {
    const rowNumber = offset + 1;
    const cell = (index: number): string => (index < 0 ? '' : (cells[index] ?? '').trim());
    const rawPhone = cell(phoneAt).slice(0, 64);

    const reject = (reason: ContactImportSkipReason, detail: string): void => {
      rows.push({ ok: false, rowNumber, rawPhone, reason, detail });
    };

    const normalized = normalizeE164(rawPhone);
    if (!normalized.ok) {
      reject('invalid_phone', normalized.reason);
      continue;
    }

    const firstSeenAt = seen.get(normalized.phoneE164);
    if (firstSeenAt !== undefined) {
      // Refused rather than merged. Two rows for one number disagree about something — a name, a
      // consent source, a state — and picking the later one silently would let the last line of a
      // file overwrite an opt-out on an earlier one.
      reject('duplicate_in_file', `${normalized.phoneE164} also appears on row ${firstSeenAt}.`);
      continue;
    }

    const purpose = cell(purposeAt).toLowerCase();
    const state = cell(stateAt).toLowerCase();
    const source = cell(sourceAt).toLowerCase();
    const evidence = cell(evidenceAt);

    if (purpose === '' && state === '' && source === '' && evidence === '') {
      reject('missing_consent', 'This row says nothing about how this person agreed to be messaged.');
      continue;
    }

    const consentPurpose = CONSENT_PURPOSES.find((value) => value === purpose);
    const consentState = CONSENT_STATES.find((value) => value === state);
    const consentSource = CONSENT_SOURCES.find((value) => value === source);

    if (consentPurpose === undefined) {
      reject(
        'invalid_consent',
        `consent_purpose "${purpose}" is not one of: ${CONSENT_PURPOSES.join(', ')}.`,
      );
      continue;
    }
    if (consentState === undefined) {
      reject(
        'invalid_consent',
        `consent_state "${state}" is not one of: ${CONSENT_STATES.join(', ')}.`,
      );
      continue;
    }
    if (consentSource === undefined) {
      reject(
        'invalid_consent',
        `consent_source "${source}" is not one of: ${CONSENT_SOURCES.join(', ')}.`,
      );
      continue;
    }
    if (evidence === '') {
      reject(
        'invalid_consent',
        'consent_evidence is empty. Say where this came from — a form URL, an ad id, a list name. ' +
          'A blank proof field is indistinguishable from an unchecked box.',
      );
      continue;
    }

    const attributes: Record<string, string> = {};
    let attributeProblem: string | null = null;
    for (const column of attributeColumns) {
      const value = cell(column.index);
      if (value === '') continue;
      if (value.length > ATTRIBUTE_VALUE_MAX) {
        attributeProblem = `"${column.key}" is longer than ${ATTRIBUTE_VALUE_MAX} characters.`;
        break;
      }
      attributes[column.key] = value;
    }
    if (attributeProblem !== null) {
      reject('invalid_attribute', attributeProblem);
      continue;
    }

    const displayName = cell(nameAt);
    const tags = cell(tagsAt)
      .split(TAG_SEPARATOR)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .slice(0, 20);

    seen.set(normalized.phoneE164, rowNumber);
    rows.push({
      ok: true,
      rowNumber,
      rawPhone,
      phoneE164: normalized.phoneE164,
      displayName: displayName === '' ? null : displayName.slice(0, 200),
      tags,
      attributes,
      consent: {
        purpose: consentPurpose,
        state: consentState,
        source: consentSource,
        evidence: evidence.slice(0, 500),
      },
    });
  }

  return { ok: true, rows };
}
