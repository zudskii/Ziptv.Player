import { z } from 'zod';

import { isEntityId } from '../../domain/shared/ids.js';

/** Shared request-validation building blocks. */
export const EntityId = z.string().refine(isEntityId, 'must be an id');
export const ContentKey = z.string().regex(/^[a-f0-9]{12}(-\d{1,6})?$/, 'must be a content key');
export const IsoInstant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date');
