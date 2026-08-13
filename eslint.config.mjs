import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      ".next/**",
      "coverage/**",
      "node_modules/**",
      "out/**",
      "playwright-report/**",
      "test-results/**",
      "tmp/**",
      "vendor/**",
      "next-env.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
      sonarjs,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@next/next/no-sync-scripts": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "no-control-regex": "warn",
      "no-empty": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "sonarjs/cognitive-complexity": ["warn", 15],
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs,ts,tsx}", "lib/legacy-import/**/*.{js,mjs,cjs,ts,tsx}"],
    rules: {
      "sonarjs/cognitive-complexity": "off",
    },
  },
  {
    files: ["app/(portal)/reports/**/page.tsx", "app/shop/page.tsx"],
    rules: {
      "sonarjs/cognitive-complexity": "off",
    },
  },
);
