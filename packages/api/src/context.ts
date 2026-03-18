import { prisma } from "@repo/db";
import { auth } from "@repo/auth";

export async function createContext(opts: { headers: Headers }) {
  const session = await auth.api.getSession({
    headers: opts.headers,
  });

  return {
    db: prisma,
    session,
    headers: opts.headers,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
