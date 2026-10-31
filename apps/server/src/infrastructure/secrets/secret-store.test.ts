import { describe, expect, it } from 'vitest';

import { AesSecretCipher, parseEncryptionKey } from '../crypto/secret-cipher.js';
import { LocalSecretStore } from './secret-store.js';

describe('LocalSecretStore', () => {
  const store = new LocalSecretStore(new AesSecretCipher(parseEncryptionKey('k'.repeat(40))), { ZIPTV_SECRET_PROVIDER_API_KEY: 'from-env', DATA_ENCRYPTION_KEY: 'master' });

  it('resolves env and encrypted references', async () => {
    expect(await store.resolve('env:ZIPTV_SECRET_PROVIDER_API_KEY')).toBe('from-env');
    const sealed = store.seal('typed-in-console');
    expect(sealed).toMatch(/^enc:v1\./);
    expect(sealed).not.toContain('typed-in-console');
    expect(await store.resolve(sealed)).toBe('typed-in-console');
  });

  it('refuses unknown schemes, missing variables and bad names without echoing them', async () => {
    await expect(store.resolve('plain-secret-value')).rejects.toThrow('Unsupported secret reference scheme');
    await expect(store.resolve('env:ZIPTV_SECRET_MISSING')).rejects.toThrow(/not set/);
    await expect(store.resolve('env:DATA_ENCRYPTION_KEY')).rejects.toThrow(/Invalid/);
    await expect(store.resolve('env:lower')).rejects.toThrow(/Invalid/);
  });
});
