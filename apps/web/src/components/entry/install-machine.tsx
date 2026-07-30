import { CopyCommand } from "@/components/account/copy-command";

/**
 * How to get a machine to show up — the commands, in one place.
 *
 * These three lines were inlined in the dashboard's empty state, which meant
 * `/start` had no answer at all for "nothing running yet?" and the two places
 * that did answer it could drift apart. They are the first thing a new user
 * needs and the last thing anyone should have to keep in sync by hand.
 *
 * `mtmux login` is conditional because it is only true when there is an account
 * to attach the machine to. Anonymous pairing is invariant #5 — someone who has
 * never signed in and never will still gets a working terminal from `npm
 * install -g mtmux` and `mtmux`, and showing them a login step would imply
 * otherwise.
 */
export function InstallMachine({
  /** Include `mtmux login` — true on the dashboard, false on the entry pages. */
  withLogin = false,
  className,
}: {
  withLogin?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="space-y-3 text-left">
        <CopyCommand command="npm install -g mtmux" />
        {withLogin && <CopyCommand command="mtmux login" />}
        <CopyCommand command="mtmux" />
      </div>
    </div>
  );
}
