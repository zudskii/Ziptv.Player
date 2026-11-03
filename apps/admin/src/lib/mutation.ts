import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * A console action: runs `fn`, toasts the outcome, refreshes `invalidate` queries. Errors are
 * toasted unless the caller shows them inline (`inlineErrors`).
 */
export function useAction<TInput, TResult>(fn: (input: TInput) => Promise<TResult>, options: { success?: string | ((result: TResult) => string); invalidate?: QueryKey[]; inlineErrors?: boolean; onSuccess?: (result: TResult) => void } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      if (options.success) toast.success(typeof options.success === 'function' ? options.success(result) : options.success);
      options.onSuccess?.(result);
      await Promise.all((options.invalidate ?? []).map((queryKey) => client.invalidateQueries({ queryKey })));
    },
    onError: (error) => {
      if (!options.inlineErrors) toast.error(error.message);
    },
  });
}
