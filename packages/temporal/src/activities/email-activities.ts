export interface EmailActivities {
  sendWelcomeEmail(params: { userId: string; email: string; name: string }): Promise<void>;
  sendPasswordResetEmail(params: { email: string; name: string; resetUrl: string }): Promise<void>;
}

export const emailActivities: EmailActivities = {
  async sendWelcomeEmail({ email, name }) {
    const { sendEmail } = await import("@repo/email");
    const { WelcomeEmail } = await import("@repo/email/templates/welcome");
    await sendEmail({
      to: email,
      subject: "Welcome!",
      react: WelcomeEmail({ name }),
    });
  },

  async sendPasswordResetEmail({ email, name, resetUrl }) {
    const { sendEmail } = await import("@repo/email");
    const { ResetPasswordEmail } = await import("@repo/email/templates/reset-password");
    await sendEmail({
      to: email,
      subject: "Reset your password",
      react: ResetPasswordEmail({ name, resetUrl }),
    });
  },
};
