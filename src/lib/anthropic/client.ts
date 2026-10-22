import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local before drafting a section.");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const NARRATIVE_MODEL = "claude-sonnet-4-5";
export const VISION_MODEL = "claude-sonnet-4-5";
