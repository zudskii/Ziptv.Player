import { randomBytes } from 'node:crypto';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/** docker-compose passes unset optional variables as empty strings; an empty value means "not set". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const MB = 1024 * 1024;

/** Only for local development: lets data encrypted in dev survive restarts. Never use in production. */
const DEV_ENCRYPTION_KEY = 'ziptv-development-only-encryption-key-do-not-use-in-production';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** all = API + background workers (one process); api / worker to scale them separately. */
    ROLE: z.enum(['all', 'api', 'worker']).default('all'),

    /** PostgreSQL connection string, e.g. postgres://user:pass@host:5432/ziptv (add ?sslmode=require for managed DBs). */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').refine((value) => /^postgres(ql)?:\/\//.test(value), 'DATABASE_URL must start with postgres:// or postgresql://'),
    /** Max connections in this process's pool (API + workers share it). */
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
    /** Apply pending schema migrations at boot (one instance at a time, lock-protected). */
    RUN_MIGRATIONS: booleanString.default(true),

    /** Playlists a user may build (see /playlists). Not the same as sources: MAX_PLAYLISTS_PER_USER is the legacy name of MAX_SOURCES_PER_USER. */
    MAX_CUSTOM_PLAYLISTS_PER_USER: z.coerce.number().int().min(1).max(500).default(20),
    MAX_ENTRIES_PER_CUSTOM_PLAYLIST: z.coerce.number().int().min(100).max(1_000_000).default(50_000),
    /** Public origin used in export links, e.g. https://tv.example.com (default: the request's own origin). */
    PUBLIC_URL: optional(z.string().url()),

    /**
     * Outgoing mail (password reset, address confirmation). Any SMTP provider works, e.g.
     * smtps://user:password@smtp.example.com:465 or smtp://user:password@host:587.
     * Needs MAIL_FROM and PUBLIC_URL: links in emails are built from PUBLIC_URL, never from a request.
     */
    SMTP_URL: optional(z.string().url()),
    MAIL_FROM: optional(z.string().min(3)),
    /** Development only: print emails (with their links) to the log instead of sending them. */
    MAIL_LOG_ONLY: booleanString.default(false),

    /** Account sessions expire after this many days without use (guest sessions never do). */
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),

    /**
     * Operator console listener: its own port = its own origin, firewall it or keep it on a VPN.
     * 0 disables the console on this instance.
     */
    ADMIN_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
    /** Interface for the console listener (default: HOST). 127.0.0.1 = reachable only through a tunnel/reverse proxy. */
    ADMIN_HOST: optional(z.string().min(1)),
    /** Built operator console (apps/admin/dist) served by the console listener. */
    ADMIN_DIST_DIR: optional(z.string().min(1)),
    /**
     * Express `trust proxy` for the console listener only (default 0). The console is often reached
     * directly (SSH tunnel/VPN) even when the public app sits behind a proxy; trusting
     * X-Forwarded-For there would let anyone spoof the IP that rate limits and the audit log use.
     */
    ADMIN_TRUST_PROXY: z.string().default('0'),
    ADMIN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    ADMIN_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    /** Name shown in authenticator apps. */
    ADMIN_MFA_ISSUER: z.string().min(1).max(40).default('ZIPTV Console'),

    /** Comma-separated list of allowed browser origins for the JSON API. Empty = same-origin only. */
    CORS_ORIGINS: csv,
    /** Express `trust proxy`: number of hops, `true`, or a comma-separated list of subnets. */
    TRUST_PROXY: z.string().default('0'),
    /** Optional: serve the built client (apps/client/dist) from this server — single-origin deploy. */
    CLIENT_DIST_DIR: z.string().optional(),

    STREAM_PROXY_ENABLED: booleanString.default(true),
    /**
     * auto  = direct playback when the browser can, proxy as fallback (users' own sources);
     * proxy = upstream URLs never reach clients: no direct candidates, artwork proxied (operator / licensed content).
     */
    STREAM_DELIVERY: z.enum(['auto', 'proxy']).default('auto'),
    /** Playlist export links: direct = upstream URLs, proxied = ZIPTV proxy URLs bound to the link, off = disabled. Default: direct (proxied with STREAM_DELIVERY=proxy). */
    PLAYLIST_EXPORT_MODE: optional(z.enum(['direct', 'proxied', 'off'])),
    /** Lifetime of proxy URLs written into an exported playlist (players re-download the playlist). */
    PLAYLIST_EXPORT_LINK_TTL_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(7 * 24),
    /**
     * Shared state for more than one instance: rate limits, cache invalidation, leases.
     * e.g. redis://:password@redis:6379/0 (rediss:// for TLS). Unset = per-instance memory.
     */
    /** Namespace of every Redis key/channel (lets staging and production share one Redis). */
    REDIS_KEY_PREFIX: z.string().regex(/^[\w:.-]{1,40}$/, 'REDIS_KEY_PREFIX: letters, digits, _ : . - (max 40)').default('ziptv:'),
    REDIS_URL: optional(z.string().refine((value) => /^rediss?:\/\//.test(value), 'REDIS_URL must start with redis:// or rediss://')),
    /** Key for media proxy tokens (encrypted, AES-256-GCM via HKDF). Required in production (>= 32 chars). */
    STREAM_TOKEN_SECRET: z.string().min(32, 'STREAM_TOKEN_SECRET must be at least 32 characters').optional(),
    STREAM_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(7 * 24 * 3600).default(6 * 3600),

    /** AES-256-GCM key for secrets at rest (provider credentials, stream URLs). Required in production. */
    DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY must be at least 32 characters').optional(),
    /** Old keys still accepted for decryption after a rotation (comma-separated). */
    DATA_ENCRYPTION_PREVIOUS_KEYS: csv,

    /** Many IPTV panels only answer "player" user agents; channels can override it. */
    UPSTREAM_USER_AGENT: z.string().min(1).default('VLC/3.0.21 LibVLC/3.0.21'),
    UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
    UPSTREAM_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    UPSTREAM_BODY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    /** Allow sources/streams on private networks (LAN TVHeadend, etc.). Keep false on public servers. */
    ALLOW_PRIVATE_UPSTREAMS: booleanString.default(false),

    /** Background workers (source/EPG sync, cleanup). Disabled automatically in tests. */
    JOBS_ENABLED: booleanString.optional(),
    SOURCE_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    EPG_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    EPG_SYNC_INTERVAL_HOURS: z.coerce.number().int().min(1).max(48).default(3),
    /** Days of programmes kept ahead of now. */
    EPG_DAYS_AHEAD: z.coerce.number().int().min(1).max(14).default(7),
    /** Decompressed size cap of one XMLTV file. */
    EPG_MAX_BYTES: z.coerce.number().int().min(MB).default(512 * MB),

    // Limits (2.x names still accepted).
    MAX_SOURCE_BYTES: z.coerce.number().int().min(64 * 1024).optional(),
    MAX_PLAYLIST_BYTES: z.coerce.number().int().min(64 * 1024).optional(),
    MAX_ENTRIES_PER_SOURCE: z.coerce.number().int().min(1).optional(),
    MAX_CHANNELS_PER_PLAYLIST: z.coerce.number().int().min(1).optional(),
    MAX_SOURCES_PER_USER: z.coerce.number().int().min(1).optional(),
    MAX_PLAYLISTS_PER_USER: z.coerce.number().int().min(1).optional(),
    MAX_PROFILES_PER_USER: z.coerce.number().int().min(1).max(20).default(6),
  })
  .superRefine((env, ctx) => {
    if (env.SMTP_URL && !env.MAIL_FROM) ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'MAIL_FROM is required when SMTP_URL is set, e.g. "ZIPTV <no-reply@example.com>"' });
    if (env.SMTP_URL && !env.PUBLIC_URL) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'PUBLIC_URL is required when SMTP_URL is set (links in emails must not depend on the request)' });
    }
    if (env.MAIL_LOG_ONLY && env.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['MAIL_LOG_ONLY'], message: 'MAIL_LOG_ONLY would write password-reset links to the log; it is for development only' });
    }
    if (env.STREAM_DELIVERY === 'proxy' && !env.STREAM_PROXY_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['STREAM_DELIVERY'], message: 'STREAM_DELIVERY=proxy needs STREAM_PROXY_ENABLED=true' });
    }
    if ((env.PLAYLIST_EXPORT_MODE ?? (env.STREAM_DELIVERY === 'proxy' ? 'proxied' : 'direct')) === 'proxied' && !env.STREAM_PROXY_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['PLAYLIST_EXPORT_MODE'], message: 'PLAYLIST_EXPORT_MODE=proxied needs STREAM_PROXY_ENABLED=true' });
    }
    if (env.STREAM_DELIVERY === 'proxy' && env.PLAYLIST_EXPORT_MODE === 'direct') {
      ctx.addIssue({ code: 'custom', path: ['PLAYLIST_EXPORT_MODE'], message: 'PLAYLIST_EXPORT_MODE=direct would publish upstream URLs that STREAM_DELIVERY=proxy hides; use proxied or off' });
    }
    if (env.NODE_ENV !== 'production') return;
    if ((env.PLAYLIST_EXPORT_MODE ?? (env.STREAM_DELIVERY === 'proxy' ? 'proxied' : 'direct')) === 'proxied' && !env.PUBLIC_URL) {
      // Proxied exports write absolute stream URLs; without PUBLIC_URL they would come from the request (Host, X-Forwarded-Proto).
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'PUBLIC_URL (https://…) is required in production when playlist exports are proxied' });
    }
    if (!env.STREAM_TOKEN_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['STREAM_TOKEN_SECRET'], message: 'STREAM_TOKEN_SECRET is required in production' });
    }
    if (!env.DATA_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'DATA_ENCRYPTION_KEY is required in production (openssl rand -base64 32)' });
    }
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  role: 'all' | 'api' | 'worker';
  http: {
    host: string;
    port: number;
    trustProxy: boolean | number | string;
    corsOrigins: string[];
    clientDistDir: string | null;
  };
  log: { level: string };
  admin: { port: number; host: string; trustProxy: boolean | number | string; distDir: string | null; idleTimeoutMs: number; absoluteTimeoutMs: number; mfaIssuer: string };
  database: { url: string; poolMax: number; runMigrations: boolean };
  auth: { sessionTtlDays: number };
  mail: { smtpUrl: string | null; from: string | null; logOnly: boolean };
  stream: {
    proxyEnabled: boolean;
    delivery: 'auto' | 'proxy';
    tokenSecret: Buffer;
    tokenTtlSeconds: number;
    /** True when the secret was generated at boot (dev only) — tokens die on restart. */
    ephemeralSecret: boolean;
  };
  playlistExport: { mode: 'direct' | 'proxied' | 'off'; linkTtlSeconds: number };
  redis: { url: string | null; keyPrefix: string };
  encryption: {
    key: string;
    previousKeys: string[];
    /** True when the development fallback key is in use. */
    insecureDevKey: boolean;
  };
  upstream: {
    userAgent: string;
    connectTimeoutMs: number;
    headersTimeoutMs: number;
    bodyTimeoutMs: number;
    allowPrivateNetworks: boolean;
  };
  jobs: {
    enabled: boolean;
    sourceSyncConcurrency: number;
    epgSyncConcurrency: number;
    epgSyncIntervalHours: number;
  };
  epg: {
    daysAhead: number;
    maxBytes: number;
  };
  limits: {
    maxSourceBytes: number;
    maxEntriesPerSource: number;
    maxSourcesPerUser: number;
    maxProfilesPerUser: number;
    maxPlaylistsPerUser: number;
    maxEntriesPerPlaylist: number;
  };
  /** Origin for links handed to users (export URLs); null = derive from the request. */
  publicUrl: string | null;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Validates the environment once at boot; the app never reads `process.env` anywhere else. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`));
  }
  const env = parsed.data;

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    role: env.ROLE,
    http: {
      host: env.HOST,
      port: env.PORT,
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      corsOrigins: env.CORS_ORIGINS,
      clientDistDir: env.CLIENT_DIST_DIR?.trim() || null,
    },
    log: { level: env.LOG_LEVEL },
    admin: {
      port: env.ADMIN_PORT,
      host: env.ADMIN_HOST ?? env.HOST,
      trustProxy: parseTrustProxy(env.ADMIN_TRUST_PROXY),
      distDir: env.ADMIN_DIST_DIR?.trim() || null,
      idleTimeoutMs: env.ADMIN_SESSION_IDLE_MINUTES * 60_000,
      absoluteTimeoutMs: env.ADMIN_SESSION_MAX_HOURS * 3600_000,
      mfaIssuer: env.ADMIN_MFA_ISSUER,
    },
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX, runMigrations: env.RUN_MIGRATIONS },
    auth: { sessionTtlDays: env.SESSION_TTL_DAYS },
    mail: { smtpUrl: env.SMTP_URL ?? null, from: env.MAIL_FROM ?? null, logOnly: env.MAIL_LOG_ONLY },
    stream: {
      proxyEnabled: env.STREAM_PROXY_ENABLED,
      delivery: env.STREAM_DELIVERY,
      tokenSecret: env.STREAM_TOKEN_SECRET ? Buffer.from(env.STREAM_TOKEN_SECRET, 'utf8') : randomBytes(32),
      tokenTtlSeconds: env.STREAM_TOKEN_TTL_SECONDS,
      ephemeralSecret: !env.STREAM_TOKEN_SECRET,
    },
    playlistExport: { mode: env.PLAYLIST_EXPORT_MODE ?? (env.STREAM_DELIVERY === 'proxy' ? 'proxied' : 'direct'), linkTtlSeconds: env.PLAYLIST_EXPORT_LINK_TTL_HOURS * 3600 },
    redis: { url: env.REDIS_URL ?? null, keyPrefix: env.REDIS_KEY_PREFIX },
    encryption: {
      key: env.DATA_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY,
      previousKeys: env.DATA_ENCRYPTION_PREVIOUS_KEYS,
      insecureDevKey: !env.DATA_ENCRYPTION_KEY,
    },
    upstream: {
      userAgent: env.UPSTREAM_USER_AGENT,
      connectTimeoutMs: env.UPSTREAM_CONNECT_TIMEOUT_MS,
      headersTimeoutMs: env.UPSTREAM_HEADERS_TIMEOUT_MS,
      bodyTimeoutMs: env.UPSTREAM_BODY_TIMEOUT_MS,
      allowPrivateNetworks: env.ALLOW_PRIVATE_UPSTREAMS,
    },
    jobs: {
      enabled: env.JOBS_ENABLED ?? env.NODE_ENV !== 'test',
      sourceSyncConcurrency: env.SOURCE_SYNC_CONCURRENCY,
      epgSyncConcurrency: env.EPG_SYNC_CONCURRENCY,
      epgSyncIntervalHours: env.EPG_SYNC_INTERVAL_HOURS,
    },
    epg: {
      daysAhead: env.EPG_DAYS_AHEAD,
      maxBytes: env.EPG_MAX_BYTES,
    },
    limits: {
      maxSourceBytes: env.MAX_SOURCE_BYTES ?? env.MAX_PLAYLIST_BYTES ?? 30 * MB,
      maxEntriesPerSource: env.MAX_ENTRIES_PER_SOURCE ?? env.MAX_CHANNELS_PER_PLAYLIST ?? 150_000,
      maxSourcesPerUser: env.MAX_SOURCES_PER_USER ?? env.MAX_PLAYLISTS_PER_USER ?? 30,
      maxProfilesPerUser: env.MAX_PROFILES_PER_USER,
      maxPlaylistsPerUser: env.MAX_CUSTOM_PLAYLISTS_PER_USER,
      maxEntriesPerPlaylist: env.MAX_ENTRIES_PER_CUSTOM_PLAYLIST,
    },
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, '') : null,
  });
}

function parseTrustProxy(value: string): boolean | number | string {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false' || trimmed === '') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
