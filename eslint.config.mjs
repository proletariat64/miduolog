import js from '@eslint/js';
import globals from 'globals';

export default [
  {ignores: ['data/**', 'samples/**', '.scratch/**', '.code-review-graph/**', 'node_modules/**', 'prototypes/**']},
  js.configs.recommended,
  {files: ['**/*.mjs', 'scripts/**/*.js', 'tests/**/*.js'], languageOptions: {globals: globals.node}},
  {files: ['app/*.js'], languageOptions: {globals: globals.browser}},
  {rules: {'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}]}},
];
