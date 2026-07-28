import Link from "next/link";
import { Button } from "@repo/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { ServerOff } from "lucide-react";

/**
 * What every account page renders when `NEXT_PUBLIC_API_URL` is unset.
 *
 * This is a supported configuration, not a misconfiguration: `mtmux start`
 * builds the client with no broker at all, and someone who lands on /dashboard
 * in that build should be told the feature does not exist here rather than see
 * a spinner that never resolves.
 */
export function HostedUnavailable() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ServerOff className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
          <CardTitle className="text-xl">
            <h1>Hosted accounts aren&apos;t configured</h1>
          </CardTitle>
          <CardDescription>
            This build of mtmux runs entirely on your own machine, so there is
            no account, dashboard or billing to show.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Everything still works — pair a device from the terminal and connect
            directly. Hosted accounts only add a shared list of your machines
            across networks.
          </p>
          <Button asChild variant="outline" className="h-11 w-full">
            <Link href="/">Back to the terminal</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
