/**
 * Moves what a guest identity owns into an account. Everything a user owns has to be listed in
 * the adapter (sources today, playlists later), which is why this is one port and not logic
 * spread across services.
 */
export interface AccountDataTransfer {
  /**
   * Re-owns the guest's data for `accountId`, then deletes the guest. Atomic. Does nothing
   * (false) when `guestId` is not a guest.
   */
  mergeGuestInto(guestId: string, accountId: string): Promise<boolean>;
}
