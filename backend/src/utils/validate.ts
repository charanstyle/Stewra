import type { z } from 'zod';
import { ValidationError } from './errors';

/** Parse untrusted input against a schema; throw a ValidationError (400) on failure. Fail-fast. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    throw new ValidationError('Validation failed', details);
  }
  return result.data;
}
