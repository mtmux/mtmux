const monacoLanguageMap: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  toml: "ini",
  md: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  r: "r",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  dart: "dart",
  vue: "html",
  svelte: "html",
  prisma: "graphql",
};

export function getMonacoLanguage(filePath: string): string {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";

  // Handle special filenames
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";

  const ext = name.split(".").pop() ?? "";
  return monacoLanguageMap[ext] ?? "plaintext";
}

export function getLanguageLabel(filePath: string): string {
  const lang = getMonacoLanguage(filePath);
  return lang === "plaintext" ? "text" : lang;
}
