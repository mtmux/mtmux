import { redirect } from "next/navigation";

/**
 * This site is documentation only.
 *
 * The marketing landing page lives at mtmux.com (`apps/site`). A second one
 * here would compete with it for the same search terms and drift out of sync,
 * so `/` sends people straight into the docs tree.
 */
export default function RootPage() {
  redirect("/docs");
}
