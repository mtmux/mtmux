import { execFile } from "node:child_process";
import { promisify } from "node:util";
import kleur from "kleur";

const exec = promisify(execFile);

export async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    const platform = process.platform;
    const hint =
      platform === "darwin"
        ? "brew install tmux"
        : platform === "linux"
          ? "sudo apt install tmux  # or your distro equivalent"
          : "Install tmux from https://github.com/tmux/tmux";
    console.error(kleur.red("✗ tmux not found in PATH."));
    console.error(`  ${kleur.dim(hint)}`);
    process.exit(1);
  }
}

export function checkNode(): void {
  const major = parseInt(process.versions.node.split(".")[0]!, 10);
  if (major < 22) {
    console.error(kleur.red(`✗ Node 22+ required (you have ${process.versions.node}).`));
    process.exit(1);
  }
}
