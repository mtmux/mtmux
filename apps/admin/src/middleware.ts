export { authMiddleware as middleware } from "@repo/auth/middleware";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
