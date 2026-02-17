import dotenv from "dotenv";
dotenv.config({ override: true });

import TelegramBot from "node-telegram-bot-api";
import { runResearchAgent } from "./agent.js";
import { transcribeVoice } from "./voice.js";
import { parseRequest } from "./parse-request.js";
import { getMemoryStats } from "./memory.js";
import fs from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_USERS = process.env.ALLOWED_TELEGRAM_IDS?.split(",").map(Number) || [];

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const activeSessions = new Set<number>();

function isAllowed(userId: number): boolean {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(userId);
}

// --- Commands ---

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from!.id)) return;

  bot.sendMessage(
    msg.chat.id,
    `🔍 *Research Agent*

Отправь текст или голосовое — опиши что нужно найти и по каким критериям.

*Пример:*
_"Найди SMS-провайдера с прямыми маршрутами в Аргентину, цена до $0.05, обязательно REST API, желательно хорошая документация и саппорт"_

Агент разберёт критерии, будет искать по нескольким источникам, заходить на сайты, проверять информацию, и пришлёт результат.

📝 Агент помнит предыдущие исследования и не будет повторять уже проверенные варианты.

/memory — статистика памяти
/stop — остановить текущий поиск`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/memory/, (msg) => {
  if (!isAllowed(msg.from!.id)) return;

  const stats = getMemoryStats();
  let text = `🧠 *Память агента*\n\n`;
  text += `Исследований проведено: ${stats.sessions}\n`;
  text += `Сервисов в базе: ${stats.services}\n`;
  if (stats.lastResearch) {
    text += `Последний поиск: ${new Date(stats.lastResearch).toLocaleString("ru")}`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/stop/, (msg) => {
  if (activeSessions.has(msg.chat.id)) {
    activeSessions.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, "⏹ Поиск остановлен.");
  } else {
    bot.sendMessage(msg.chat.id, "Нет активного поиска.");
  }
});

// --- Voice ---

bot.on("voice", async (msg) => {
  if (!isAllowed(msg.from!.id)) return;
  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, "⏳ Поиск уже идёт. /stop чтобы остановить.");
    return;
  }

  const statusMsg = await bot.sendMessage(msg.chat.id, "🎤 Транскрибирую...");

  try {
    const filePath = await bot.downloadFile(msg.voice!.file_id, "/tmp");
    const text = await transcribeVoice(filePath);

    await bot.editMessageText(`🎤 _"${text}"_\n\n⏳ Разбираю критерии...`, {
      chat_id: msg.chat.id,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown",
    });

    fs.unlinkSync(filePath);
    await handleResearch(msg.chat.id, text, statusMsg.message_id);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ ${error instanceof Error ? error.message : "Ошибка"}`);
  }
});

// --- Text ---

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/") || msg.voice) return;
  if (!isAllowed(msg.from!.id)) return;

  if (activeSessions.has(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, "⏳ Поиск идёт. /stop чтобы остановить.");
    return;
  }

  await handleResearch(msg.chat.id, msg.text);
});

// --- Core ---

async function handleResearch(chatId: number, userText: string, editMsgId?: number) {
  activeSessions.add(chatId);

  try {
    // Parse criteria via Gemini (cheap)
    const statusMsg = editMsgId
      ? { message_id: editMsgId }
      : await bot.sendMessage(chatId, "🧠 Разбираю критерии...");

    const parsed = await parseRequest(userText);

    let criteriaMsg = "📋 *Критерии:*\n\n🔴 *Жёсткие:*\n";
    for (const c of parsed.criteria.hard) {
      criteriaMsg += `• ${c.description}\n`;
    }
    criteriaMsg += "\n🟡 *Мягкие:*\n";
    for (const c of parsed.criteria.soft) {
      criteriaMsg += `• ${c.description} _(вес: ${c.weight}/5)_\n`;
    }

    const stats = getMemoryStats();
    if (stats.sessions > 0) {
      criteriaMsg += `\n🧠 _В памяти ${stats.services} известных сервисов из ${stats.sessions} прошлых исследований_`;
    }

    criteriaMsg += `\n\n🔍 Ищу... _(может занять 2-7 мин)_`;

    await bot.editMessageText(criteriaMsg, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown",
    });

    // Run agent
    const result = await runResearchAgent(parsed.task, parsed.criteria);

    if (!activeSessions.has(chatId)) return;

    // Send results
    const chunks = splitMessage(result.answer, 4000);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }).catch(() => {
        // Retry without markdown if parsing fails
        bot.sendMessage(chatId, chunk, { disable_web_page_preview: true });
      });
    }

    let summary = `✅ Готово\n📊 ${result.iterations} итераций, ${result.toolCalls} запросов, ${result.candidatesEvaluated} кандидатов\n💾 Сохранено в память`;
    if (result.cost) {
      summary += `\n💰 ~$${result.cost.estimatedUsd.toFixed(3)} (Sonnet)`;
    }
    if (result.sheetUrl) {
      summary += `\n📋 [Google Sheets](${result.sheetUrl})`;
    }

    await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });
  } catch (error) {
    await bot.sendMessage(chatId, `❌ ${error instanceof Error ? error.message : "Ошибка"}`);
  } finally {
    activeSessions.delete(chatId);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) { chunks.push(rest); break; }
    let split = rest.lastIndexOf("\n\n", maxLen);
    if (split < maxLen * 0.3) split = rest.lastIndexOf("\n", maxLen);
    if (split < maxLen * 0.3) split = maxLen;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split).trimStart();
  }
  return chunks;
}

console.log("🤖 Research bot started. Waiting for messages...");
