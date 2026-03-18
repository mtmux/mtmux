import { proxyActivities } from "@temporalio/workflow";
import type { DataActivities } from "../activities/data-activities";

const { processData, notifyCompletion } = proxyActivities<DataActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

export async function dataProcessingWorkflow(params: { jobId: string; data: unknown }): Promise<void> {
  await processData(params);
  await notifyCompletion({ jobId: params.jobId });
}
