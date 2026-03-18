import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

interface ResetPasswordEmailProps {
  name: string;
  resetUrl: string;
}

export function ResetPasswordEmail({ name, resetUrl }: ResetPasswordEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your password</Preview>
      <Body style={{ backgroundColor: "#f6f9fc", fontFamily: "sans-serif" }}>
        <Container style={{ padding: "40px 0" }}>
          <Section style={{ backgroundColor: "#ffffff", padding: "40px", borderRadius: "8px" }}>
            <Heading style={{ fontSize: "24px", marginBottom: "16px" }}>
              Password Reset
            </Heading>
            <Text style={{ fontSize: "16px", color: "#525f7f" }}>
              Hi {name}, click the link below to reset your password:
            </Text>
            <Link href={resetUrl} style={{ color: "#5469d4", fontSize: "16px" }}>
              Reset Password
            </Link>
            <Text style={{ fontSize: "14px", color: "#8898aa", marginTop: "16px" }}>
              If you didn't request this, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
