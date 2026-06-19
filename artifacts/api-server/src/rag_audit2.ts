import { db } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { sql } from "drizzle-orm";

const QUESTIONS = [
  "What should I do if the kettle switches on but doesn't boil, even though the power neon is lit?",
  "How long should I wait before the kettle resets after the boil-dry protection has triggered?",
  "What is the minimum amount of water required before switching the kettle on?",
  "How often should I descale the kettle if I'm in a hard water area (above 201mg/l CaCO3)?",
  "What are the step-by-step instructions for removing and cleaning the water filter?",
  "The kettle is sputtering water out of the spout — what are the possible causes and what should I do first?",
  "What should I do if water gets down the steam tube during filling?",
  "Why might the kettle fail to switch off automatically after boiling, and how do I fix it?",
  "What descaler does the manufacturer recommend, and where can I buy it?",
  "After descaling, what steps must I complete before the kettle is safe to use again?",
  "What is the maximum angle the kettle can be tilted when filling?",
  "The lid feels too loose — what does the manual say I should do about it?",
  "Brown spots have appeared inside the kettle body — is this a defect and what action should I take?",
  "I can see water droplets on top of the power base — is this a fault?",
  "What safety steps must I take before cleaning the kettle?",
  "How do I close the lid if the knob is too hot to touch safely after boiling?",
  "What are the conditions that will invalidate the guarantee on this kettle?",
  "What should I do if the power cord is damaged?",
  "How far away from the lid or spout should you stand when the kettle is heating, to avoid scalding?",
  "The kettle leaks from the lid — what is the likely cause and where do I get replacement parts?",
];

const SYSTEM_PROMPT = `You are an expert engineering assistant. Answer the question clearly and precisely using ONLY the information from the provided manual excerpts.

CRITICAL RULES:
1. Never fabricate technical details. If information is absent from all provided excerpts, say so explicitly.
2. Verbatim values — this is absolute: for any specific value (number, measurement, angle, distance, duration, temperature, product name, part number, model code, catalogue code, phone number, URL, or proper noun) you MUST copy it character-for-character from the excerpt text above. Do NOT paraphrase it, round it, convert its units, or recall it from memory. If the exact value does not appear literally in one of the Source excerpts, write "The manual does not specify this" — never substitute a plausible-sounding figure. This rule exists because engineers act on these values and a wrong number causes real harm.

OUTPUT FORMAT — respond with valid JSON only:
{"answer": "your plain-text answer here", "sources": [1, 2]}`;

type ChunkRow = { content: string; page_number: number };

async function ask(question: string) {
  const terms = question.replace(/[^a-zA-Z0-9 ]/g, " ").trim()
    .split(/\s+/).filter((w) => w.length >= 3).slice(0, 20);
  const tsQuery = terms.join(" | ");

  let rows: ChunkRow[] = [];
  try {
    const r = await db.execute<ChunkRow>(sql`
      SELECT content, page_number,
             ts_rank(fts_vector, to_tsquery('english', ${tsQuery})) AS rank
      FROM chunks WHERE manual_id = 13
        AND fts_vector @@ to_tsquery('english', ${tsQuery})
      ORDER BY rank DESC LIMIT 10
    `);
    rows = r.rows as ChunkRow[];
  } catch {}
  if (rows.length === 0) {
    const fb = await db.execute<ChunkRow>(sql`SELECT content, page_number FROM chunks WHERE manual_id = 13 ORDER BY page_number, id LIMIT 8`);
    rows = fb.rows as ChunkRow[];
  }

  const context = rows.map((r, i) => `[Source ${i+1}: page ${r.page_number}]\n${r.content}`).join("\n\n---\n\n");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Manual excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}` },
    ],
    response_format: { type: "json_object" },
    max_tokens: 300,
    temperature: 0,
  });

  let answer = "(no response)";
  try {
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as { answer?: string };
    answer = parsed.answer ?? "(empty)";
  } catch {}
  const pages = [...new Set(rows.map((r) => r.page_number))].sort((a, b) => a - b);
  return { answer, pages };
}

for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i];
  process.stdout.write(`\nQ${String(i+1).padStart(2)}: ${q}\n`);
  try {
    const { answer, pages } = await ask(q);
    process.stdout.write(`     [pages: ${pages.join(", ")}]\n`);
    process.stdout.write(`A:   ${answer}\n`);
  } catch (e: any) {
    process.stdout.write(`ERR: ${e.message}\n`);
  }
}
process.exit(0);
