import * as configStore from "../config-store.js";
import kleur from "kleur";

export async function tokenPrint() {
  const cfg = await configStore.load();
  console.log(cfg.token);
}

export async function tokenRotate() {
  const cfg = await configStore.regenerate();
  console.log(kleur.green("✓ token rotated"));
  console.log(kleur.dim(cfg.token));
}

export async function tokenSet(value: string) {
  await configStore.set(value);
  console.log(kleur.green("✓ token set"));
}
