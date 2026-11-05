import { ApiError, errorMessage } from '../../lib/api-client';
import { create } from 'zustand';
import { i18n, t } from '../../i18n';

export interface PinRequest {
  title: string;
  description?: string;
  /** Called with the PIN; throw (e.g. the server's "Wrong PIN") to keep the dialog open with the message. */
  verify: (pin: string) => Promise<void>;
  resolve: (done: boolean) => void;
}

interface PinPromptState {
  request: PinRequest | null;
  open: (request: PinRequest) => void;
  close: () => void;
}

export const usePinPrompt = create<PinPromptState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/**
 * Asks for the parental PIN (one dialog for the whole app) and runs `verify` with it.
 * Resolves true once `verify` succeeded, false when the person cancels.
 */
export function askPin(options: Omit<PinRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = usePinPrompt.getState().request;
    previous?.resolve(false);
    usePinPrompt.getState().open({ ...options, resolve });
  });
}

/** Human message for a failed PIN check (wrong, locked for a while, …). */
export function pinErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PIN_INVALID') return t('parental.wrongPin');
    if (error.code === 'RATE_LIMITED') {
      const until = (error.details as { lockedUntil?: string } | undefined)?.lockedUntil;
      return until ? t('parental.tooManyUntil', { time: new Date(until).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' }) }) : t('parental.tooMany');
    }
  }
  return errorMessage(error);
}
