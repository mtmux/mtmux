import { z } from "zod";
import { router, protectedProcedure } from "../trpc";

export const storageRouter = router({
  listFiles: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.fileUpload.findMany({
      where: { userId: ctx.user.id },
      orderBy: { createdAt: "desc" },
    });
  }),

  deleteFile: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.fileUpload.delete({
        where: { id: input.id, userId: ctx.user.id },
      });
    }),
});
