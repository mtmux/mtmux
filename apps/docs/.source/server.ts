// @ts-nocheck
import * as __fd_glob_23 from "../content/docs/web-app/terminal.mdx?collection=docs";
import * as __fd_glob_22 from "../content/docs/web-app/sessions.mdx?collection=docs";
import * as __fd_glob_21 from "../content/docs/web-app/mobile.mdx?collection=docs";
import * as __fd_glob_20 from "../content/docs/web-app/index.mdx?collection=docs";
import * as __fd_glob_19 from "../content/docs/web-app/files.mdx?collection=docs";
import * as __fd_glob_18 from "../content/docs/relay/protocol.mdx?collection=docs";
import * as __fd_glob_17 from "../content/docs/relay/index.mdx?collection=docs";
import * as __fd_glob_16 from "../content/docs/troubleshooting.mdx?collection=docs";
import * as __fd_glob_15 from "../content/docs/self-hosting.mdx?collection=docs";
import * as __fd_glob_14 from "../content/docs/security.mdx?collection=docs";
import * as __fd_glob_13 from "../content/docs/sealed-tunnel.mdx?collection=docs";
import * as __fd_glob_12 from "../content/docs/pairing.mdx?collection=docs";
import * as __fd_glob_11 from "../content/docs/index.mdx?collection=docs";
import * as __fd_glob_10 from "../content/docs/getting-started.mdx?collection=docs";
import * as __fd_glob_9 from "../content/docs/doctor.mdx?collection=docs";
import * as __fd_glob_8 from "../content/docs/deployment.mdx?collection=docs";
import * as __fd_glob_7 from "../content/docs/configuration.mdx?collection=docs";
import * as __fd_glob_6 from "../content/docs/cli.mdx?collection=docs";
import * as __fd_glob_5 from "../content/docs/claude-code-remote.mdx?collection=docs";
import * as __fd_glob_4 from "../content/docs/architecture.mdx?collection=docs";
import * as __fd_glob_3 from "../content/docs/accounts.mdx?collection=docs";
import { default as __fd_glob_2 } from "../content/docs/web-app/meta.json?collection=docs";
import { default as __fd_glob_1 } from "../content/docs/relay/meta.json?collection=docs";
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs";
import { server } from "fumadocs-mdx/runtime/server";
import type * as Config from "../source.config";

const create = server<
  typeof Config,
  import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
    DocData: {};
  }
>();

export const docs = await create.docs(
  "docs",
  "content/docs",
  {
    "meta.json": __fd_glob_0,
    "relay/meta.json": __fd_glob_1,
    "web-app/meta.json": __fd_glob_2,
  },
  {
    "accounts.mdx": __fd_glob_3,
    "architecture.mdx": __fd_glob_4,
    "claude-code-remote.mdx": __fd_glob_5,
    "cli.mdx": __fd_glob_6,
    "configuration.mdx": __fd_glob_7,
    "deployment.mdx": __fd_glob_8,
    "doctor.mdx": __fd_glob_9,
    "getting-started.mdx": __fd_glob_10,
    "index.mdx": __fd_glob_11,
    "pairing.mdx": __fd_glob_12,
    "sealed-tunnel.mdx": __fd_glob_13,
    "security.mdx": __fd_glob_14,
    "self-hosting.mdx": __fd_glob_15,
    "troubleshooting.mdx": __fd_glob_16,
    "relay/index.mdx": __fd_glob_17,
    "relay/protocol.mdx": __fd_glob_18,
    "web-app/files.mdx": __fd_glob_19,
    "web-app/index.mdx": __fd_glob_20,
    "web-app/mobile.mdx": __fd_glob_21,
    "web-app/sessions.mdx": __fd_glob_22,
    "web-app/terminal.mdx": __fd_glob_23,
  },
);
