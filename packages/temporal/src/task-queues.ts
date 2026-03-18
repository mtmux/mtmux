export const TASK_QUEUES = {
  MAIN: "main-queue",
  EMAIL: "email-queue",
  DATA_PROCESSING: "data-processing-queue",
} as const;

export type TaskQueue = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];
