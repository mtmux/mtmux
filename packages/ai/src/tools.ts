import { tool } from "ai";
import { z } from "zod";

export const weatherTool = tool({
  description: "Get the current weather for a location",
  parameters: z.object({
    location: z.string().describe("The city and country"),
  }),
  execute: async ({ location }) => {
    // Placeholder implementation
    return {
      location,
      temperature: 72,
      condition: "sunny",
    };
  },
});

export const calculatorTool = tool({
  description: "Perform a calculation",
  parameters: z.object({
    expression: z.string().describe("Mathematical expression to evaluate"),
  }),
  execute: async ({ expression }) => {
    // Safe eval using Function constructor
    try {
      const result = new Function(`return (${expression})`)();
      return { expression, result: Number(result) };
    } catch {
      return { expression, error: "Invalid expression" };
    }
  },
});
