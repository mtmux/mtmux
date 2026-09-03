export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Scopes mirror the monorepo's apps/packages (see CLAUDE.md "Commit Convention").
    "scope-enum": [
      2,
      "always",
      [
        "cli",
        "web",
        "site",
        "docs",
        "relay",
        "api",
        "protocol",
        "crypto",
        "db",
        "ui",
        "config",
        "logger",
        "infra",
        "ci",
        "deps",
      ],
    ],
  },
};
