/** Common primitives shared across every Stewra contract. */

export type UUID = string;
export type ISODateString = string;

/**
 * A value that survives a round trip through `jsonb` unchanged.
 *
 * Narrower than "some object" on purpose. The things this rules out are the ones that go wrong
 * quietly: a `Date` that comes back a string, a `Map` that comes back `{}`, an `undefined` property
 * that vanishes between what was enqueued and what a handler is later handed. If a value fits this
 * type, what is read back is what was written.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | JsonObject;

/** A JSON object — the shape of anything stored in a `jsonb` column. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Standard success envelope returned by the API. */
export interface ApiSuccess<T> {
  readonly success: true;
  readonly data: T;
}

/** Standard error envelope returned by the API. `details` is always present (empty when none). */
export interface ApiError {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: ReadonlyArray<{ readonly field: string; readonly message: string }>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** Cursor/limit pagination shared by list endpoints. */
export interface Paginated<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}
