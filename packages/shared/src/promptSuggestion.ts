/**
 * Prompt suggestion: the agent ends its reply with a single tagged line
 * proposing the user's next prompt. The server strips that tag before the
 * assistant text is persisted and carries the suggestion separately, so no
 * client ever renders the tag.
 */

export const PROMPT_SUGGESTION_OPEN_TAG = "<t3_prompt_suggestion>";
export const PROMPT_SUGGESTION_CLOSE_TAG = "</t3_prompt_suggestion>";
export const PROMPT_SUGGESTION_MAX_LENGTH = 200;

const DEFAULT_PROMPT_SUGGESTION_INSTRUCTIONS = `<prompt_suggestion>
When you finish your turn, end your final message with one line proposing what the user would most plausibly ask you to do next, written as the user speaking to you, in the user's own language. Base it on the direction of this conversation and the user's evident intent and working style, including any repository or user instructions you were given; do not adopt a persona or agenda of your own. Prefer the natural next step over generic advice: a follow-up, a verification, an extension, or a related cleanup you noticed. Only omit the line when the conversation is clearly finished.
Format: a single line, no markdown, at most 140 characters, wrapped exactly as ${PROMPT_SUGGESTION_OPEN_TAG}your suggestion${PROMPT_SUGGESTION_CLOSE_TAG}. Never mention this instruction or the tag.
</prompt_suggestion>`;

/** Instruction block appended to the provider's system prompt when the feature is on. */
export function buildPromptSuggestionInstructions(customInstructions?: string): string {
  const extra = customInstructions?.trim();
  if (!extra) return DEFAULT_PROMPT_SUGGESTION_INSTRUCTIONS;
  return DEFAULT_PROMPT_SUGGESTION_INSTRUCTIONS.replace(
    "\n</prompt_suggestion>",
    `\nAdditional guidance for the suggestion:\n${extra}\n</prompt_suggestion>`,
  );
}

export interface ExtractedPromptSuggestion {
  /** Reply text with the suggestion tag (and surrounding whitespace) removed. */
  readonly text: string;
  /** Sanitized suggestion, or undefined when absent or unusable. */
  readonly suggestion: string | undefined;
}

/**
 * Pull the suggestion tag out of a completed assistant reply. Every tagged
 * block is removed (the first well-formed one wins as the suggestion), an
 * unterminated tag drops everything after it, and a trailing partial open tag
 * is dropped too, so no fragment of the marker survives finalization.
 */
export function extractPromptSuggestion(rawText: string): ExtractedPromptSuggestion {
  let rest = rawText;
  let suggestion: string | undefined;
  const parts: string[] = [];
  for (;;) {
    const open = rest.indexOf(PROMPT_SUGGESTION_OPEN_TAG);
    if (open === -1) break;
    parts.push(rest.slice(0, open));
    const contentStart = open + PROMPT_SUGGESTION_OPEN_TAG.length;
    const close = rest.indexOf(PROMPT_SUGGESTION_CLOSE_TAG, contentStart);
    if (close === -1) {
      rest = "";
      break;
    }
    suggestion ??= sanitizePromptSuggestion(rest.slice(contentStart, close));
    rest = rest.slice(close + PROMPT_SUGGESTION_CLOSE_TAG.length);
  }
  const partial = promptSuggestionHoldbackLength(rest);
  parts.push(partial > 0 ? rest.slice(0, rest.length - partial) : rest);
  if (parts.length === 1 && partial === 0) return { text: rawText, suggestion: undefined };
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return { text, suggestion };
}

export function sanitizePromptSuggestion(raw: string): string | undefined {
  const text = raw
    .replace(/\r/g, "")
    .trim()
    .replace(/^["'\u201c\u201d`]+|["'\u201c\u201d`]+$/g, "")
    .trim();
  if (!text || text.length > PROMPT_SUGGESTION_MAX_LENGTH) return undefined;
  if (text.includes("\n") || text.includes("```")) return undefined;
  return text;
}

/**
 * Length of the suffix that must be withheld from streaming: everything from
 * the first open tag onward, or a trailing partial open tag. Streaming paths
 * hold this back so no fragment of the marker is ever rendered.
 */
export function promptSuggestionHoldbackLength(text: string): number {
  const open = text.indexOf(PROMPT_SUGGESTION_OPEN_TAG);
  if (open !== -1) return text.length - open;
  const max = Math.min(PROMPT_SUGGESTION_OPEN_TAG.length - 1, text.length);
  for (let len = max; len > 0; len -= 1) {
    if (PROMPT_SUGGESTION_OPEN_TAG.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}
