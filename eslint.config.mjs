import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      // The onboarding engine's reference implementation, vendored verbatim as a test
      // oracle. Linting it would invite tidying it, and the moment it differs from what
      // the partners validated it stops being able to prove anything.
      "tests/onboarding/reference/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  prettier
);
