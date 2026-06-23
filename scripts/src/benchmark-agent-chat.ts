/**
 * Developer-only benchmark harness for diagram-heavy agentChat questions.
 *
 * Usage:
 *   AGENT_CHAT_URL=http://localhost:8080/api/chat/agent \
 *   OPENAI_API_KEY=... \
 *   pnpm --filter @workspace/scripts run benchmark:agent-chat
 *
 * Optional:
 *   BENCHMARK_MANUAL_PATTERN="P2-049|PP2 049"
 *   BENCHMARK_MANUAL_ID=123
 *   BENCHMARK_SESSION_PREFIX="bench-p2-049"
 */

import { db, manualsTable } from "@workspace/db";
import { ilike, or } from "drizzle-orm";

type BenchmarkQuestion = {
  id: string;
  question: string;
  expectedMode: "exact" | "partial" | "guided";
};

type AgentChatResponse = {
  answer: string;
  confidence?: string;
  answerability?: string;
  citations?: Array<{
    manualName?: string;
    pageNumber?: number;
    pageContext?: string;
  }>;
  isGuided?: boolean;
  domain?: string;
  evidenceSummary?: {
    manualsSearched?: string[];
    chunksFound?: number;
  };
};

const QUESTIONS: BenchmarkQuestion[] = [
  {
    id: "Q1",
    question: "What type of motor drives the feeder unit, and what is its rated power?",
    expectedMode: "exact",
  },
  {
    id: "Q2",
    question: "What is the function of relay RL1 in the feeder unit control circuit, and what conditions cause it to energise?",
    expectedMode: "partial",
  },
  {
    id: "Q3",
    question: "The feeder unit has stopped feeding sheets and the HMI shows no fault. List the electrical components you would check first and in what order.",
    expectedMode: "partial",
  },
  {
    id: "Q4",
    question: "Which PLC input address receives the signal from the sheet separation sensor on the feeder unit?",
    expectedMode: "exact",
  },
  {
    id: "Q5",
    question: "What voltage is the feeder unit control circuit operating at?",
    expectedMode: "exact",
  },
  {
    id: "Q6",
    question: "How many solenoid valves are controlled from the feeder unit, and what is the supply voltage to each?",
    expectedMode: "exact",
  },
  {
    id: "Q7",
    question: "The vacuum fan motor overload has tripped. What is the overload relay reference designation and what is its trip current setting?",
    expectedMode: "exact",
  },
  {
    id: "Q8",
    question: "Describe the E-stop circuit path through the feeder unit. What happens to the feeder drive contactor when E-stop is pressed?",
    expectedMode: "partial",
  },
  {
    id: "Q9",
    question: "What is the terminal block reference where the feeder unit interconnecting cable terminates, and how many cores does the cable have?",
    expectedMode: "exact",
  },
  {
    id: "Q10",
    question: "Which indicator lamp shows that the feeder unit is in the ready state, and what PLC output energises it?",
    expectedMode: "exact",
  },
];

function classifyObservedMode(result: AgentChatResponse): "exact" | "partial" | "guided" {
  if (result.isGuided) return "guided";
  if (result.answerability === "answerable" && result.confidence === "high") return "exact";
  if (result.answerability === "not_answerable") return "guided";
  return "partial";
}

async function resolveManualId(): Promise<number | null> {
  const explicitId = Number(process.env.BENCHMARK_MANUAL_ID ?? "");
  if (Number.isInteger(explicitId) && explicitId > 0) {
    return explicitId;
  }

  const pattern = process.env.BENCHMARK_MANUAL_PATTERN ?? "P2-049";
  const fragments = pattern
    .split("|")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (fragments.length === 0) return null;

  const clauses = fragments.map((fragment) => ilike(manualsTable.name, `%${fragment}%`));
  const matches = await db
    .select({ id: manualsTable.id, name: manualsTable.name })
    .from(manualsTable)
    .where(clauses.length === 1 ? clauses[0]! : or(...clauses))
    .limit(5);

  if (matches.length === 0) return null;

  if (matches.length > 1) {
    console.log("Matched manuals:");
    for (const match of matches) {
      console.log(`  - [${match.id}] ${match.name}`);
    }
  }

  return matches[0]!.id;
}

async function main() {
  const endpoint = process.env.AGENT_CHAT_URL ?? "http://localhost:8080/api/chat/agent";
  const manualId = await resolveManualId();
  const sessionPrefix = process.env.BENCHMARK_SESSION_PREFIX ?? "bench-p2-049";

  console.log(`Benchmark endpoint: ${endpoint}`);
  console.log(`Scoped manual: ${manualId ?? "none"}`);
  console.log("");

  const results: Array<{
    id: string;
    expectedMode: string;
    observedMode: string;
    confidence?: string;
    answerability?: string;
    citations: string[];
    answer: string;
    manualsSearched: string[];
  }> = [];

  for (const [index, benchmark] of QUESTIONS.entries()) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: benchmark.question,
        domain: "electrical_control",
        strictness: "engineering_strict",
        retrievalMode: "fact_lookup",
        manualId: manualId ?? undefined,
        sessionId: `${sessionPrefix}-${index + 1}`,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`agentChat benchmark failed for ${benchmark.id}: ${response.status} ${body}`);
    }

    const result = (await response.json()) as AgentChatResponse;
    const observedMode = classifyObservedMode(result);
    const citations = (result.citations ?? []).map((citation) => {
      const context = citation.pageContext ? ` (${citation.pageContext})` : "";
      return `${citation.manualName ?? "Unknown manual"} p.${citation.pageNumber ?? "?"}${context}`;
    });

    results.push({
      id: benchmark.id,
      expectedMode: benchmark.expectedMode,
      observedMode,
      confidence: result.confidence,
      answerability: result.answerability,
      citations,
      answer: result.answer.trim(),
      manualsSearched: result.evidenceSummary?.manualsSearched ?? [],
    });
  }

  let scopeViolations = 0;
  if (manualId !== null) {
    for (const result of results) {
      if (result.manualsSearched.length > 1) {
        scopeViolations++;
        console.warn(
          `[${result.id}] manual scope violation: searched ${result.manualsSearched.join(", ")}`
        );
      }
    }
  }

  for (const result of results) {
    console.log(`=== ${result.id} ===`);
    console.log(`expected: ${result.expectedMode}`);
    console.log(`observed: ${result.observedMode}`);
    console.log(`confidence: ${result.confidence ?? "n/a"}`);
    console.log(`answerability: ${result.answerability ?? "n/a"}`);
    if (result.manualsSearched.length > 0) {
      console.log(`manualsSearched: ${result.manualsSearched.join(", ")}`);
    }
    console.log(`citations: ${result.citations.length > 0 ? result.citations.join(" | ") : "none"}`);
    console.log(result.answer);
    console.log("");
  }

  const guidedCount = results.filter((result) => result.observedMode === "guided").length;
  const unexpectedGuided = results.filter(
    (result) => result.observedMode === "guided" && result.expectedMode !== "guided"
  ).length;
  const exactishCount = results.filter((result) => result.observedMode === "exact").length;

  console.log("=== Summary ===");
  console.log(`questions: ${results.length}`);
  console.log(`exact-ish: ${exactishCount}`);
  console.log(`guided: ${guidedCount}`);
  console.log(`unexpected guided: ${unexpectedGuided}`);
  console.log(`manual scope violations: ${scopeViolations}`);

  if (unexpectedGuided > 0 || scopeViolations > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
