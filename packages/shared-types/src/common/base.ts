/** Common primitives shared across every Stewra contract. */

export type UUID = string;
export type ISODateString = string;

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
