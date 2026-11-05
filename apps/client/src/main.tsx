import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { installGateRecovery } from './features/parental/gate-recovery';
import { installProfileHeaders } from './features/profiles/profile-store';
import { installSessionAuth } from './features/session/session';
import './styles/index.css';
import { installI18n } from './i18n';

installSessionAuth();
installProfileHeaders();
installGateRecovery();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// The device's language is loaded first, so a Georgian or Russian screen never flashes English.
void installI18n().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
