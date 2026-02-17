/**
 * Multi-Source Web Search
 *
 * Two engines:
 * 1. Serper.dev — controlled Google search with exact results, URLs, snippets
 *    Used for: targeted queries where you need specific URLs to visit
 *    Cost: $0.001/search (2500 free)
 *
 * 2. Gemini grounded search — broader, AI-summarized results
 *    Used for: discovery, "what's out there", comparison research
 *    Cost: practically free (Gemini Flash pricing)
 *
 * Claude decides which engine to use based on the task.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

let gemini: GoogleGenerativeAI;
function getGemini() {
  if (!gemini) gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return gemini;
}

// ============================================================
//  SERPER — Precise, structured Google results
// ============================================================

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export async function serperSearch(
  query: string,
  numResults: number = 8
): Promise<string> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return "ERROR: SERPER_API_KEY not set. Add it to .env for precise Google search.";
  }

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: numResults }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    let output = `Google results for: "${query}"\n\n`;

    if (data.answerBox?.answer) {
      output += `Quick answer: ${data.answerBox.answer}\n\n`;
    }

    if (data.organic) {
      for (const r of data.organic.slice(0, numResults) as SerperResult[]) {
        output += `[${r.position}] ${r.title}\n`;
        output += `    URL: ${r.link}\n`;
        output += `    ${r.snippet}\n\n`;
      }
    }

    // Also include "People Also Ask" if available — often useful
    if (data.peopleAlsoAsk) {
      output += "Related questions:\n";
      for (const q of data.peopleAlsoAsk.slice(0, 3)) {
        output += `  Q: ${q.question}\n  A: ${q.snippet?.slice(0, 150) || "N/A"}\n\n`;
      }
    }

    return output;
  } catch (error) {
    return `Serper search error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================
//  GEMINI GROUNDED — Broad discovery with AI summarization
// ============================================================

export async function geminiGroundedSearch(
  query: string,
  context: string
): Promise<string> {
  const model = getGemini().getGenerativeModel({ model: "gemini-2.0-flash" });

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Research query: "${query}"
Context: ${context}

Search the web thoroughly for this information. For each finding:
- Name of company/service/product
- Website URL (exact, not guessed)
- Concrete facts: pricing, features, coverage, limitations
- Source of information
- Any red flags or concerns

Be precise. Don't invent URLs or pricing. If unsure, say "unverified".`,
            },
          ],
        },
      ],
      tools: [{ googleSearch: {} }],
    });

    return result.response.text();
  } catch (error) {
    return `Gemini search error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
