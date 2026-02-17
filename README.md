# 🔍 Research Agent v2

AI research agent with multi-source search, persistent memory, and Telegram interface. Finds services/products matching your exact criteria through iterative search, deep page analysis, and structured evaluation.

## Architecture

```
  You (Telegram text/voice)
   │
   ▼
  Gemini Flash ──→ parse criteria from natural language (cheap)
   │
   ▼
  Claude Sonnet (orchestrator brain)
   │
   ├── google_search ──→ Serper API (precise URLs, 8 results)
   ├── discover ───────→ Gemini + Google grounding (broad research)
   ├── extract_page ───→ Jina fetch + Gemini parse (deep extraction, 150k chars)
   ├── read_page ──────→ Jina fetch → raw text to Sonnet (nuanced analysis)
   └── evaluate ───────→ structured scoring → saved to memory
   │
   │  every 5 iterations:
   ├── compress ───────→ Gemini summarizes history (60-70% token savings)
   │
   ▼
  memory.json (persistent between sessions)
   │
   ▼
  Google Sheets (structured export: Summary + Candidates + Search Log)
   │
   ▼
  Next research session gets relevant history
```

### Why multi-model?

| Task | Model | Why |
|------|-------|-----|
| Parse user request | Gemini Flash | Simple extraction, 30x cheaper |
| Web search | Serper + Gemini | Precise URLs + broad discovery |
| Read/parse pages | Gemini Flash | 1M token context, handles huge pages |
| Strategy & evaluation | Claude Sonnet | Best reasoning, catches contradictions |

### Memory system

The agent stores research history in `memory.json`:
- **Sessions**: task, criteria, candidates evaluated, search queries used, conclusion
- **Known services**: accumulated facts, verdicts, rejection reasons

Before each new research, the agent receives relevant past context:
- "Provider X was rejected last week because no Argentina routes"
- "Provider Y had pricing at $0.03/SMS as of Jan 15"
- "These 5 search queries were already tried for similar tasks"

This prevents re-searching rejected candidates and builds cumulative knowledge.

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Required keys: ANTHROPIC_API_KEY, GEMINI_API_KEY, SERPER_API_KEY
# For Telegram: + TELEGRAM_BOT_TOKEN, OPENAI_API_KEY (voice)

# Run as Telegram bot
npm run bot

# Or run from CLI (edit src/main.ts with your criteria)
npm run dev
```

### Get API keys

| Key | Where | Cost |
|-----|-------|------|
| Anthropic | [console.anthropic.com](https://console.anthropic.com) | ~$0.15-0.40/research |
| Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier |
| Serper | [serper.dev](https://serper.dev) | 2500 free, then $0.001/search |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | $0.006/min (voice only) |
| Telegram | @BotFather | Free |
| Google Sheets | [console.cloud.google.com](https://console.cloud.google.com/iam-admin/serviceaccounts) | Free (Sheets API) |

## Cost Per Research

### With context compression (default)

Every 5 iterations, conversation history is compressed via Gemini Flash.
Sonnet only sees: system prompt + compressed summary + last 2 exchanges.

```
Gemini (search + extraction + compression): ~$0.002-0.02
Serper (Google searches):                   ~$0.005-0.02
Claude Sonnet (brain):                      ~$0.15-0.40
Whisper (if voice):                         ~$0.01
────────────────────────────────────────────────────────
Total per session:                          ~$0.17-0.45
```

### Without compression (for comparison)

```
Claude Sonnet:  ~$0.80-1.20  ← context grows every iteration
Total:          ~$0.85-1.30
```

**Compression saves 60-70%** of Sonnet costs with minimal quality loss.

The bot shows actual cost after each research: `💰 ~$0.28 (Sonnet)`

20 researches/month = **$3.50-9.00**

## File Structure

```
src/
├── agent.ts           # Orchestration loop (Sonnet ↔ tools)
├── compress.ts        # Context compression (Gemini summarizes history)
├── sheets.ts          # Google Sheets export (3 tabs: Summary, Candidates, Search Log)
├── prompt.ts          # System prompt with memory injection
├── memory.ts          # Persistent JSON memory (sessions + services)
├── parse-request.ts   # NL → criteria via Gemini
├── telegram.ts        # Telegram bot (text + voice)
├── voice.ts           # Whisper transcription
├── types.ts           # TypeScript interfaces
└── tools/
    ├── search.ts      # Serper (precise) + Gemini grounding (broad)
    └── scrape.ts      # Jina fetch + Gemini extraction
```

## Google Sheets Setup

Research results auto-export to a Google Sheet with 3 tabs:
- **Summary** — one row per session (date, task, best match, cost)
- **Candidates** — all evaluated candidates with criteria breakdown
- **Search Log** — every search query made

### Setup (5 minutes):

**1. Create a Google Cloud Service Account:**
- Go to: https://console.cloud.google.com/iam-admin/serviceaccounts
- Create project (or select existing) → "Create Service Account"
- Name it anything (e.g. "research-bot")
- Skip roles → Done
- Click on the created account → "Keys" tab → "Add Key" → "Create new key" → JSON
- Save the downloaded `.json` file as `service-account.json` in the project root

**2. Enable Google Sheets API:**
- Go to: https://console.cloud.google.com/apis/library/sheets.googleapis.com
- Click "Enable"

**3. Create a Google Sheet:**
- Go to https://sheets.google.com → create new spreadsheet
- Copy the ID from the URL: `https://docs.google.com/spreadsheets/d/{THIS_IS_THE_ID}/edit`
- Paste it into `.env` as `GOOGLE_SHEET_ID`

**4. Share the sheet with the service account:**
- Open `service-account.json`, find `"client_email"` (looks like `name@project.iam.gserviceaccount.com`)
- In your Google Sheet → Share → paste that email → give "Editor" access

That's it. The bot will auto-create tabs (Summary, Candidates, Search Log) on first run.

## Telegram Commands

- **Text/voice message** — describe what to find + criteria
- `/memory` — show memory stats (sessions, known services)
- `/stop` — cancel active research

## Tips

1. **Be specific with criteria.** "Price under $0.05 per SMS to Argentina" is much better than "cheap SMS".
2. **Hard vs soft matters.** Too many hard criteria = everything gets rejected. Move "nice to have" to soft.
3. **Memory compounds.** The more you use the agent, the smarter it gets about your domain.
4. **Check the console.** Agent logs every tool call and its reasoning in real-time.
5. **Tweak the prompt.** Edit `src/prompt.ts` if the agent isn't searching in the right places.
