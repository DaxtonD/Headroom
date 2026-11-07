import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/dev-dist/**",
      "**/generated/**",
      "design/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Money safety: no floating-point arithmetic on money, no Number() on cents.
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is integer cents (bigint). Never parse money as a float." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "round", message: "Money is integer cents. Use the rounding helpers in @headroom/core/money." },
        { object: "Number", property: "parseFloat", message: "Money is integer cents (bigint). Never parse money as a float." },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },

  // Node side
  {
    files: ["apps/api/**/*.ts", "packages/core/**/*.ts", "scripts/**/*.{js,mjs}", "*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },

  // Browser side
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Tests may use console and loose typing helpers
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
