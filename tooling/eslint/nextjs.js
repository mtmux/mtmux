import reactConfig from "./react.js";

export default [
  ...reactConfig,
  {
    rules: {
      // Next.js specific rules
      "react/no-unescaped-entities": "off",
    },
  },
];
