// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/coverage/**",
      "fixtures/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The project mandates strict typing; `any` requires explicit justification.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // CLI and scripts are allowed to write to stdout/stderr directly.
    files: ["apps/**/*.ts", "packages/benchmark/**/*.ts", "*.config.ts", "tests/**/*.ts", "scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
