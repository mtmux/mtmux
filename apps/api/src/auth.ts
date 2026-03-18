import { auth } from "@repo/auth";
import type { Context } from "hono";

export const authHandler = async (c: Context) => {
  return auth.handler(c.req.raw);
};
