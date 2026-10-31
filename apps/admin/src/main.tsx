import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'sonner';

import { App } from './App';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2, refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster theme="dark" position="bottom-right" />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
