/**
 * Research Agent — Multi-model with persistent memory
 *
 *   SONNET (orchestrator)
 *     │
 *     ├── google_search ──→ Serper API (precise URLs + snippets)
 *     ├── discover ────────→ Gemini grounded search (broad discovery)
 *     ├── extract_page ───→ Jina fetch + Gemini parse (deep extraction)
 *     ├── read_page ──────→ Jina fetch → raw text to Sonnet (when Sonnet wants to read itself)
 *     ├── evaluate ───────→ structured scoring (stored in memory)
 *     └── recall_memory ──→ query past research sessions
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { serperSearch, geminiGroundedSearch } from "./search.js";
import { extractFromUrl, getPageText } from "./scrape.js";
import { getMemoryContext, saveSession } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import { compressHistory, estimateTokens, COMPRESS_EVERY } from "./compress.js";
import { exportToSheets } from "./sheets.js";
import type {
  ResearchCriteria,
  ResearchResult,
  ResearchSession,
  CandidateRecord,
} from "./types.js";

let claude: Anthropic;
function getClaude() {
  if (!claude) claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return claude;
}
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const MAX_ITERATIONS = 10;

// ============================================================
//  TOOL DEFINITIONS
// ============================================================

const tools: Anthropic.Tool[] = [
  {
    name: "google_search",
    description: `Precise Google search via Serper API. Returns exact URLs, titles, and snippets.
Best for: finding specific companies, pricing pages, documentation, forum threads.
Returns 8 results. Use specific queries — industry terms, company names, "vs" comparisons.
Try both English and Russian queries for regional services.`,
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Google search query. Be specific.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "discover",
    description: `Broad AI-powered web research via Gemini + Google. Returns summarized findings, not raw links.
Best for: initial discovery, "what options exist", market overview, finding alternatives to known services.
Slower than google_search but provides more synthesized context.`,
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Research query",
        },
        context: {
          type: "string",
          description: "What you're looking for and why (helps focus the search)",
        },
      },
      required: ["query", "context"],
    },
  },
  {
    name: "extract_page",
    description: `Visit a URL and extract specific information using AI parsing.
A sub-agent fetches the full page and uses Gemini (1M token context) to find exactly what you need.
Best for: pricing pages, feature lists, API docs, country coverage lists, terms of service.
Be VERY specific about what to extract — the more precise, the better the results.`,
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Full URL to visit" },
        what_to_extract: {
          type: "string",
          description:
            "Precise extraction task. E.g.: 'Find per-SMS pricing to Argentina, supported API protocols, uptime SLA, and whether they require minimum volume commitment'",
        },
      },
      required: ["url", "what_to_extract"],
    },
  },
  {
    name: "read_page",
    description: `Fetch a page and return raw text content to you directly.
Use when YOU want to read and analyze the page yourself instead of delegating to a sub-agent.
Good for: reviews, forum threads, comparison articles where nuance matters.
Note: content is capped at 30k chars. For longer pages, use extract_page instead.`,
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to read" },
      },
      required: ["url"],
    },
  },
  {
    name: "evaluate",
    description: `Record a formal candidate evaluation against criteria.
ONLY use after gathering sufficient evidence. This saves the evaluation to persistent memory.
Be honest — if evidence is missing, mark as needs_more_info, don't guess.`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Candidate name" },
        url: { type: "string", description: "Website" },
        hard_criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string" },
              passed: { type: "boolean" },
              evidence: { type: "string" },
            },
            required: ["criterion", "passed", "evidence"],
          },
        },
        soft_criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string" },
              score: { type: "number" },
              reasoning: { type: "string" },
            },
            required: ["criterion", "score", "reasoning"],
          },
        },
        verdict: {
          type: "string",
          enum: ["pass", "fail", "needs_more_info"],
        },
        rejection_reason: {
          type: "string",
          description: "If verdict=fail, brief reason why",
        },
        notes: {
          type: "string",
          description: "Additional observations, risks, follow-ups",
        },
      },
      required: ["name", "hard_criteria", "verdict"],
    },
  },
];

// ============================================================
//  TOOL EXECUTION
// ============================================================

const sessionCandidates: CandidateRecord[] = [];
const sessionQueries: string[] = [];

async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const t0 = Date.now();

  switch (name) {
    case "google_search": {
      const query = input.query as string;
      sessionQueries.push(query);
      console.log(`  🔍 [Serper] "${query}"`);
      const result = await serperSearch(query);
      console.log(`  ✅ done in ${Date.now() - t0}ms`);
      return result;
    }

    case "discover": {
      const query = input.query as string;
      sessionQueries.push(`[discover] ${query}`);
      console.log(`  🌐 [Gemini] Discovering: "${query}"`);
      const result = await geminiGroundedSearch(query, input.context as string);
      console.log(`  ✅ done in ${Date.now() - t0}ms`);
      return result;
    }

    case "extract_page": {
      console.log(`  📄 [Gemini] Extracting from: ${input.url}`);
      const result = await extractFromUrl(
        input.url as string,
        input.what_to_extract as string
      );
      console.log(`  ✅ done in ${Date.now() - t0}ms`);
      return result;
    }

    case "read_page": {
      console.log(`  📖 [Direct] Reading: ${input.url}`);
      const result = await getPageText(input.url as string);
      console.log(`  ✅ ${(result.length / 1000).toFixed(0)}k chars, ${Date.now() - t0}ms`);
      return result;
    }

    case "evaluate": {
      return handleEvaluation(input);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function handleEvaluation(input: Record<string, unknown>): string {
  const hardResults = input.hard_criteria as CandidateRecord["hardResults"];
  const softScores = (input.soft_criteria as CandidateRecord["softScores"]) || [];
  const verdict = input.verdict as CandidateRecord["verdict"];

  const candidate: CandidateRecord = {
    name: input.name as string,
    url: input.url as string | undefined,
    verdict,
    hardResults,
    softScores,
    rejectionReason: input.rejection_reason as string | undefined,
    notes: input.notes as string | undefined,
  };

  sessionCandidates.push(candidate);

  // Build evaluation report
  const passed = hardResults.filter((r) => r.passed).length;
  const total = hardResults.length;

  let report = `\n📊 EVALUATION: ${candidate.name}\n`;
  report += `${"─".repeat(50)}\n`;
  report += `Hard criteria: ${passed}/${total} ${passed === total ? "✅ ALL PASSED" : "❌ FAILED"}\n`;

  for (const r of hardResults) {
    report += `  ${r.passed ? "✅" : "❌"} ${r.criterion}\n`;
    report += `     ${r.evidence}\n`;
  }

  if (softScores.length > 0) {
    const avg = softScores.reduce((s, x) => s + x.score, 0) / softScores.length;
    report += `\nSoft criteria: avg ${avg.toFixed(1)}/10\n`;
    for (const s of softScores) {
      report += `  ${s.score}/10 — ${s.criterion}\n`;
      report += `     ${s.reasoning}\n`;
    }
  }

  report += `\nVerdict: ${verdict.toUpperCase()}`;
  if (candidate.rejectionReason) report += ` — ${candidate.rejectionReason}`;
  if (candidate.notes) report += `\nNotes: ${candidate.notes}`;
  report += "\n";

  console.log(`  📊 [Eval] ${candidate.name}: ${verdict.toUpperCase()}`);

  return report;
}

// ============================================================
//  MAIN AGENT LOOP
// ============================================================

export async function runResearchAgent(
  task: string,
  criteria: ResearchCriteria
): Promise<ResearchResult> {
  // Reset session state
  sessionCandidates.length = 0;
  sessionQueries.length = 0;

  // Get relevant memory
  const memoryContext = getMemoryContext(task);

  const systemPrompt = buildSystemPrompt(criteria, memoryContext);
  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: task },
  ];

  let iterations = 0;
  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  console.log(`\n🧠 Research agent starting...`);
  console.log(`📋 ${criteria.hard.length} hard + ${criteria.soft.length} soft criteria`);
  if (memoryContext !== "No prior research history." && memoryContext !== "No relevant prior research found for this task.") {
    console.log(`🧠 Loaded relevant memory from past sessions`);
  }
  console.log(`🗜️ Context compression every ${COMPRESS_EVERY} iterations`);
  console.log(`${"─".repeat(50)}\n`);

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // --- Compress history periodically ---
    if (iterations > 1 && (iterations - 1) % COMPRESS_EVERY === 0) {
      messages = await compressHistory(messages);
    }

    const inputTokensEst = estimateTokens(messages);
    console.log(`  📏 [iter ${iterations}] ~${inputTokensEst} input tokens`);

    let response: Anthropic.Message;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        response = await getClaude().messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        });
        break;
      } catch (err: any) {
        if (err?.status === 429 && attempt < 4) {
          const wait = Math.min(15 * (attempt + 1), 60);
          console.log(`  ⏳ Rate limited, waiting ${wait}s (attempt ${attempt + 1}/5)...`);
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }
        throw err;
      }
    }

    // Track actual usage from API response
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Log thinking
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        const preview = block.text.slice(0, 400);
        console.log(`\n🧠 [iter ${iterations}] ${preview}${block.text.length > 400 ? "..." : ""}`);
      }
    }

    // Done
    if (response.stop_reason === "end_turn") {
      const finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      // Save session to memory
      const session: ResearchSession = {
        id: `session_${Date.now()}`,
        timestamp: new Date().toISOString(),
        task,
        criteria,
        candidates: sessionCandidates,
        bestMatch: sessionCandidates.find((c) => c.verdict === "pass")?.name,
        searchQueries: sessionQueries,
        conclusion: finalText.slice(0, 500),
      };
      saveSession(session);

      // Calculate cost
      const totalCost = (totalInputTokens / 1_000_000) * 3 + (totalOutputTokens / 1_000_000) * 15;

      // Export to Google Sheets
      const costData = { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedUsd: totalCost };
      const sheetUrl = await exportToSheets(session, costData);

      // Cost report
      console.log(`\n💾 Session saved (${sessionCandidates.length} candidates)`);
      console.log(`💰 Sonnet cost: $${totalCost.toFixed(3)} (${totalInputTokens} in + ${totalOutputTokens} out)`);
      if (sheetUrl) console.log(`📊 Sheets: ${sheetUrl}`);

      return {
        answer: finalText,
        iterations,
        toolCalls: toolCallCount,
        candidatesEvaluated: sessionCandidates.length,
        sheetUrl: sheetUrl || undefined,
        cost: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          estimatedUsd: totalCost,
        },
      };
    }

    // Tool calls
    if (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolBlocks) {
        toolCallCount++;

        try {
          const result = await executeTool(
            toolCall.name,
            toolCall.input as Record<string, unknown>
          );
          // Cap tool results to control context size (saves ~60% on costs)
          const MAX_RESULT = 4000;
          const trimmed = result.length > MAX_RESULT
            ? result.slice(0, MAX_RESULT) + `\n\n[Truncated: ${result.length} chars total. Key info above.]`
            : result;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: trimmed,
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }
  }

  // Save even if max iterations reached
  const session: ResearchSession = {
    id: `session_${Date.now()}`,
    timestamp: new Date().toISOString(),
    task,
    criteria,
    candidates: sessionCandidates,
    searchQueries: sessionQueries,
    conclusion: `Reached max iterations (${MAX_ITERATIONS}). Evaluated ${sessionCandidates.length} candidates.`,
  };
  saveSession(session);

  const costInput = (totalInputTokens / 1_000_000) * 3;
  const costOutput = (totalOutputTokens / 1_000_000) * 15;
  const totalCost = costInput + costOutput;

  await exportToSheets(session, { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedUsd: totalCost });

  return {
    answer: `Research stopped after ${MAX_ITERATIONS} iterations. Evaluated ${sessionCandidates.length} candidates. Results saved to memory.`,
    iterations,
    toolCalls: toolCallCount,
    candidatesEvaluated: sessionCandidates.length,
    cost: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedUsd: totalCost,
    },
  };
}
