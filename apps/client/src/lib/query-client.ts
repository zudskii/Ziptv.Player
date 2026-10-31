import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api-client';

/**
 * One client for the app. Lives in its own module because the session code must be able to
 * clear it: when the person signs in or out, nothing cached for the previous identity may remain.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Retrying 4xx never helps (not found, validation...); network/5xx may.
      retry: (failureCount, error) => failureCount < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});
