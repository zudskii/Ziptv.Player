/** Public URL layout of the API — the only place route prefixes are defined. */
export const API_PREFIX = '/api/v1';
export const MEDIA_PREFIX = `${API_PREFIX}/media`;

export const streamProxyPath = (token: string): string => `${MEDIA_PREFIX}/stream/${token}`;
