import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: "mtmux docs" }}
      links={[
        { text: "mtmux.com", url: "https://mtmux.com" },
        { text: "GitHub", url: "https://github.com/GagnDeep/tmuxremote" },
        { text: "npm", url: "https://www.npmjs.com/package/mtmux" },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
