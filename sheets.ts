/**
 * Google Sheets Export
 *
 * After each research session, exports structured results to a Google Sheet:
 *
 * Sheet structure:
 * ┌─────────────────────────────────────────────────────┐
 * │ Tab: "Summary"                                       │
 * │  Date | Task | Best Match | Candidates | Cost        │
 * ├─────────────────────────────────────────────────────┤
 * │ Tab: "Candidates"                                    │
 * │  Name | URL | Verdict | Hard1 | Hard2 | ... | Soft1  │
 * ├─────────────────────────────────────────────────────┤
 * │ Tab: "Search Log"                                    │
 * │  # | Query | Type                                    │
 * └─────────────────────────────────────────────────────┘
 *
 * Auth: Google Service Account (JSON key file)
 * Setup: see README
 */

import { google, sheets_v4 } from "googleapis";
import fs from "fs";
import type {
  ResearchSession,
  ResearchCriteria,
  CandidateRecord,
} from "./types.js";

// --- Auth ---

function getAuth() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyPath) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set in .env");
  }

  let credentials: { client_email: string; private_key: string };

  // Support both file path and inline JSON
  if (keyPath.startsWith("{")) {
    credentials = JSON.parse(keyPath);
  } else {
    credentials = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient(): sheets_v4.Sheets {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

// --- Main Export ---

export async function exportToSheets(
  session: ResearchSession,
  cost?: { inputTokens: number; outputTokens: number; estimatedUsd: number }
): Promise<string> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.log("  ⚠️ GOOGLE_SHEET_ID not set, skipping sheets export");
    return "";
  }

  const sheets = getSheetsClient();

  try {
    // Ensure tabs exist
    await ensureTabs(sheets, spreadsheetId);

    // 1. Write to Summary tab
    await appendSummary(sheets, spreadsheetId, session, cost);

    // 2. Write to Candidates tab
    await appendCandidates(sheets, spreadsheetId, session);

    // 3. Write to Search Log tab
    await appendSearchLog(sheets, spreadsheetId, session);

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`  📊 Exported to Google Sheets: ${url}`);
    return url;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ Sheets export failed: ${msg}`);
    return "";
  }
}

// --- Tab Management ---

async function ensureTabs(sheets: sheets_v4.Sheets, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTabs = meta.data.sheets?.map((s) => s.properties?.title) || [];

  const requiredTabs = ["Summary", "Candidates", "Search Log"];
  const missing = requiredTabs.filter((t) => !existingTabs.includes(t));

  if (missing.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    });

    // Add headers
    const headers: Record<string, string[][]> = {
      Summary: [
        [
          "Date",
          "Task",
          "Best Match",
          "Candidates Checked",
          "Iterations",
          "Sonnet Cost ($)",
          "Conclusion",
        ],
      ],
      Candidates: [
        [
          "Date",
          "Session Task",
          "Name",
          "URL",
          "Verdict",
          "Rejection Reason",
          "Hard Criteria (details)",
          "Hard Pass Count",
          "Hard Total",
          "Soft Avg Score",
          "Soft Criteria (details)",
          "Notes",
        ],
      ],
      "Search Log": [["Date", "Session Task", "#", "Query Type", "Query"]],
    };

    for (const tab of missing) {
      if (headers[tab]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tab}'!A1`,
          valueInputOption: "RAW",
          requestBody: { values: headers[tab] },
        });
      }
    }
  }
}

// --- Write Summary ---

async function appendSummary(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  session: ResearchSession,
  cost?: { inputTokens: number; outputTokens: number; estimatedUsd: number }
) {
  const date = new Date(session.timestamp).toLocaleString("ru-RU");
  const row = [
    date,
    session.task.slice(0, 300),
    session.bestMatch || "—",
    session.candidates.length.toString(),
    session.searchQueries.length.toString(),
    cost ? `$${cost.estimatedUsd.toFixed(3)}` : "—",
    session.conclusion.slice(0, 500),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "'Summary'!A:G",
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

// --- Write Candidates ---

async function appendCandidates(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  session: ResearchSession
) {
  if (session.candidates.length === 0) return;

  const date = new Date(session.timestamp).toLocaleString("ru-RU");
  const rows: string[][] = [];

  for (const c of session.candidates) {
    const hardPassed = c.hardResults.filter((r) => r.passed).length;
    const hardTotal = c.hardResults.length;

    // Format hard criteria as readable text
    const hardDetails = c.hardResults
      .map((r) => `${r.passed ? "✅" : "❌"} ${r.criterion}: ${r.evidence}`)
      .join("\n");

    // Format soft criteria
    const softDetails = c.softScores
      .map((s) => `${s.score}/10 ${s.criterion}: ${s.reasoning}`)
      .join("\n");

    const softAvg =
      c.softScores.length > 0
        ? (
            c.softScores.reduce((sum, s) => sum + s.score, 0) /
            c.softScores.length
          ).toFixed(1)
        : "—";

    rows.push([
      date,
      session.task.slice(0, 150),
      c.name,
      c.url || "—",
      c.verdict.toUpperCase(),
      c.rejectionReason || "—",
      hardDetails,
      hardPassed.toString(),
      hardTotal.toString(),
      softAvg,
      softDetails,
      c.notes || "—",
    ]);
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "'Candidates'!A:L",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

// --- Write Search Log ---

async function appendSearchLog(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  session: ResearchSession
) {
  if (session.searchQueries.length === 0) return;

  const date = new Date(session.timestamp).toLocaleString("ru-RU");
  const rows: string[][] = [];

  session.searchQueries.forEach((q, i) => {
    const isDiscover = q.startsWith("[discover]");
    rows.push([
      date,
      session.task.slice(0, 150),
      (i + 1).toString(),
      isDiscover ? "Discover (Gemini)" : "Google (Serper)",
      isDiscover ? q.replace("[discover] ", "") : q,
    ]);
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "'Search Log'!A:E",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}
