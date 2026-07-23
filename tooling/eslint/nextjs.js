import reactConfig from "./react.js";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  ...reactConfig,
  {
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // Next.js specific rules
      "react/no-unescaped-entities": "off",
    },
  },
  {
    // Framework-generated files — not authored, so don't lint them.
    ignores: ["next-env.d.ts", ".next/**", ".source/**", "out/**"],
  },
];
