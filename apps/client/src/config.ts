/** Build-time configuration. Nothing else in the app reads `import.meta.env`. */
const rawApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim() ?? '';

export const config = {
  /** '' = same origin (nginx/docker-compose or the Vite dev proxy). */
  apiBaseUrl: rawApiUrl.replace(/\/+$/, ''),
  isSecurePage: typeof window !== 'undefined' && window.location.protocol === 'https:',
} as const;

/** Absolute URLs pass through; API paths are prefixed with the configured API origin. */
export function resolveApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${config.apiBaseUrl}${pathOrUrl}`;
}
