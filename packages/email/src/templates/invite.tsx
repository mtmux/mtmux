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

interface InviteEmailProps {
  inviterName: string;
  organizationName: string;
  inviteUrl: string;
}

export function InviteEmail({ inviterName, organizationName, inviteUrl }: InviteEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>You've been invited to {organizationName}</Preview>
      <Body style={{ backgroundColor: "#f6f9fc", fontFamily: "sans-serif" }}>
        <Container style={{ padding: "40px 0" }}>
          <Section style={{ backgroundColor: "#ffffff", padding: "40px", borderRadius: "8px" }}>
            <Heading style={{ fontSize: "24px", marginBottom: "16px" }}>
              You're Invited!
            </Heading>
            <Text style={{ fontSize: "16px", color: "#525f7f" }}>
              {inviterName} has invited you to join {organizationName}.
            </Text>
            <Link href={inviteUrl} style={{ color: "#5469d4", fontSize: "16px" }}>
              Accept Invitation
            </Link>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
