import type { StreamLocator } from '../../domain/catalog/model.js';
import type { SourceCredential } from '../../domain/sources/source.js';
import { AppError } from '../errors.js';
import type { SecretCipher } from '../ports/cipher.js';

/**
 * Sealing/unsealing of the secrets a source carries. Everything that may embed provider
 * credentials (the playlist URL, Xtream user/password, stream URLs, guide URLs) is encrypted
 * before it reaches the repository and decrypted only where it is used.
 */
export class SourceSecrets {
  constructor(private readonly cipher: SecretCipher) {}

  sealCredential(credential: SourceCredential): string {
    return this.cipher.encrypt('source-credential', JSON.stringify(credential));
  }

  openCredential(sealed: string | null): SourceCredential {
    if (!sealed) throw new AppError('SOURCE_NOT_SYNCABLE', 409, 'This source has no remote location to sync from.');
    const value = JSON.parse(this.cipher.decrypt('source-credential', sealed)) as SourceCredential;
    if (value.type !== 'm3u_url' && value.type !== 'xtream') throw new Error('Corrupt source credential');
    return value;
  }

  sealLocator(locator: StreamLocator | null): string | null {
    if (!locator) return null;
    // Compact form: most locators have no headers.
    const payload = Object.keys(locator.headers).length > 0 ? JSON.stringify([locator.url, locator.headers]) : JSON.stringify([locator.url]);
    return this.cipher.encrypt('stream-locator', payload);
  }

  openLocator(sealed: string | null): StreamLocator | null {
    if (!sealed) return null;
    const [url, headers] = JSON.parse(this.cipher.decrypt('stream-locator', sealed)) as [string, StreamLocator['headers']?];
    return { url, headers: headers ?? {} };
  }

  sealGuideUrl(url: string): string {
    return this.cipher.encrypt('guide-url', url);
  }

  openGuideUrl(sealed: string): string {
    return this.cipher.decrypt('guide-url', sealed);
  }
}
