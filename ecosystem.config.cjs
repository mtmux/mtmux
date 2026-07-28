const path = require("node:path");

const ENV_FILE = path.resolve(__dirname, ".env");
const LOGS = path.resolve(__dirname, "logs");

const commonEnv = {
  NODE_ENV: "production",
};

/**
 * The hosted deployment's public origins.
 *
 * `app` serves the web client, `api` the pairing broker. Both terminate TLS at
 * Cloudflare's edge, so the processes here are plain HTTP on loopback and nginx
 * proxies to them — see /etc/nginx/conf.d/cfx-managed.conf, which cfx owns.
 */
const APP_ORIGIN = process.env.APP_ORIGIN || "https://app.mtmux.com";
const API_ORIGIN = process.env.API_ORIGIN || "https://api.mtmux.com";

module.exports = {
  apps: [
    {
      name: "mtmux-api",
      script: "apps/api/dist/index.js",
      cwd: __dirname,
      instances: 1,
      // Fork, not cluster: the broker holds mailboxes, claims and live tunnel
      // sockets in memory. A second worker would route a browser to a process
      // that has never heard of its pairing.
      exec_mode: "fork",
      max_memory_restart: "512M",
      kill_timeout: 10000,
      out_file: `${LOGS}/mtmux-api-out.log`,
      error_file: `${LOGS}/mtmux-api-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        API_PORT: 24400,
        API_HOST: "127.0.0.1",
        // Set explicitly: the broker refuses to boot in production if its CORS
        // list still contains localhost.
        API_CORS_ORIGINS: APP_ORIGIN,
      },
    },
    {
      name: "mtmux-relay",
      script: "apps/relay/dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "512M",
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 10000,
      out_file: `${LOGS}/mtmux-relay-out.log`,
      error_file: `${LOGS}/mtmux-relay-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        RELAY_PORT: 24300,
      },
    },
    {
      name: "mtmux-app",
      // The standalone server, not `next start`: apps/web builds with
      // output: "standalone" (the CLI needs it), and Next refuses to serve
      // that tree via `next start`. Run `pnpm prepare:standalone` after a
      // build — it copies in the static assets the standalone tree omits.
      script: ".next/standalone/apps/web/server.js",
      cwd: path.resolve(__dirname, "apps/web"),
      // Two, not "max". This box has 32 cores but shares them with ~20 other
      // services, and Next's own workload here is light — the terminal traffic
      // rides the relay and the tunnel, not this process.
      instances: 2,
      exec_mode: "cluster",
      max_memory_restart: "1G",
      kill_timeout: 10000,
      out_file: `${LOGS}/mtmux-app-out.log`,
      error_file: `${LOGS}/mtmux-app-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        PORT: 24100,
        // Mirrors what `pnpm build:hosted` baked in. Next inlines NEXT_PUBLIC_*
        // at build time, so these do not change the client bundle — they are
        // here so a stray value in .env cannot make the running process
        // disagree with the bundle it is serving.
        NEXT_PUBLIC_RELAY_URL: "",
        NEXT_PUBLIC_API_URL: API_ORIGIN,
      },
    },
    {
      name: "mtmux-docs",
      script: "node_modules/next/dist/bin/next",
      args: "start --port 24102",
      cwd: path.resolve(__dirname, "apps/docs"),
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "512M",
      kill_timeout: 10000,
      out_file: `${LOGS}/mtmux-docs-out.log`,
      error_file: `${LOGS}/mtmux-docs-err.log`,
      merge_logs: true,
      env_file: ENV_FILE,
      env: {
        ...commonEnv,
        PORT: 24102,
      },
    },
    {
      /**
       * mtmux.com — the marketing site, docs and blog (apps/site).
       *
       * The name and the port are load-bearing: nginx's `server_name mtmux.com`
       * vhost proxies to http://localhost:41317, and that vhost lives in the
       * hand-maintained /etc/nginx/conf.d/http.conf. Renaming this app or moving
       * the port takes the public site down. Port 41317 is deliberately high and
       * unregistered, clear of the 3000/8000/8080 collisions on this box.
       *
       * Deliberately no `env_file`: unlike the hosted-app processes, the site
       * needs nothing from .env, and inheriting relay/API values here would only
       * create ways for it to disagree with the bundle it is serving.
       */
      name: "mtmux-web",
      script: "node_modules/next/dist/bin/next",
      args: "start --port 41317 --hostname 127.0.0.1",
      cwd: path.resolve(__dirname, "apps/site"),
      // Cluster mode is what makes `pm2 reload mtmux-web` zero-downtime: PM2
      // brings up a replacement worker, waits for it to listen, then retires
      // the old one. Two workers, not "max" — this box shares its cores with
      // ~20 other services and a prerendered site is not the bottleneck.
      exec_mode: "cluster",
      instances: 2,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      listen_timeout: 10000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "20s",
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,
      // Never watch in production — a stray file write should not bounce the
      // public site.
      watch: false,
      out_file: `${LOGS}/mtmux-web-out.log`,
      error_file: `${LOGS}/mtmux-web-err.log`,
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        ...commonEnv,
        PORT: 41317,
        HOSTNAME: "127.0.0.1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
};
