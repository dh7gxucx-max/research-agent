import dotenv from "dotenv";
dotenv.config({ override: true });

import { runResearchAgent } from "./agent.js";
import type { ResearchCriteria } from "./types.js";

// --- EDIT YOUR TASK AND CRITERIA HERE ---

const criteria: ResearchCriteria = {
  hard: [
    {
      field: "sms_coverage_argentina",
      description: "Must support direct (white-route) SMS delivery to Argentina",
    },
    {
      field: "rest_api",
      description: "Must offer HTTP/REST API for programmatic SMS sending",
    },
    {
      field: "transparent_pricing",
      description: "Must have publicly available or quotable pricing (not 'contact sales only' with no indication)",
    },
    {
      field: "price_limit",
      description: "Price per SMS to Argentina must be under $0.05 USD",
    },
  ],

  soft: [
    {
      description: "Company reputation — established player, not a fly-by-night reseller",
      weight: 4,
    },
    {
      description: "Quality of technical documentation and developer experience",
      weight: 3,
    },
    {
      description: "Responsive support confirmed by reviews or testimonials",
      weight: 3,
    },
    {
      description: "Compliance certifications or telecom licenses",
      weight: 2,
    },
  ],
};

const task = `Find an SMS aggregator/provider offering white-route direct SMS delivery to Argentina.
Requirements: business A2P SMS, proper REST API, transparent pricing under $0.05/SMS.
Should be an established, reputable company — not a reseller chain.
Check comparison sites, forums, and direct provider websites.`;

// --- RUN ---

async function main() {
  console.log("🚀 Research Agent (CLI mode)\n");

  const result = await runResearchAgent(task, criteria);

  console.log("\n" + "=".repeat(60));
  console.log("📋 FINAL REPORT");
  console.log("=".repeat(60));
  console.log(result.answer);
  console.log(`\n📊 ${result.iterations} iterations, ${result.toolCalls} tool calls, ${result.candidatesEvaluated} candidates`);
  if (result.cost) {
    console.log(`💰 Sonnet: $${result.cost.estimatedUsd.toFixed(3)} (${result.cost.inputTokens} in + ${result.cost.outputTokens} out)`);
  }
}

main().catch(console.error);
