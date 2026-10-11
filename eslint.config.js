import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'packages/contracts/**', 'apps/client/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  // --- Server layering (clean architecture): dependencies point inwards only. -----------------
  {
    files: ['apps/server/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/application/**', '**/infrastructure/**', '**/api/**', '**/container*', '**/config/**'], message: 'Domain is pure: no application/infrastructure/api imports.' },
            { group: ['mongoose', 'express', 'undici', 'pino', 'pino-http', 'multer', 'zod', 'htmlparser2', '@ziptv/contracts'], message: 'Domain must not depend on frameworks or API contracts.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/infrastructure/**', '**/api/**', '**/container*', '**/config/**'], message: 'Application depends on ports, never on adapters or HTTP.' },
            { group: ['mongoose', 'express', 'undici', 'pino', 'pino-http', 'multer', 'htmlparser2'], message: 'Application must not depend on frameworks; add a port instead.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/src/api/**/*.ts'],
    ignores: ['apps/server/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/infrastructure/**'], message: 'Routes orchestrate use cases only; wire adapters in container.ts.' },
            { group: ['mongoose', 'undici'], message: 'Routes must not talk to the database or upstreams directly.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/api/**'], message: 'Adapters must not depend on the HTTP layer.' }] }],
    },
  },
  {
    files: ['apps/server/src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/client/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['apps/client/src/**/*.tsx'],
    ...reactRefresh.configs.vite,
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
