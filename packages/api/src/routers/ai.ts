import { z } from "zod";
import { router, protectedProcedure } from "../trpc";

export const aiRouter = router({
  models: protectedProcedure.query(async () => {
    return {
      available: [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    };
  }),
});
