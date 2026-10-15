/** One-way password hashing. The stored string carries its own parameters so they can be raised later. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /**
   * `stored === null` (unknown account) still does the full amount of work and returns false,
   * so response time does not reveal whether an email is registered.
   */
  verify(password: string, stored: string | null): Promise<boolean>;
  /** The hash was made with weaker parameters than the current ones: re-hash after a successful login. */
  needsRehash(stored: string): boolean;
}
