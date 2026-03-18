import { proxyActivities } from "@temporalio/workflow";
import type { EmailActivities } from "../activities/email-activities";

const { sendWelcomeEmail, sendPasswordResetEmail } = proxyActivities<EmailActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export async function welcomeEmailWorkflow(params: { userId: string; email: string; name: string }): Promise<void> {
  await sendWelcomeEmail(params);
}

export async function passwordResetWorkflow(params: { email: string; name: string; resetUrl: string }): Promise<void> {
  await sendPasswordResetEmail(params);
}
