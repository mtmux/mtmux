import { router } from "./trpc";
import { userRouter } from "./routers/user";
import { adminRouter } from "./routers/admin";
import { storageRouter } from "./routers/storage";
import { aiRouter } from "./routers/ai";

export const appRouter = router({
  user: userRouter,
  admin: adminRouter,
  storage: storageRouter,
  ai: aiRouter,
});

export type AppRouter = typeof appRouter;
