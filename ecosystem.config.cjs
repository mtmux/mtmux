const path = require("node:path");

const ENV_FILE = path.resolve(__dirname, ".env");
const LOGS = path.resolve(__dirname, "logs");

const commonEnv = {
  NODE_ENV: "production",
};

module.exports = {
  apps: [
    {
      name: "relay",
      script: "apps/relay/dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "512M",
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 10000,
      out_file: `${LOGS}/relay-out.log`,
      error_file: `${LOGS}/relay-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        RELAY_PORT: 24300,
      },
    },
    {
      name: "web",
      script: "node_modules/.bin/next",
      args: "start --port 24100",
      cwd: path.resolve(__dirname, "apps/web"),
      instances: "max",
      exec_mode: "cluster",
      max_memory_restart: "1G",
      kill_timeout: 10000,
      out_file: `${LOGS}/web-out.log`,
      error_file: `${LOGS}/web-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        PORT: 24100,
      },
    },
    {
      name: "docs",
      script: "node_modules/.bin/next",
      args: "start --port 24102",
      cwd: path.resolve(__dirname, "apps/docs"),
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "512M",
      kill_timeout: 10000,
      out_file: `${LOGS}/docs-out.log`,
      error_file: `${LOGS}/docs-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        PORT: 24102,
      },
    },
  ],
};
