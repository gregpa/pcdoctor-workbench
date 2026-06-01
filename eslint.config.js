// ESLint v9 flat config.
//
// Deliberately lean: this codebase had no working lint for a long time, so the
// goal here is a GREEN baseline that catches real correctness bugs without
// drowning you in stylistic noise on 42k existing lines. Ratchet rules up over
// time (flip `warn` -> `error`, add `@typescript-eslint/no-explicit-any`, etc.)
// once the existing code is cleaned incrementally.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Build output, deps, generated assets — never lint these.
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'node_modules/**',
      'resources/**',
      '*.config.{js,cjs,mjs,ts}',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      // Non-type-checked lint: fast, no tsconfig project graph required. Keeps
      // `npm run lint` runnable anywhere (incl. CI without a native build).
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // High-value correctness signals kept as errors.
      'no-debugger': 'error',
      'no-unsafe-finally': 'error',
      // Calling a hook conditionally is always a real bug — keep it blocking.
      'react-hooks/rules-of-hooks': 'error',

      // Noisy-on-legacy-code rules: visible but non-blocking for now.
      // exhaustive-deps fires a lot on existing effects; surface, don't block.
      'react-hooks/exhaustive-deps': 'warn',
      'no-empty': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
