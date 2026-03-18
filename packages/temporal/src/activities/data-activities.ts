export interface DataActivities {
  processData(params: { jobId: string; data: unknown }): Promise<void>;
  notifyCompletion(params: { jobId: string }): Promise<void>;
}

export const dataActivities: DataActivities = {
  async processData({ jobId }) {
    console.log(`Processing data for job ${jobId}`);
    // Placeholder for actual data processing
  },

  async notifyCompletion({ jobId }) {
    console.log(`Job ${jobId} completed`);
    // Placeholder for notification logic
  },
};
