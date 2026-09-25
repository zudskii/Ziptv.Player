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

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

    /** Comma-separated list of allowed browser origins for the JSON API. Empty = same-origin only. */
    CORS_ORIGINS: csv,
    /** Express `trust proxy`: number of hops, `true`, or a comma-separated list of subnets. */
    TRUST_PROXY: z.string().default('0'),
    /** Optional: serve the built client (apps/client/dist) from this server — single-origin deploy. */
    CLIENT_DIST_DIR: z.string().optional(),

    STREAM_PROXY_ENABLED: booleanString.default(true),
    /** HMAC key for proxy URLs. Required in production (>= 32 chars). */
    STREAM_TOKEN_SECRET: z.string().min(32, 'STREAM_TOKEN_SECRET must be at least 32 characters').optional(),
    STREAM_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(7 * 24 * 3600).default(6 * 3600),

    /** Many IPTV panels only answer "player" user agents; channels can override it. */
    UPSTREAM_USER_AGENT: z.string().min(1).default('VLC/3.0.21 LibVLC/3.0.21'),
    UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
    UPSTREAM_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    UPSTREAM_BODY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    /** Allow playlists/streams on private networks (LAN TVHeadend, etc.). Keep false on public servers. */
    ALLOW_PRIVATE_UPSTREAMS: booleanString.default(false),

    MAX_PLAYLIST_BYTES: z.coerce.number().int().min(64 * 1024).default(30 * MB),
    MAX_CHANNELS_PER_PLAYLIST: z.coerce.number().int().min(1).default(100_000),
    MAX_PLAYLISTS_PER_USER: z.coerce.number().int().min(1).default(30),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.STREAM_TOKEN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STREAM_TOKEN_SECRET'],
        message: 'STREAM_TOKEN_SECRET is required in production',
      });
    }
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  http: {
    host: string;
    port: number;
    trustProxy: boolean | number | string;
    corsOrigins: string[];
    clientDistDir: string | null;
  };
  log: { level: string };
  mongo: { uri: string };
  stream: {
    proxyEnabled: boolean;
    tokenSecret: Buffer;
    tokenTtlSeconds: number;
    /** True when the secret was generated at boot (dev only) — tokens die on restart. */
    ephemeralSecret: boolean;
  };
  upstream: {
    userAgent: string;
    connectTimeoutMs: number;
    headersTimeoutMs: number;
    bodyTimeoutMs: number;
    allowPrivateNetworks: boolean;
  };
  limits: {
    maxPlaylistBytes: number;
    maxChannelsPerPlaylist: number;
    maxPlaylistsPerUser: number;
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
    http: {
      host: env.HOST,
      port: env.PORT,
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      corsOrigins: env.CORS_ORIGINS,
      clientDistDir: env.CLIENT_DIST_DIR?.trim() || null,
    },
    log: { level: env.LOG_LEVEL },
    mongo: { uri: env.MONGO_URI },
    stream: {
      proxyEnabled: env.STREAM_PROXY_ENABLED,
      tokenSecret: env.STREAM_TOKEN_SECRET ? Buffer.from(env.STREAM_TOKEN_SECRET, 'utf8') : randomBytes(32),
      tokenTtlSeconds: env.STREAM_TOKEN_TTL_SECONDS,
      ephemeralSecret: !env.STREAM_TOKEN_SECRET,
    },
    upstream: {
      userAgent: env.UPSTREAM_USER_AGENT,
      connectTimeoutMs: env.UPSTREAM_CONNECT_TIMEOUT_MS,
      headersTimeoutMs: env.UPSTREAM_HEADERS_TIMEOUT_MS,
      bodyTimeoutMs: env.UPSTREAM_BODY_TIMEOUT_MS,
      allowPrivateNetworks: env.ALLOW_PRIVATE_UPSTREAMS,
    },
    limits: {
      maxPlaylistBytes: env.MAX_PLAYLIST_BYTES,
      maxChannelsPerPlaylist: env.MAX_CHANNELS_PER_PLAYLIST,
      maxPlaylistsPerUser: env.MAX_PLAYLISTS_PER_USER,
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
