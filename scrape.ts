/**
 * Two-stage page extraction:
 * 1. Jina Reader fetches and cleans the page → raw text/markdown
 * 2. Gemini Flash parses the raw text → structured facts
 *
 * Why not feed raw HTML to Claude?
 * - Expensive: a pricing page can be 50-200k tokens
 * - Wasteful: 90% is nav/footer/ads
 * - Gemini Flash handles 1M tokens at 1/30th the cost
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

let gemini: GoogleGenerativeAI;
function getGemini() {
  if (!gemini) gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return gemini;
}

/**
 * Fetch page content via Jina Reader (clean text extraction).
 */
async function fetchPage(url: string): Promise<string> {
  // Strategy 1: Jina Reader
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: "text/plain",
        ...(process.env.JINA_API_KEY
          ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` }
          : {}),
      },
      signal: AbortSignal.timeout(20000),
    });

    if (response.ok) {
      return await response.text();
    }
  } catch {}

  // Strategy 2: Direct fetch
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return `FAILED: HTTP ${response.status}`;

    let html = await response.text();

    // Basic HTML cleanup
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s{2,}/g, " ")
      .trim();

    return html;
  } catch (e) {
    return `FAILED: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Extract specific information from a URL.
 * Fetches page via Jina, then uses Gemini to parse out what's needed.
 */
export async function extractFromUrl(
  url: string,
  extractionTask: string
): Promise<string> {
  console.log(`    📥 Fetching: ${url}`);
  const rawContent = await fetchPage(url);

  if (rawContent.startsWith("FAILED")) {
    return `Could not access ${url}: ${rawContent}`;
  }

  // Cap content for Gemini (generous but not wasteful)
  const MAX_CHARS = 150_000;
  const content =
    rawContent.length > MAX_CHARS
      ? rawContent.slice(0, MAX_CHARS) +
        `\n\n[Page truncated: ${rawContent.length} total chars]`
      : rawContent;

  console.log(`    🔬 Parsing ${(content.length / 1000).toFixed(0)}k chars with Gemini...`);

  const model = getGemini().getGenerativeModel({ model: "gemini-2.0-flash" });

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Source URL: ${url}

PAGE CONTENT:
${content}

---

EXTRACTION TASK: ${extractionTask}

Instructions:
1. Extract ONLY information that is ACTUALLY PRESENT on this page
2. For prices, quote the EXACT numbers and currencies shown
3. For features/capabilities, quote the actual text or paraphrase precisely
4. If information is NOT on this page, say "NOT FOUND ON THIS PAGE"
5. Note if anything seems outdated, contradictory, or suspicious
6. Include specific quotes as evidence where relevant

Format your response clearly with labeled sections.`,
            },
          ],
        },
      ],
    });

    return `Extracted from ${url}:\n\n${result.response.text()}`;
  } catch (error) {
    return `Extraction failed for ${url}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Quick page scan — just get the raw text without Gemini parsing.
 * Useful when Claude wants to read the page itself.
 */
export async function getPageText(url: string): Promise<string> {
  const content = await fetchPage(url);

  // For Claude, keep it under 12k chars to control costs
  const MAX_CHARS = 12_000;
  if (content.length > MAX_CHARS) {
    return (
      content.slice(0, MAX_CHARS) +
      `\n\n[Truncated. Full page: ${content.length} chars. Use extract_from_url for targeted extraction.]`
    );
  }
  return content;
}
