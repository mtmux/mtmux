export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "web",
        "admin",
        "docs",
        "api",
        "db",
        "auth",
        "ui",
        "email",
        "storage",
        "ai",
        "websockets",
        "temporal",
        "config",
        "logger",
        "infra",
        "ci",
        "deps",
      ],
    ],
  },
};
