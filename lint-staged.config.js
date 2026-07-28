import path from "node:path";
import { existsSync } from "node:fs";

// This is a Turborepo with per-package ESLint flat configs (each app/package has
// its own eslint.config.js) and no root config. ESLint 9 resolves the flat config
// from the CWD, not from each file, so `eslint` run at the repo root can't find a
// config. Group staged TS files by their owning workspace and lint each group with
// that package as CWD. Files outside a package that has an eslint.config.js are
// left to Prettier only.
function eslintByWorkspace(files) {
  const root = process.cwd();
  const groups = new Map();
  for (const abs of files) {
    const rel = path.relative(root, abs);
    const parts = rel.split(path.sep);
    const pkg =
      (parts[0] === "apps" || parts[0] === "packages") && parts[1]
        ? path.join(parts[0], parts[1])
        : ".";
    if (!existsSync(path.join(root, pkg, "eslint.config.js"))) continue;
    if (!groups.has(pkg)) groups.set(pkg, []);
    groups.get(pkg).push(path.relative(path.join(root, pkg), abs));
  }
  // `pnpm exec` forces the workspace-local eslint 9 (a stray eslint may sit in a
  // parent node_modules and would otherwise win on PATH).
  return [...groups.entries()].map(
    ([pkg, rels]) =>
      `sh -c 'cd ${pkg} && pnpm exec eslint --fix ${rels.map((r) => `"${r}"`).join(" ")}'`,
  );
}

export default {
  "*.{ts,tsx}": eslintByWorkspace,
  // `.mdx` is deliberately absent.
  //
  // Prettier formats MDX with its markdown printer, which re-wraps prose to the
  // print width without understanding that inline JSX cannot straddle the
  // result. It turned `<Cmd>Ctrl-b</Cmd>` into an opening tag on one line and a
  // closing tag on the next, and MDX then failed to compile with "Expected a
  // closing tag for `<Cmd>` before the end of `paragraph`" — a build break, in
  // 37 content files, produced by a formatter running on commit.
  //
  // MDX is content, and content does not need a formatter.
  "*.{ts,tsx,js,jsx,mjs,cjs,json,css,md,yaml,yml}": [
    "pnpm exec prettier --write",
  ],
};
