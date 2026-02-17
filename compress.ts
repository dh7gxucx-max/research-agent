/**
 * Context Compression
 *
 * Problem: Claude API charges per input token, and conversation history
 * grows with every iteration. By iteration 15, you're sending 30-40k tokens
 * of accumulated tool results EVERY call — most of which is stale.
 *
 * Solution: Every COMPRESS_EVERY iterations, use Gemini Flash (cheap) to
 * summarize the conversation history into a compact progress report.
 * Then replace the full history with:
 *   [original task] + [compressed summary] + [last 2 exchanges]
 *
 * Impact on cost:
 *   Without compression: ~200-300k cumulative input tokens ($0.60-0.90)
 *   With compression:    ~60-90k cumulative input tokens  ($0.18-0.27)
 *   Savings: ~60-70%
 *
 * Impact on quality:
 *   Minimal — the summary preserves all decisions, evidence, and progress.
 *   Sonnet still has the last 2 raw exchanges for immediate context.
 *   Key evaluations are already saved in memory.ts separately.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

let gemini: GoogleGenerativeAI;
function getGemini() {
  if (!gemini) gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return gemini;
}

/** Compress every N iterations */
export const COMPRESS_EVERY = 3;

/**
 * Estimate token count (rough: 1 token ≈ 4 chars for English, 2-3 for mixed)
 */
export function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          chars += block.text.length;
        } else if ("content" in block && typeof block.content === "string") {
          chars += block.content.length;
        }
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

/**
 * Compress conversation history using Gemini Flash.
 *
 * Takes the full message array and returns a compressed version:
 * [original user task] + [summary as assistant message] + [last N raw exchanges]
 */
export async function compressHistory(
  messages: Anthropic.MessageParam[],
  keepLastExchanges: number = 2
): Promise<Anthropic.MessageParam[]> {
  if (messages.length < 6) return messages; // too short to compress

  // Separate: first message (task) + middle (to compress) + tail (keep raw)
  const firstMessage = messages[0]; // original user task
  const tailCount = keepLastExchanges * 2; // each exchange = assistant + user
  const tail = messages.slice(-tailCount);
  const middle = messages.slice(1, -tailCount);

  if (middle.length < 4) return messages; // not enough to compress

  // Serialize middle section to text for Gemini
  const middleText = serializeMessages(middle);

  const beforeTokens = estimateTokens(messages);
  console.log(`  🗜️ Compressing: ${beforeTokens} est. tokens, ${middle.length} messages to summarize...`);

  const model = getGemini().getGenerativeModel({ model: "gemini-2.0-flash" });

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are a research progress summarizer. Below is a conversation between a research agent and its tools. Compress it into a structured progress report.

CONVERSATION TO COMPRESS:
${middleText}

Create a CONCISE progress summary with these sections:

## Search Progress
- Queries executed (list briefly)
- Sources visited (URL + what was found, 1 line each)

## Candidates Evaluated
For each candidate:
- Name + URL
- Verdict: PASS / FAIL / NEEDS_MORE_INFO
- Key evidence for/against (1-2 lines)
- Rejection reason if failed

## Key Findings
- Important facts discovered (pricing, features, limitations)
- Contradictions or red flags noticed

## Current Strategy
- What approach is being used
- What hasn't been tried yet
- Suggested next steps based on progress

RULES:
- Preserve ALL specific data points (prices, percentages, names, URLs)
- Preserve ALL verdicts and rejection reasons
- Drop verbose tool outputs, keep only extracted facts
- Keep it under 2000 words
- Do NOT add your own analysis — just compress what happened`,
            },
          ],
        },
      ],
    });

    const summary = result.response.text();

    // Reconstruct: task + summary + recent raw exchanges
    const compressed: Anthropic.MessageParam[] = [
      firstMessage,
      {
        role: "assistant",
        content: "I'll begin researching this. Let me start by reviewing my progress so far.",
      },
      {
        role: "user",
        content: `[RESEARCH PROGRESS SUMMARY — compressed from ${middle.length} previous exchanges]\n\n${summary}\n\n[END SUMMARY — continuing research from here]`,
      },
      ...tail,
    ];

    const afterTokens = estimateTokens(compressed);
    const savings = Math.round((1 - afterTokens / beforeTokens) * 100);
    console.log(`  ✅ Compressed: ${beforeTokens} → ${afterTokens} tokens (${savings}% reduction)`);

    return compressed;
  } catch (error) {
    console.error("  ⚠️ Compression failed, keeping full history:", error);
    return messages; // fallback: don't compress
  }
}

/**
 * Serialize messages to readable text for Gemini
 */
function serializeMessages(messages: Anthropic.MessageParam[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role.toUpperCase();

    if (typeof msg.content === "string") {
      parts.push(`[${role}]: ${msg.content}`);
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "text" && "text" in block) {
        parts.push(`[${role} — thinking]: ${block.text}`);
      } else if (block.type === "tool_use" && "name" in block) {
        const input = "input" in block ? JSON.stringify(block.input).slice(0, 200) : "";
        parts.push(`[${role} — tool_call]: ${block.name}(${input})`);
      } else if (block.type === "tool_result" && "content" in block) {
        const content =
          typeof block.content === "string"
            ? block.content.slice(0, 1000)
            : JSON.stringify(block.content).slice(0, 1000);
        parts.push(`[TOOL_RESULT]: ${content}${content.length >= 1000 ? "..." : ""}`);
      }
    }
  }

  return parts.join("\n\n");
}
