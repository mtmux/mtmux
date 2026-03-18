import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

interface WelcomeEmailProps {
  name: string;
}

export function WelcomeEmail({ name }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Monorepo Starter</Preview>
      <Body style={{ backgroundColor: "#f6f9fc", fontFamily: "sans-serif" }}>
        <Container style={{ padding: "40px 0" }}>
          <Section style={{ backgroundColor: "#ffffff", padding: "40px", borderRadius: "8px" }}>
            <Heading style={{ fontSize: "24px", marginBottom: "16px" }}>
              Welcome, {name}!
            </Heading>
            <Text style={{ fontSize: "16px", color: "#525f7f" }}>
              Thank you for signing up. We're excited to have you on board.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
