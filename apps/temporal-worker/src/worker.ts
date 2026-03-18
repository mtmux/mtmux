import { NativeConnection, Worker } from "@temporalio/worker";
import { TASK_QUEUES } from "@repo/temporal";
import { emailActivities, dataActivities } from "@repo/temporal/activities";
import { createLogger } from "@repo/logger";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logger = createLogger("temporal-worker");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:17233",
  });

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUES.MAIN,
    workflowsPath: path.resolve(__dirname, "workflows.ts"),
    activities: {
      ...emailActivities,
      ...dataActivities,
    },
  });

  logger.info(`Worker started, listening on task queue: ${TASK_QUEUES.MAIN}`);
  await worker.run();
}

run().catch((err) => {
  logger.error(err, "Worker failed");
  process.exit(1);
});
