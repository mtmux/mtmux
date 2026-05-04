import kleur from "kleur";

export function banner(opts: { url: string; token: string; host: string; port: number }) {
  const coral = kleur.red; // closest stock color; full RGB requires kleur/colors
  console.log();
  console.log(
    coral().bold("  ›  tmuxremote") +
      kleur.dim("  Your tmux, in any browser."),
  );
  console.log();
  console.log(`  ${kleur.bold("URL")}      ${coral(opts.url)}`);
  console.log(`  ${kleur.bold("Host")}     ${opts.host}`);
  console.log(`  ${kleur.bold("Port")}     ${opts.port}`);
  console.log(`  ${kleur.bold("Token")}    ${kleur.dim(opts.token)}`);
  console.log();
  console.log(kleur.dim(`  Press ${kleur.bold("Ctrl+C")} to stop.`));
  console.log();
}
