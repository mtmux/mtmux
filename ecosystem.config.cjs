module.exports = {
  apps: [
    {
      name: "web",
      script: "node_modules/.bin/next",
      args: "start --port 14100",
      cwd: "./apps/web",
      instances: "max",
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 14100,
      },
    },
    {
      name: "admin",
      script: "node_modules/.bin/next",
      args: "start --port 14101",
      cwd: "./apps/admin",
      instances: 2,
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 14101,
      },
    },
    {
      name: "api",
      script: "apps/api/dist/index.js",
      instances: "max",
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 14200,
      },
    },
    {
      name: "temporal-worker",
      script: "apps/temporal-worker/dist/worker.js",
      instances: 2,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "relay",
      script: "apps/relay/dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        RELAY_PORT: 14300,
      },
    },
  ],
};
