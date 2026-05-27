/**
 * Shared ESLint flat config for ai-ops TypeScript agents.
 *
 * Agents copy this file to `<agent-repo>/eslint.config.cjs` (or symlink it via a
 * vendored-tarball pin once P7 lands). The intent is one config, many repos —
 * any rule change here ships to every agent that consumes this template.
 *
 * To consume:
 *   1) Copy lint-config/eslint.shared.cjs from ai-ops-meta into your repo as
 *      `eslint.config.cjs` (flat-config filename).
 *   2) Copy lint-config/.prettierrc.shared.json from ai-ops-meta into your repo
 *      as `.prettierrc.json`.
 *   3) Install peer deps:
 *        npm i -D eslint typescript-eslint eslint-plugin-import \
 *                eslint-plugin-simple-import-sort prettier eslint-config-prettier
 *   4) Add to `package.json` scripts:
 *        "lint": "eslint . --max-warnings=0 && prettier --check .",
 *        "lint:fix": "eslint . --fix && prettier --write ."
 *   5) Add a `lint` job to `.github/workflows/ci.yml` so PRs block on warnings.
 *
 * See lint-config/README.md for the consumer checklist + the rationale behind
 * each rule cluster.
 */

const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');
const simpleImportSort = require('eslint-plugin-simple-import-sort');
const prettierConfig = require('eslint-config-prettier');

module.exports = tseslint.config(
  // Ignore generated artefacts, vendor directories, and self-config.
  //
  // eslint.config.cjs is intentionally excluded: it's CommonJS and only loaded
  // once at lint-time, never deployed; linting it recursively buys nothing and
  // tripped P5.5 on `projectService` parsing errors before it was ignored.
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      'eslint.config.cjs',
    ],
  },

  // Core TS rules — recommended-type-checked is the default per P5.
  ...tseslint.configs.recommendedTypeChecked,

  // Import hygiene.
  {
    plugins: {
      import: importPlugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'import/no-duplicates': 'error',
      'import/no-cycle': ['error', { maxDepth: 5 }],
    },
  },

  // Project-wide TS rule tweaks.
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      // `any` is banned at the type level; the strictness pass (P6) tightens
      // this further with `noImplicitAny` in tsconfig.
      '@typescript-eslint/no-explicit-any': 'error',
      // `unknown` over `any` for catch clauses.
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      // Promise hygiene — surface unhandled-promise patterns at lint time.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Empty fixtures (e.g. mock callbacks) need to be explicit.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      // Unused vars must be prefixed `_` to opt out — matches the pattern used
      // across the fleet today (no silent dead vars).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test files: relax type-checked rules that punish ergonomic fixtures.
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Prettier must come last — disables stylistic rules that fight the formatter.
  prettierConfig,
);
