import kleur from "kleur";
import * as configStore from "../config-store.js";

/**
 * `mtmux config` — the settings that are not flags.
 *
 * Deliberately one key, not a settings system. Everything else this CLI does is
 * either a per-run flag or a decision the product should make for you, and the
 * moment this becomes a generic key-value store it starts accumulating options
 * nobody chose. When there is a second genuine setting, this grows a table.
 */

type Setting = {
  describe: () => Promise<string>;
  set: (value: string) => Promise<void>;
  values: string[];
  help: string;
};

const SETTINGS: Record<string, Setting> = {
  reconnectPolicy: {
    describe: async () => configStore.getReconnectPolicy(),
    set: async (value) => {
      if (!configStore.isReconnectPolicy(value)) {
        throw new Error(`Not a reconnect policy: ${value}`);
      }
      await configStore.setReconnectPolicy(value);
    },
    values: ["trust", "confirm"],
    help: "Whether a previously paired device may reconnect without being asked.",
  },
};

export async function configGet(key?: string): Promise<void> {
  console.log("");
  const keys = key ? [key] : Object.keys(SETTINGS);
  for (const name of keys) {
    const setting = SETTINGS[name];
    if (!setting) {
      console.log(kleur.red(`  Unknown setting: ${name}`));
      console.log(
        kleur.dim(`  Known settings: ${Object.keys(SETTINGS).join(", ")}`),
      );
      console.log("");
      process.exitCode = 1;
      return;
    }
    console.log(`  ${kleur.dim(name.padEnd(16))}  ${await setting.describe()}`);
    console.log(kleur.dim(`  ${" ".repeat(16)}  ${setting.help}`));
  }
  console.log("");
}

export async function configSet(key: string, value: string): Promise<void> {
  const setting = SETTINGS[key];
  console.log("");
  if (!setting) {
    console.log(kleur.red(`  Unknown setting: ${key}`));
    console.log(
      kleur.dim(`  Known settings: ${Object.keys(SETTINGS).join(", ")}`),
    );
    console.log("");
    process.exitCode = 1;
    return;
  }

  try {
    await setting.set(value);
  } catch {
    console.log(
      kleur.red(`  ${key} must be one of: ${setting.values.join(", ")}`),
    );
    console.log("");
    process.exitCode = 1;
    return;
  }

  console.log(kleur.green(`  ✓ ${key} = ${value}`));
  // Said out loud because the value is read at boot: changing it while a
  // server is running looks like it did nothing until you notice why.
  console.log(kleur.dim("    Takes effect the next time mtmux starts."));
  console.log("");
}
