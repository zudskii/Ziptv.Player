import { z } from 'zod';

/** Shared request-validation building blocks. */
export const ObjectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'must be an id');
export const ContentKey = z.string().regex(/^[a-f0-9]{12}(-\d{1,6})?$/, 'must be a content key');
export const IsoInstant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date');
