import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";

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
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      /*
       * Accessibility, as far as a static check can see it (HANDOFF section 15
       * and the M5 criteria). These catch the things that are invisible to the
       * person writing them and obvious to somebody using a screen reader or a
       * keyboard: a div with an onClick that Tab skips over, an icon-only
       * button with no name to read out, an input whose label is not attached
       * to it. Contrast and touch targets are arithmetic and are checked by
       * `theme-contrast.test.ts` and `touch-targets.test.ts` instead.
       */
      ...jsxA11y.flatConfigs.recommended.rules,
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
