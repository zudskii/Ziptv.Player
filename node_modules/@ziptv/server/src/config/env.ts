import { randomBytes } from 'node:crypto';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

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

    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    /** Apply pending data migrations at boot (one instance at a time, lock-protected). */
    RUN_MIGRATIONS: booleanString.default(true),

    /** Comma-separated list of allowed browser origins for the JSON API. Empty = same-origin only. */
    CORS_ORIGINS: csv,
    /** Express `trust proxy`: number of hops, `true`, or a comma-separated list of subnets. */
    TRUST_PROXY: z.string().default('0'),
    /** Optional: serve the built client (apps/client/dist) from this server — single-origin deploy. */
    CLIENT_DIST_DIR: z.string().optional(),

    STREAM_PROXY_ENABLED: booleanString.default(true),
    /** HMAC key for media proxy URLs and unlock tokens. Required in production (>= 32 chars). */
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
    if (env.NODE_ENV !== 'production') return;
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
  mongo: { uri: string; runMigrations: boolean };
  stream: {
    proxyEnabled: boolean;
    tokenSecret: Buffer;
    tokenTtlSeconds: number;
    /** True when the secret was generated at boot (dev only) — tokens die on restart. */
    ephemeralSecret: boolean;
  };
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
  };
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
    mongo: { uri: env.MONGO_URI, runMigrations: env.RUN_MIGRATIONS },
    stream: {
      proxyEnabled: env.STREAM_PROXY_ENABLED,
      tokenSecret: env.STREAM_TOKEN_SECRET ? Buffer.from(env.STREAM_TOKEN_SECRET, 'utf8') : randomBytes(32),
      tokenTtlSeconds: env.STREAM_TOKEN_TTL_SECONDS,
      ephemeralSecret: !env.STREAM_TOKEN_SECRET,
    },
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
    },
  });
}

function parseTrustProxy(value: string): boolean | number | string {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false' || trimmed === '') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
