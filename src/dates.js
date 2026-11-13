import { UsageError } from './errors.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses an ISO 8601 date. Values without an explicit time zone are taken as UTC,
 * never as the local time of the machine, so a
 * delta run selects the same files wherever it is started.
 */
export function parseLastCopyDate(input, now = new Date()) {
  const raw = String(input).trim();
  const iso = DATE_ONLY.test(raw) ? `${raw}T00:00:00Z` : HAS_ZONE.test(raw) ? raw : `${raw}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(`Invalid lastCopyDate "${raw}". Use ISO 8601, e.g. 2026-01-31 or 2026-01-31T14:30:00Z.`);
  }
  if (date > now) throw new UsageError(`lastCopyDate "${raw}" is in the future.`);
  return date;
}

/** ISO 8601, second precision, UTC: the form the dates are saved and shown in. */
export const toUtcSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
