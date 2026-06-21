import { openai } from "@workspace/integrations-openai-ai-server";

export type TechnicalDomain =
  | "electrical_control"
  | "hydraulic_schematic"
  | "pneumatic_schematic"
  | "mechanical_assembly"
  | "troubleshooting"
  | "generic_process";

export type AnswerStrictness = "normal" | "engineering_strict" | "safety_critical";
export type ValidationStatus = "pass" | "revise" | "fail";
export type AnswerabilityStatus = "answerable" | "partially_answerable" | "not_answerable";
export type ConfidenceLevel = "high" | "medium" | "low" | "unverified";

export interface EvidenceSummary {
  chunksFound: number;
  entitiesFound: number;
  pathsFound: number;
  hasGraphContext: boolean;
  manualsSearched: string[];
}

export interface ValidationSummary {
  status: ValidationStatus;
  presentItems: string[];
  missingItems: string[];
  weakItems: string[];
  unsupportedClaims: string[];
  suggestedGuidance: string[];
}

export interface DomainSpecialistInput {
  question: string;
  draftAnswer: string;
  ragContext: string;
  graphContext: string;
  domain: TechnicalDomain;
  strictness: AnswerStrictness;
  evidence: EvidenceSummary;
  quote: string;
}

export interface DomainSpecialistResult {
  validationStatus: ValidationStatus;
  confidence: ConfidenceLevel;
  answerability: AnswerabilityStatus;
  validationSummary: ValidationSummary;
  revisedAnswer?: string;
}

const DOMAIN_STAGES: Record<TechnicalDomain, { required: string[]; optional: string[] }> = {
  electrical_control: {
    required: ["supply source", "control path", "coil or actuator energised", "load identified"],
    optional: ["return path", "holding or interlock path", "stop/de-energise condition", "protection device"],
  },
  hydraulic_schematic: {
    required: ["fluid source", "control valve state", "flow path to actuator", "actuator response"],
    optional: ["return path", "pressure protection", "relief or failure condition"],
  },
  pneumatic_schematic: {
    required: ["air source", "control valve state", "actuator response"],
    optional: ["return path", "pressure setting", "exhaust path"],
  },
  mechanical_assembly: {
    required: ["parts involved", "sequence of steps"],
    optional: ["fasteners / torque values", "orientation or alignment constraints", "sealing or fitment requirements"],
  },
  troubleshooting: {
    required: ["symptom identified", "first diagnostic check", "corrective action"],
    optional: ["decision branch condition", "safety warning", "resolution / pass criteria"],
  },
  generic_process: {
    required: ["source or input", "process steps in order", "result or output"],
    optional: ["trigger condition", "state change", "stop or reset condition"],
  },
};

const DOMAIN_LABELS: Record<TechnicalDomain, string> = {
  electrical_control: "Electrical control circuit",
  hydraulic_schematic: "Hydraulic schematic",
  pneumatic_schematic: "Pneumatic schematic",
  mechanical_assembly: "Mechanical assembly / disassembly",
  troubleshooting: "Troubleshooting flowchart",
  generic_process: "General process or procedure",
};

export function detectDomain(question: string, ragContext: string): TechnicalDomain {
  const text = (question + " " + ragContext.slice(0, 2000)).toLowerCase();

  const scores: Record<TechnicalDomain, number> = {
    electrical_control: 0,
    hydraulic_schematic: 0,
    pneumatic_schematic: 0,
    mechanical_assembly: 0,
    troubleshooting: 0,
    generic_process: 0,
  };

  const signals: Array<[TechnicalDomain, string[]]> = [
    ["electrical_control", ["wiring", "circuit", "relay", "contactor", "coil", "contact point", "plc", "current", "voltage", "solenoid", "electrical", "schematic", "energise", "energize", "phase", "fuse", "breaker", "motor", "inverter", "vfd", "drive", "amp", "volt", "mcc", "panel", "switchgear"]],
    ["hydraulic_schematic", ["hydraulic", "pump", "hydraulic cylinder", "pressure", "flow rate", "oil", "control valve", "actuator", "reservoir", "piston", "bar pressure", "litre", "fluid", "hydraulic"]],
    ["pneumatic_schematic", ["pneumatic", "compressed air", "air cylinder", "solenoid valve", "compressor", "pressure regulator", "air supply", "exhaust", "pneumatic actuator"]],
    ["mechanical_assembly", ["bolt", "bearing", "gear", "shaft", "assembly", "torque", "clearance", "install", "remove", "disassemble", "fit", "seal", "gasket", "bracket", "fastener", "alignment", "thread", "nut", "screw"]],
    ["troubleshooting", ["fault", "error code", "alarm", "not working", "failure", "symptom", "problem", "diagnose", "troubleshoot", "defect", "warning", "malfunction", "check if", "verify that"]],
  ];

  for (const [domain, keywords] of signals) {
    for (const kw of keywords) {
      if (text.includes(kw)) scores[domain]++;
    }
  }

  let bestDomain: TechnicalDomain = "generic_process";
  let bestScore = 1; // minimum threshold of 2 to override generic
  for (const [domain, score] of Object.entries(scores) as Array<[TechnicalDomain, number]>) {
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

export async function runDomainSpecialist(
  input: DomainSpecialistInput
): Promise<DomainSpecialistResult> {
  const stages = DOMAIN_STAGES[input.domain];
  const hasEvidence = input.evidence.chunksFound > 0 || input.evidence.entitiesFound > 0;
  const hasValidQuote = !!input.quote && input.quote.toUpperCase() !== "NOT IN EXCERPTS";

  const strictnessNote =
    input.strictness === "safety_critical"
      ? "STRICTNESS: SAFETY CRITICAL — reject any unsupported technical claim. Do not allow cautious partial answers when the question involves safe operation, lockout, or shutdown procedures."
      : input.strictness === "engineering_strict"
      ? "STRICTNESS: ENGINEERING STRICT — flag every gap in evidence. Prefer a guided no-answer over an unsupported claim."
      : "STRICTNESS: NORMAL — a cautious partial answer is acceptable when evidence is limited, provided no unsupported specific values are stated.";

  const systemPrompt = `You are a Domain Specialist validating an engineering Q&A answer before it is shown to an engineer.

Your job: check whether the draft answer is technically complete, grounded in the provided source evidence, and safe to share.

Domain: ${DOMAIN_LABELS[input.domain]}
${strictnessNote}

Required coverage for this domain:
${stages.required.map((s) => `  - ${s}`).join("\n")}

Optional (note if absent but do not fail the answer for these alone):
${stages.optional.map((s) => `  - ${s}`).join("\n")}

Evidence available:
  - Text chunks: ${input.evidence.chunksFound}
  - Entities/relationships: ${input.evidence.entitiesFound}
  - Procedural paths: ${input.evidence.pathsFound}
  - Grounding quote present: ${hasValidQuote ? "YES — model found a verbatim source sentence" : "NO — model could not find a verbatim sentence in the excerpts"}

Validation rules:
1. Any specific technical claim (a number, step, path, state, relationship) must appear verbatim or paraphrased from the provided evidence.
2. Strong evidence + all required stages covered → PASS.
3. Partial evidence or some required stages missing → REVISE with specific instructions. Provide a revised answer in revised_answer.
4. No supporting evidence, "NOT IN EXCERPTS" quote, or answer directly contradicts evidence → FAIL.
5. Do not fail solely because optional stages are absent.
6. If the draft answer says "the manual does not specify this" and evidence is truly empty → PASS (that is the correct answer).

Respond with valid JSON only, no other text:
{
  "validation_status": "pass" | "revise" | "fail",
  "answerability": "answerable" | "partially_answerable" | "not_answerable",
  "present_items": ["required stages that are covered"],
  "missing_items": ["required stages that are missing"],
  "weak_items": ["items present but poorly supported"],
  "unsupported_claims": ["specific claims not backed by evidence"],
  "revision_instructions": ["concrete instructions — only if revise"],
  "revised_answer": "improved answer text — only if revise, otherwise null",
  "suggested_guidance": ["helpful suggestions for the user if evidence is weak or missing"],
  "confidence_score": 0.0
}`;

  const userPrompt = `QUESTION: ${input.question}

DRAFT ANSWER:
${input.draftAnswer}

SOURCE EVIDENCE (excerpts the answer was drawn from):
${input.ragContext.slice(0, 3000)}
${input.graphContext ? `\nGRAPH CONTEXT:\n${input.graphContext.slice(0, 1000)}` : ""}

Validate the draft answer.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 900,
      temperature: 0,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      validation_status?: string;
      answerability?: string;
      present_items?: string[];
      missing_items?: string[];
      weak_items?: string[];
      unsupported_claims?: string[];
      revision_instructions?: string[];
      revised_answer?: string | null;
      suggested_guidance?: string[];
      confidence_score?: number;
    };

    const status = (["pass", "revise", "fail"].includes(parsed.validation_status ?? "")
      ? parsed.validation_status!
      : "pass") as ValidationStatus;

    const score = typeof parsed.confidence_score === "number" ? parsed.confidence_score : 0.5;

    const answerability = (["answerable", "partially_answerable", "not_answerable"].includes(parsed.answerability ?? "")
      ? parsed.answerability!
      : "partially_answerable") as AnswerabilityStatus;

    let confidence: ConfidenceLevel;
    if (!hasEvidence) {
      confidence = "unverified";
    } else if (score >= 0.85 && status === "pass") {
      confidence = "high";
    } else if (score >= 0.6) {
      confidence = "medium";
    } else if (score >= 0.4) {
      confidence = "low";
    } else {
      confidence = "unverified";
    }

    return {
      validationStatus: status,
      confidence,
      answerability,
      validationSummary: {
        status,
        presentItems: parsed.present_items ?? [],
        missingItems: parsed.missing_items ?? [],
        weakItems: parsed.weak_items ?? [],
        unsupportedClaims: parsed.unsupported_claims ?? [],
        suggestedGuidance: parsed.suggested_guidance ?? [],
      },
      revisedAnswer: parsed.revised_answer ?? undefined,
    };
  } catch {
    return {
      validationStatus: "pass",
      confidence: hasEvidence ? "medium" : "unverified",
      answerability: hasEvidence ? "partially_answerable" : "not_answerable",
      validationSummary: {
        status: "pass",
        presentItems: [],
        missingItems: [],
        weakItems: [],
        unsupportedClaims: [],
        suggestedGuidance: [],
      },
    };
  }
}

export function buildGuidedNoAnswer(
  question: string,
  evidence: EvidenceSummary,
  validationSummary: ValidationSummary
): string {
  const manualsLine =
    evidence.manualsSearched.length > 0
      ? evidence.manualsSearched.join(", ")
      : "all available manuals";

  const checkedLines = [
    `- ${evidence.chunksFound} text chunk${evidence.chunksFound !== 1 ? "s" : ""} from ${manualsLine}`,
  ];
  if (evidence.entitiesFound > 0) {
    checkedLines.push(`- ${evidence.entitiesFound} entity/relationship record${evidence.entitiesFound !== 1 ? "s" : ""} from the knowledge graph`);
  }
  if (evidence.pathsFound > 0) {
    checkedLines.push(`- ${evidence.pathsFound} procedural path${evidence.pathsFound !== 1 ? "s" : ""}`);
  }

  const missingLines =
    validationSummary.missingItems.length > 0
      ? validationSummary.missingItems.map((m) => `- ${m}`).join("\n")
      : "- The manual pages covering this topic may not have been ingested, or the question may need more specific terminology.";

  const guidanceLines =
    validationSummary.suggestedGuidance.length > 0
      ? validationSummary.suggestedGuidance.map((g) => `- ${g}`).join("\n")
      : `- Use a specific component name, tag number, or diagram label\n- Select a specific manual if you know which one covers this\n- Ask about one step of the process at a time`;

  return `I could not confirm this from the available manual data.

What I checked:
${checkedLines.join("\n")}

What is missing:
${missingLines}

You could try:
${guidanceLines}`;
}
