/**
 * Parse natural language request → structured criteria
 * Uses Gemini Flash for cost efficiency (this is a simple extraction task)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ResearchCriteria } from "./types.js";

let gemini: GoogleGenerativeAI;
function getGemini() {
  if (!gemini) gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return gemini;
}

export async function parseRequest(userText: string): Promise<{
  task: string;
  criteria: ResearchCriteria;
}> {
  const model = getGemini().getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: { responseMimeType: "application/json" },
  });

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Parse this research request into structured criteria.
Input may be in Russian, English, or mixed.

Request: "${userText}"

Return JSON:
{
  "task": "Detailed English description of what to search for (expand on user's request with context)",
  "criteria": {
    "hard": [
      {"field": "short_snake_name", "description": "Criterion that MUST be met"}
    ],
    "soft": [
      {"description": "Desired but negotiable criterion", "weight": 3}
    ]
  }
}

Rules:
- "обязательно", "must", "strictly", price limits, technical reqs → HARD
- "желательно", "preferably", "would be nice", subjective → SOFT
- Ambiguous → SOFT weight 3
- weight: 1=nice, 2=somewhat, 3=important, 4=very, 5=near-mandatory
- Minimum 2 hard + 2 soft. Infer reasonable ones if user is vague.
- Be specific in descriptions — include numbers, countries, technologies mentioned.`,
            },
          ],
        },
      ],
    });

    const parsed = JSON.parse(result.response.text());

    // Validate
    if (!parsed.task || !parsed.criteria?.hard?.length || !parsed.criteria?.soft?.length) {
      throw new Error("Invalid structure");
    }

    return parsed;
  } catch {
    return {
      task: userText,
      criteria: {
        hard: [
          { field: "exists", description: "Must be a real, currently operational service" },
          { field: "core_match", description: `Must match core request: ${userText.slice(0, 300)}` },
        ],
        soft: [
          { description: "Good reputation and established presence", weight: 3 },
          { description: "Reasonable and transparent pricing", weight: 3 },
        ],
      },
    };
  }
}
