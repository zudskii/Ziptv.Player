import type { SecretCipher } from '../../application/ports/cipher.js';
import type { SecretStore } from '../../application/ports/secret-store.js';

/** Only dedicated variables: a reference must never be able to read DATA_ENCRYPTION_KEY or DATABASE_URL. */
const ENV_NAME = /^ZIPTV_SECRET_[A-Z0-9_]{1,50}$/;

/** `env:` and `enc:` references (see the SecretStore port). */
export class LocalSecretStore implements SecretStore {
  constructor(
    private readonly cipher: SecretCipher,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async resolve(reference: string): Promise<string> {
    const colon = reference.indexOf(':');
    const scheme = colon > 0 ? reference.slice(0, colon) : '';
    const value = reference.slice(colon + 1);
    switch (scheme) {
      case 'env': {
        if (!ENV_NAME.test(value)) throw new Error('Invalid env secret reference');
        const secret = this.env[value];
        if (!secret) throw new Error(`Secret ${value} is not set in the environment`);
        return secret;
      }
      case 'enc':
        return this.cipher.decrypt('operator-secret', value);
      default:
        // Never echo the reference: a misconfigured value might be the secret itself.
        throw new Error('Unsupported secret reference scheme');
    }
  }

  seal(secret: string): string {
    return `enc:${this.cipher.encrypt('operator-secret', secret)}`;
  }
}
