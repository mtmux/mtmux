/**
 * Author registry.
 *
 * Posts reference an author by key. Real, attributable bylines linked to a
 * profile are an E-E-A-T signal: Google and AI answer engines both weight
 * author-to-entity linkage when deciding whether a technical page is credible.
 */

export type Author = {
  key: string;
  name: string;
  /** One line, shown under the byline. */
  role: string;
  /** Two or three sentences, shown in the post footer. */
  bio: string;
  /** Monogram used when no avatar image exists. */
  initials: string;
  url?: string;
  github?: string;
};

const repo = "https://github.com/GagnDeep/tmuxremote";

export const authors = {
  team: {
    key: "team",
    name: "The mtmux team",
    role: "Building mtmux",
    bio: "We build mtmux, an MIT-licensed CLI that serves the tmux sessions you already run to any browser, over an end-to-end encrypted tunnel.",
    initials: "mt",
    github: repo,
  },
  "ivo-hart": {
    key: "ivo-hart",
    name: "Ivo Hart",
    role: "Systems engineer, mtmux",
    bio: "Ivo works on the mtmux CLI and the pty bridge that attaches it to tmux. Fifteen years of terminal multiplexers, most of them spent arguing about prefix keys.",
    initials: "ih",
    github: repo,
  },
  "nadia-okonkwo": {
    key: "nadia-okonkwo",
    name: "Nadia Okonkwo",
    role: "Protocol & crypto, mtmux",
    bio: "Nadia works on the pairing handshake and the sealed transport — the CPace exchange and the AES-GCM framing that keep the relay unable to read a session.",
    initials: "no",
    github: repo,
  },
} as const satisfies Record<string, Author>;

export type AuthorKey = keyof typeof authors;

export const defaultAuthor: AuthorKey = "team";

export function getAuthor(key: string): Author {
  return authors[key as AuthorKey] ?? authors[defaultAuthor];
}
