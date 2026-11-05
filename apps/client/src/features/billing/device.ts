import type { DeviceDto } from '@ziptv/contracts';

import { ApiError } from '../../lib/api-client';
import { readRawStorage } from '../../lib/storage';
import { t } from '../../i18n';

const KEY_STORAGE = 'ziptv:device-key';
const ID_STORAGE = 'ziptv:device-id';

/**
 * This browser's device identity for playback: a random secret kept in localStorage (the server
 * stores only its hash), registered once per account. Re-registering the same key returns the
 * same device, so a reload never takes another of the plan's device slots.
 */
export function deviceKey(): string {
  const existing = readRawStorage(KEY_STORAGE);
  if (existing && existing.length >= 32) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    window.localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // No storage (private mode): a key per page load. Each reload registers again; the plan's device limit still applies.
  }
  return key;
}

/** The device id this browser last registered (to mark "this device" in the account page). */
export function currentDeviceId(): string | null {
  return readRawStorage(ID_STORAGE);
}

/** "Chrome on Windows" — what the account page shows for this browser. */
export function deviceName(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : t('access.browser');
  const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad|iPod/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

type Register = (body: { key: string; name: string; platform: 'web' }) => Promise<DeviceDto>;

/**
 * Registers this browser for the current identity, once (per identity token). A rejected
 * registration (device limit) is not cached, so the viewer can free a slot and try again.
 */
export class DeviceRegistry {
  private pending: { identity: string; promise: Promise<string> } | null = null;

  constructor(private readonly register: Register) {}

  ensure(identity: string): Promise<string> {
    if (this.pending?.identity === identity) return this.pending.promise;
    const promise = this.register({ key: deviceKey(), name: deviceName(), platform: 'web' }).then((device) => {
      try {
        window.localStorage.setItem(ID_STORAGE, device.id);
      } catch {
        /* ignore */
      }
      return device.id;
    });
    const entry = { identity, promise };
    this.pending = entry;
    promise.catch(() => {
      if (this.pending === entry) this.pending = null;
    });
    return promise;
  }

  /** The server no longer knows the device (removed from the account page): register anew. */
  forget(): void {
    this.pending = null;
  }
}

export const isDeviceRequired = (error: unknown) => error instanceof ApiError && error.code === 'DEVICE_REQUIRED';
