// Google TypeScript Style via gts. (Imported from the package root: the
// eslint.config.js gts ships has a broken relative path in v7.0.0.)
import gts from 'gts';

export default [
  {ignores: ['dist/', 'node_modules/', 'eslint.config.js']},
  ...gts,
  {
    // gts pins parserOptions.project to ./tsconfig.json, which only covers
    // src/; the acceptance scripts have their own project file.
    files: ['scripts/**/*.ts'],
    languageOptions: {parserOptions: {project: './scripts/tsconfig.json'}},
  },
];
