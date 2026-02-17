/**
 * Persistent Memory
 *
 * Simple JSON file on disk. Stores:
 * - Past research sessions (task, criteria, candidates, verdicts)
 * - Known services (facts accumulated across sessions)
 *
 * Before each new research, the agent gets:
 * 1. Summary of relevant past sessions (matched by keyword overlap)
 * 2. Known facts about services it's encountered before
 *
 * This prevents:
 * - Re-searching the same providers
 * - Re-discovering the same rejections
 * - Losing hard-won pricing/feature info
 */

import fs from "fs";
import path from "path";
import type {
  MemoryStore,
  ResearchSession,
  CandidateRecord,
} from "./types.js";

const MEMORY_PATH = process.env.MEMORY_PATH || path.join(process.cwd(), "memory.json");

function loadMemory(): MemoryStore {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
      return JSON.parse(raw) as MemoryStore;
    }
  } catch (e) {
    console.error("Failed to load memory, starting fresh:", e);
  }
  return { sessions: [], knownServices: {} };
}

function saveMemory(store: MemoryStore): void {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// --- Public API ---

/**
 * Get relevant memory context for a new research task.
 * Returns a text summary that gets injected into Claude's system prompt.
 */
export function getMemoryContext(task: string, maxSessions: number = 5): string {
  const store = loadMemory();

  if (store.sessions.length === 0 && Object.keys(store.knownServices).length === 0) {
    return "No prior research history.";
  }

  const taskWords = extractKeywords(task);
  let context = "";

  // 1. Find relevant past sessions by keyword overlap
  const scored = store.sessions.map((session) => {
    const sessionWords = extractKeywords(
      session.task + " " + session.conclusion
    );
    const overlap = taskWords.filter((w) => sessionWords.includes(w)).length;
    return { session, score: overlap };
  });

  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSessions);

  if (relevant.length > 0) {
    context += "## RELEVANT PAST RESEARCH\n\n";
    for (const { session } of relevant) {
      context += `### Session: ${session.timestamp.slice(0, 10)}\n`;
      context += `Task: ${session.task}\n`;
      context += `Conclusion: ${session.conclusion}\n`;

      if (session.candidates.length > 0) {
        context += `Candidates evaluated:\n`;
        for (const c of session.candidates) {
          const hardPassed = c.hardResults.filter((r) => r.passed).length;
          const hardTotal = c.hardResults.length;
          context += `  - ${c.name} [${c.verdict.toUpperCase()}] — hard: ${hardPassed}/${hardTotal}`;
          if (c.rejectionReason) context += ` — rejected: ${c.rejectionReason}`;
          context += "\n";
        }
      }

      if (session.searchQueries.length > 0) {
        context += `Queries tried: ${session.searchQueries.slice(0, 8).join(", ")}\n`;
      }
      context += "\n";
    }
  }

  // 2. Known services that might be relevant
  const relevantServices = Object.entries(store.knownServices).filter(
    ([name, info]) => {
      const serviceWords = extractKeywords(
        name + " " + Object.values(info.facts).join(" ") + " " + info.notes.join(" ")
      );
      return taskWords.some((w) => serviceWords.includes(w));
    }
  );

  if (relevantServices.length > 0) {
    context += "## KNOWN SERVICES\n\n";
    for (const [name, info] of relevantServices.slice(0, 15)) {
      context += `**${name}**`;
      if (info.url) context += ` (${info.url})`;
      context += `\n`;
      context += `  Last checked: ${info.lastChecked.slice(0, 10)}\n`;
      if (info.verdict) context += `  Previous verdict: ${info.verdict}\n`;
      for (const [k, v] of Object.entries(info.facts)) {
        context += `  ${k}: ${v}\n`;
      }
      if (info.notes.length > 0) {
        context += `  Notes: ${info.notes.slice(-3).join("; ")}\n`;
      }
      context += "\n";
    }
  }

  return context || "No relevant prior research found for this task.";
}

/**
 * Save a completed research session to memory.
 */
export function saveSession(session: ResearchSession): void {
  const store = loadMemory();
  store.sessions.push(session);

  // Also update knownServices from candidates
  for (const candidate of session.candidates) {
    const key = candidate.name.toLowerCase().trim();
    if (!store.knownServices[key]) {
      store.knownServices[key] = {
        lastChecked: session.timestamp,
        facts: {},
        notes: [],
      };
    }

    const svc = store.knownServices[key];
    svc.lastChecked = session.timestamp;
    if (candidate.url) svc.url = candidate.url;
    svc.verdict = candidate.verdict;

    // Store hard criteria results as facts
    for (const hr of candidate.hardResults) {
      svc.facts[hr.criterion] = `${hr.passed ? "YES" : "NO"} — ${hr.evidence}`;
    }
    // Store soft scores as facts
    for (const sr of candidate.softScores) {
      svc.facts[`soft:${sr.criterion}`] = `${sr.score}/10 — ${sr.reasoning}`;
    }

    if (candidate.rejectionReason) {
      svc.notes.push(`Rejected (${session.timestamp.slice(0, 10)}): ${candidate.rejectionReason}`);
    }
    if (candidate.notes) {
      svc.notes.push(candidate.notes);
    }

    // Keep notes manageable
    if (svc.notes.length > 10) {
      svc.notes = svc.notes.slice(-10);
    }
  }

  // Keep max 50 sessions
  if (store.sessions.length > 50) {
    store.sessions = store.sessions.slice(-50);
  }

  saveMemory(store);
}

/**
 * Record a single candidate evaluation mid-session (for incremental saves).
 */
export function recordCandidate(
  sessionId: string,
  candidate: CandidateRecord
): void {
  const store = loadMemory();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (session) {
    session.candidates.push(candidate);
    saveMemory(store);
  }
}

/**
 * Get full memory stats for /status command.
 */
export function getMemoryStats(): {
  sessions: number;
  services: number;
  lastResearch: string | null;
} {
  const store = loadMemory();
  return {
    sessions: store.sessions.length,
    services: Object.keys(store.knownServices).length,
    lastResearch:
      store.sessions.length > 0
        ? store.sessions[store.sessions.length - 1].timestamp
        : null,
  };
}

// --- Helpers ---

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter(
      (w) =>
        ![
          "that",
          "this",
          "with",
          "from",
          "have",
          "been",
          "will",
          "should",
          "could",
          "would",
          "must",
          "they",
          "their",
          "about",
          "which",
          "there",
          "were",
          "what",
          "when",
          "find",
          "need",
          "search",
          "look",
          "найти",
          "нужно",
          "искать",
          "поиск",
          "должен",
          "может",
          "также",
          "через",
          "более",
          "после",
          "перед",
        ].includes(w)
    );
}
