import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const bump = process.argv[2] || "patch"; // patch | minor | major
const cliPkg = path.resolve("apps/cli/package.json");
const pkg = JSON.parse(await readFile(cliPkg, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const next =
  bump === "major"
    ? `${maj + 1}.0.0`
    : bump === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;

pkg.version = next;
await writeFile(cliPkg, JSON.stringify(pkg, null, 2) + "\n");

execSync(`git add ${cliPkg}`, { stdio: "inherit" });
execSync(`git commit -m "release(cli): v${next}"`, { stdio: "inherit" });
execSync(`git tag v${next}`, { stdio: "inherit" });
console.log(`tagged v${next}. push with: git push --follow-tags`);
