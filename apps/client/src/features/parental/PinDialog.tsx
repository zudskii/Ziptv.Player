import { Lock } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { pinErrorMessage, usePinPrompt, type PinRequest } from './pin-prompt';

/** The parental PIN dialog (mounted once, opened through `askPin`). */
export function PinDialog() {
  const request = usePinPrompt((state) => state.request);
  const close = usePinPrompt((state) => state.close);
  const cancel = () => {
    request?.resolve(false);
    close();
  };
  return (
    <Dialog open={Boolean(request)} onClose={cancel} title={request?.title ?? 'Parental PIN'} description={request?.description} className="w-[min(94vw,22rem)]">
      {request && <PinForm key={request.title} request={request} onDone={close} onCancel={cancel} />}
    </Dialog>
  );
}

function PinForm({ request, onDone, onCancel }: { request: PinRequest; onDone: () => void; onCancel: () => void }) {
  const id = useId();
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pin.length < 4) return;
    setPending(true);
    setError(null);
    try {
      await request.verify(pin);
      request.resolve(true);
      onDone();
    } catch (reason) {
      setPending(false);
      setPin('');
      setError(pinErrorMessage(reason));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-fg-muted">
        <Lock className="h-4 w-4 text-brand-soft" aria-hidden /> PIN
      </label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        pattern="\d*"
        maxLength={8}
        autoFocus
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        className="field text-center text-2xl tracking-[0.5em]"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={pending} disabled={pin.length < 4}>
          Continue
        </Button>
      </div>
    </form>
  );
}
