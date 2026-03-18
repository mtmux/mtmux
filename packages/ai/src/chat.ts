import { streamText, generateText } from "ai";
import { models, type ModelId } from "./providers";

interface ChatOptions {
  model?: ModelId;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export function streamChat({ model = "gpt-4o-mini", system, messages }: ChatOptions) {
  return streamText({
    model: models[model],
    system,
    messages,
  });
}

export function generateChat({ model = "gpt-4o-mini", system, messages }: ChatOptions) {
  return generateText({
    model: models[model],
    system,
    messages,
  });
}
