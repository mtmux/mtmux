// @ts-nocheck
import * as __fd_glob_14 from "../content/docs/web-app/terminal.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/web-app/sessions.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/web-app/mobile.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/web-app/index.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/web-app/files.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/relay/protocol.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/relay/index.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/troubleshooting.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/deployment.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/configuration.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/architecture.mdx?collection=docs"
import { default as __fd_glob_2 } from "../content/docs/web-app/meta.json?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/relay/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "relay/meta.json": __fd_glob_1, "web-app/meta.json": __fd_glob_2, }, {"architecture.mdx": __fd_glob_3, "configuration.mdx": __fd_glob_4, "deployment.mdx": __fd_glob_5, "index.mdx": __fd_glob_6, "troubleshooting.mdx": __fd_glob_7, "relay/index.mdx": __fd_glob_8, "relay/protocol.mdx": __fd_glob_9, "web-app/files.mdx": __fd_glob_10, "web-app/index.mdx": __fd_glob_11, "web-app/mobile.mdx": __fd_glob_12, "web-app/sessions.mdx": __fd_glob_13, "web-app/terminal.mdx": __fd_glob_14, });