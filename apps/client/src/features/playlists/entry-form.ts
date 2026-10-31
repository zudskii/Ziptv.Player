import type { PlaylistEntryDto, UpdateEntryRequest } from '@ziptv/contracts';

import { MAX_CHANNEL_NUMBER } from './numbering';

/** The edit form as typed: everything is text until it is validated. */
export interface EntryFormValues {
  name: string;
  number: string;
  tvgId: string;
  logo: string;
}

export type EntryFormErrors = Partial<Record<keyof EntryFormValues, string>>;

export const formFromEntry = (entry: Pick<PlaylistEntryDto, 'name' | 'number' | 'tvgId' | 'logo'>): EntryFormValues => ({
  name: entry.name,
  number: entry.number === null ? '' : String(entry.number),
  tvgId: entry.tvgId ?? '',
  logo: entry.logo ?? '',
});

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Validates the form and returns only what changed (a PATCH must not touch what the person did
 * not edit), with blank optional fields meaning "clear it". `null` patch = nothing changed.
 */
export function buildEntryPatch(entry: Pick<PlaylistEntryDto, 'name' | 'number' | 'tvgId' | 'logo'>, form: EntryFormValues): { patch: UpdateEntryRequest | null; errors: EntryFormErrors } {
  const errors: EntryFormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'The name cannot be empty.';
  else if (name.length > 300) errors.name = 'The name can have at most 300 characters.';

  const numberText = form.number.trim();
  let number: number | null = null;
  if (numberText) {
    number = Number(numberText);
    if (!Number.isInteger(number) || number < 1 || number > MAX_CHANNEL_NUMBER) errors.number = `Use a whole number from 1 to ${MAX_CHANNEL_NUMBER.toLocaleString('en-US')}, or leave it empty.`;
  }

  const tvgId = form.tvgId.trim();
  if (tvgId.length > 200) errors.tvgId = 'The guide id can have at most 200 characters.';

  const logo = form.logo.trim();
  if (logo && (logo.length > 2000 || !isHttpUrl(logo))) errors.logo = 'Enter an http:// or https:// address, or leave it empty.';

  if (Object.keys(errors).length > 0) return { patch: null, errors };

  const patch: UpdateEntryRequest = {
    ...(name !== entry.name ? { name } : {}),
    ...(number !== entry.number ? { number } : {}),
    ...((tvgId || null) !== entry.tvgId ? { tvgId: tvgId || null } : {}),
    ...((logo || null) !== entry.logo ? { logo: logo || null } : {}),
  };
  return { patch: Object.keys(patch).length > 0 ? patch : null, errors };
}
