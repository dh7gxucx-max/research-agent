import fs from "fs";
import path from "path";

export async function transcribeVoice(filePath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBuffer], { type: "audio/ogg" }),
    path.basename(filePath)
  );
  formData.append("model", "whisper-1");
  formData.append("language", "ru");
  formData.append("response_format", "text");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Whisper error ${response.status}: ${await response.text()}`);
  }

  return (await response.text()).trim();
}
