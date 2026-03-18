import { z } from "zod";
import { router, protectedProcedure } from "../trpc";

export const adminRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    const [userCount, orgCount, projectCount] = await Promise.all([
      ctx.db.user.count(),
      ctx.db.organization.count(),
      ctx.db.project.count(),
    ]);

    return { userCount, orgCount, projectCount };
  }),

  organizations: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.organization.findMany({
      include: {
        _count: { select: { members: true, projects: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }),
});
