import { Hero } from "@/components/landing/hero";
import { FeatureGrid } from "@/components/landing/feature-grid";
import { Install } from "@/components/landing/install";
import { Quickstart } from "@/components/landing/quickstart";
import { Architecture } from "@/components/landing/architecture";
import { CTA } from "@/components/landing/cta";

export default function HomePage() {
  return (
    <main>
      <Hero />
      <FeatureGrid />
      <Install />
      <Quickstart />
      <Architecture />
      <CTA />
    </main>
  );
}
