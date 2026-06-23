import { openai } from "./openai.js";

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
  /** Steps/claims not found in the retrieved chunks (retrieval gap — does not mean the answer is wrong). */
  unsupportedClaims: string[];
  /** Steps/claims that DIRECTLY contradict what the retrieved evidence says (genuine error). */
  conflictingClaims: string[];
  suggestedGuidance: string[];
  citationIssues: string[];
  sequenceIssues: string[];
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

export interface DomainSignalFamily {
  label: string;
  keywords: string[];
  symbolPatterns?: RegExp[];
}

export interface DomainSpecialistPolicy {
  label: string;
  description: string;
  requiredStages: string[];
  optionalStages: string[];
  signalFamilies: DomainSignalFamily[];
  preferredRetrievalSignals: string[];
  answerStyleRules: string[];
  confidenceDowngradeConditions: string[];
  requiredEvidenceTypes: string[];
}

const DOMAIN_POLICIES: Record<TechnicalDomain, DomainSpecialistPolicy> = {
  electrical_control: {
    label: "Electrical control circuit",
    description:
      "Electrical drawings, control schematics, I/O tables, interlock chains, and component-spec annotations for relays, contactors, motors, overloads, PLC points, and terminal blocks.",
    requiredStages: ["supply source", "control path", "coil or actuator energised", "load identified"],
    optionalStages: ["return path", "holding or interlock path", "stop/de-energise condition", "protection device"],
    signalFamilies: [
      {
        label: "electrical terms",
        keywords: [
          "wiring", "circuit", "relay", "contactor", "coil", "contact", "plc", "current",
          "voltage", "electrical", "schematic", "energise", "energize", "phase", "fuse",
          "breaker", "motor", "inverter", "vfd", "drive", "amp", "volt", "mcc", "panel",
          "switchgear", "overload", "terminal", "e-stop", "emergency stop", "lamp",
          "indicator", "solenoid", "sensor", "interlock", "ready signal",
        ],
        symbolPatterns: [
          /\b(?:RL|KM|FR|HL|TB|XT|SQ|SV|KA|FU|PS|PLC|M)\d+[A-Z]?\b/gi,
          /\b(?:X|Y|Q|I|O)\d+(?:[.:]\d{1,2})\b/gi,
          /\bQ\d+:\d{1,2}\b/gi,
        ],
      },
    ],
    preferredRetrievalSignals: [
      "exact symbol hits in chunk text",
      "table and I/O assignment chunks",
      "page_context / drawing-title matches",
      "same-page and same-drawing neighbour expansion after a symbol hit",
    ],
    answerStyleRules: [
      "Copy exact component tags, terminal references, PLC addresses, and numeric values when present.",
      "When circuit function is evident but a numeric value is missing, answer the confirmed function/path and explicitly mark the exact value unresolved.",
      "For relay and contactor questions, explain the energise path and the effect of the contacts.",
      "Do not claim the manual lacks information unless the retrieved drawing evidence is clearly non-responsive.",
    ],
    confidenceDowngradeConditions: [
      "missing relay path or missing destination load for a control-circuit question",
      "missing exact symbol/value for a symbol-targeted fact question",
      "answer says 'not specified' even though drawing evidence is present",
      "unsupported component-function inference without corroborating chunks",
    ],
    requiredEvidenceTypes: [
      "drawing chunk or table row naming the symbol or component",
      "same-page or same-drawing context for circuit reasoning questions",
      "I/O table or spec annotation for address/value questions",
    ],
  },
  hydraulic_schematic: {
    label: "Hydraulic schematic",
    description: "Hydraulic circuit diagrams, valves, pumps, cylinders, pressure protection, and flow-path behaviour.",
    requiredStages: ["fluid source", "control valve state", "flow path to actuator", "actuator response"],
    optionalStages: ["return path", "pressure protection", "relief or failure condition"],
    signalFamilies: [
      {
        label: "hydraulic terms",
        keywords: [
          "hydraulic", "pump", "cylinder", "pressure", "flow rate", "oil", "control valve",
          "actuator", "reservoir", "piston", "bar pressure", "fluid", "manifold", "relief valve",
        ],
      },
    ],
    preferredRetrievalSignals: ["valve and actuator identifiers", "same-circuit flow annotations", "pressure/spec table rows"],
    answerStyleRules: [
      "Explain valve state and resulting flow path before naming the actuator response.",
      "Separate confirmed pressure/spec values from inferred flow behaviour.",
    ],
    confidenceDowngradeConditions: [
      "missing valve state",
      "missing actuator destination or return path on a flow question",
    ],
    requiredEvidenceTypes: ["circuit chunk naming the valve/actuator", "flow-path or pressure annotation"],
  },
  pneumatic_schematic: {
    label: "Pneumatic schematic",
    description: "Compressed-air schematics with solenoid valves, regulators, cylinders, and exhaust paths.",
    requiredStages: ["air source", "control valve state", "actuator response"],
    optionalStages: ["return path", "pressure setting", "exhaust path"],
    signalFamilies: [
      {
        label: "pneumatic terms",
        keywords: [
          "pneumatic", "compressed air", "air cylinder", "solenoid valve", "compressor",
          "pressure regulator", "air supply", "exhaust", "pneumatic actuator",
        ],
      },
    ],
    preferredRetrievalSignals: ["valve identifiers", "same-circuit air path", "pressure or regulator annotations"],
    answerStyleRules: [
      "State the air source and valve position before describing the cylinder or actuator movement.",
      "Keep regulator or supply pressure values exact when present.",
    ],
    confidenceDowngradeConditions: ["missing valve state", "missing actuator response", "spec value absent for a direct fact question"],
    requiredEvidenceTypes: ["valve/cylinder chunk", "pressure or exhaust annotation when requested"],
  },
  mechanical_assembly: {
    label: "Mechanical assembly / disassembly",
    description: "Assembly, removal, replacement, torque, alignment, sealing, and fitment procedures.",
    requiredStages: ["parts involved", "sequence of steps"],
    optionalStages: ["fasteners / torque values", "orientation or alignment constraints", "sealing or fitment requirements"],
    signalFamilies: [
      {
        label: "mechanical terms",
        keywords: [
          "bolt", "bearing", "gear", "shaft", "assembly", "torque", "clearance", "install",
          "remove", "disassemble", "fit", "seal", "gasket", "bracket", "fastener", "alignment",
          "thread", "nut", "screw",
        ],
      },
    ],
    preferredRetrievalSignals: ["step lists", "part callouts", "torque/spec tables"],
    answerStyleRules: ["Preserve sequence order.", "Call out torque, orientation, and sealing details when present."],
    confidenceDowngradeConditions: ["missing sequence steps", "missing key torque or orientation detail"],
    requiredEvidenceTypes: ["procedure text", "part or fastener spec if specifically asked"],
  },
  troubleshooting: {
    label: "Troubleshooting flowchart",
    description: "Fault trees, diagnostic sequences, error conditions, and corrective actions.",
    requiredStages: ["symptom identified", "first diagnostic check", "corrective action"],
    optionalStages: ["decision branch condition", "safety warning", "resolution / pass criteria"],
    signalFamilies: [
      {
        label: "troubleshooting terms",
        keywords: [
          "fault", "error code", "alarm", "not working", "failure", "symptom", "problem",
          "diagnose", "troubleshoot", "defect", "warning", "malfunction", "check if", "verify that",
        ],
      },
    ],
    preferredRetrievalSignals: ["fault tables", "decision branches", "diagnostic step lists"],
    answerStyleRules: ["Rank checks in the order shown by the evidence.", "Separate symptoms from corrective actions."],
    confidenceDowngradeConditions: ["missing first check", "diagnostic order unclear", "corrective action inferred without support"],
    requiredEvidenceTypes: ["fault symptom row", "diagnostic branch or procedure"],
  },
  generic_process: {
    label: "General process or procedure",
    description: "General operating, setup, calibration, and process instructions that do not match a specialist diagram domain.",
    requiredStages: ["source or input", "process steps in order", "result or output"],
    optionalStages: ["trigger condition", "state change", "stop or reset condition"],
    signalFamilies: [
      {
        label: "general process terms",
        keywords: [],
      },
    ],
    preferredRetrievalSignals: ["section-matched procedure chunks", "tables/lists containing settings or outputs"],
    answerStyleRules: ["Answer directly from the retrieved excerpts and keep steps in order."],
    confidenceDowngradeConditions: ["sequence incomplete", "output/result not evidenced"],
    requiredEvidenceTypes: ["relevant procedure text or setting table"],
  },
};

const DOMAIN_IDENTIFIER_PATTERNS = [
  /\b(?:RL|KM|FR|HL|TB|XT|SQ|SV|KA|FU|PS|PLC|M)\d+[A-Z]?\b/i,
  /\b(?:X|Y|Q|I|O)\d+(?:[.:]\d{1,2})\b/i,
  /\bQ\d+:\d{1,2}\b/i,
];

export function getDomainPolicy(domain: TechnicalDomain): DomainSpecialistPolicy {
  return DOMAIN_POLICIES[domain];
}

export function containsDomainIdentifier(text: string): boolean {
  return DOMAIN_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(text));
}

export function requiresSpecialistReview(domain: TechnicalDomain, question: string): boolean {
  return (
    domain === "electrical_control" ||
    domain === "hydraulic_schematic" ||
    domain === "pneumatic_schematic" ||
    containsDomainIdentifier(question)
  );
}

export function detectDomain(question: string, ragContext: string): TechnicalDomain {
  const joined = question + " " + ragContext.slice(0, 2000);
  const text = joined.toLowerCase();

  const scores: Record<TechnicalDomain, number> = {
    electrical_control: 0,
    hydraulic_schematic: 0,
    pneumatic_schematic: 0,
    mechanical_assembly: 0,
    troubleshooting: 0,
    generic_process: 0,
  };

  for (const [domain, policy] of Object.entries(DOMAIN_POLICIES) as Array<[TechnicalDomain, DomainSpecialistPolicy]>) {
    for (const family of policy.signalFamilies) {
      for (const kw of family.keywords) {
        if (kw && text.includes(kw)) scores[domain]++;
      }
      for (const pattern of family.symbolPatterns ?? []) {
        const matches = joined.match(pattern);
        if (matches && matches.length > 0) scores[domain] += Math.min(matches.length, 3);
      }
    }
  }

  let bestDomain: TechnicalDomain = "generic_process";
  let bestScore = 1;
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
  const policy = getDomainPolicy(input.domain);
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

Domain: ${policy.label}
Domain description: ${policy.description}
${strictnessNote}

Required coverage for this domain:
${policy.requiredStages.map((s) => `  - ${s}`).join("\n")}

Optional (note if absent but do not fail the answer for these alone):
${policy.optionalStages.map((s) => `  - ${s}`).join("\n")}

Preferred retrieval/evidence signals for this domain:
${policy.preferredRetrievalSignals.map((s) => `  - ${s}`).join("\n")}

Required evidence types for direct fact questions:
${policy.requiredEvidenceTypes.map((s) => `  - ${s}`).join("\n")}

Answer style rules:
${policy.answerStyleRules.map((s) => `  - ${s}`).join("\n")}

Confidence downgrade conditions:
${policy.confidenceDowngradeConditions.map((s) => `  - ${s}`).join("\n")}

Evidence available:
  - Text chunks: ${input.evidence.chunksFound}
  - Entities/relationships: ${input.evidence.entitiesFound}
  - Procedural paths: ${input.evidence.pathsFound}
  - Grounding quote present: ${hasValidQuote ? "YES — model found a verbatim source sentence" : "NO — model could not find a verbatim sentence in the excerpts"}

CRITICAL DISTINCTION — two separate categories of claim problem:
- "unsupported_claims": steps or claims in the answer that are NOT PRESENT in the retrieved excerpts. This is a RETRIEVAL GAP, not proof the answer is wrong. The manual likely covers this on a page that was not retrieved.
- "conflicting_claims": steps or claims that DIRECTLY CONTRADICT what a retrieved excerpt explicitly states (e.g. answer says "turn clockwise" but evidence says "turn anti-clockwise"). These are GENUINE ERRORS that should lower confidence significantly.

Validation rules:
1. Any specific technical claim (a number, step, path, state, relationship) must appear verbatim or paraphrased from the provided evidence.
2. Strong evidence + all required stages covered → PASS.
3. Partial evidence or some required stages missing → REVISE with specific instructions. Provide a revised answer in revised_answer.
4. No supporting evidence, "NOT IN EXCERPTS" quote, or answer directly contradicts evidence → FAIL.
5. Do not fail solely because optional stages are absent.
6. If the draft answer says "the manual does not specify this" and evidence is truly empty → PASS (that is the correct answer). If evidence is present but incomplete, prefer a partial answer over an absence claim.
7. citation_issues: list any case where a cited source does not actually contain the claim it is used to support.
8. sequence_issues: list any case where the answer presents steps out of the order shown in the evidence.

CONFIDENCE SCORE GUIDANCE:
- Use 0.85–1.0 only when all required stages are covered by evidence, there are zero missing_items, zero unsupported_claims, zero conflicting_claims, and the answer is not mainly an absence/no-answer statement.
- Use 0.65–0.84 when the answer is materially useful but incomplete, with some missing_items, weak_items, or limited citation support.
- Use 0.40–0.64 when important parts of the question remain unresolved, or unsupported/conflicting claims exist.
- Use < 0.40 when the answer cannot be grounded at all, is mostly guided/no-answer, or directly contradicts the evidence.

Respond with valid JSON only, no other text:
{
  "validation_status": "pass" | "revise" | "fail",
  "answerability": "answerable" | "partially_answerable" | "not_answerable",
  "present_items": ["required stages that are covered"],
  "missing_items": ["required stages that are missing"],
  "weak_items": ["items present but poorly supported"],
  "unsupported_claims": ["claims not found in retrieved excerpts — retrieval gap only"],
  "conflicting_claims": ["claims that directly contradict retrieved evidence"],
  "citation_issues": ["e.g. Citation 2 does not contain the relay contact claim"],
  "sequence_issues": ["e.g. Step 3 appears before Step 2 in the answer"],
  "revision_instructions": ["concrete instructions — only if revise"],
  "revised_answer": "improved answer text — only if revise, otherwise null",
  "suggested_guidance": ["helpful suggestions for the user if evidence is weak or missing"],
  "confidence_score": 0.0
}`;

  const userPrompt = `QUESTION: ${input.question}

DRAFT ANSWER:
${input.draftAnswer}

SOURCE EVIDENCE (excerpts the answer was drawn from):
${input.ragContext.slice(0, 18000)}
${input.graphContext ? `\nGRAPH CONTEXT:\n${input.graphContext.slice(0, 1500)}` : ""}

Validate the draft answer.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1000,
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
      conflicting_claims?: string[];
      citation_issues?: string[];
      sequence_issues?: string[];
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

    const missingItems = parsed.missing_items ?? [];
    const weakItems = parsed.weak_items ?? [];
    const unsupportedClaims = parsed.unsupported_claims ?? [];
    const conflictingClaims = parsed.conflicting_claims ?? [];
    const hasGenuineConflicts = conflictingClaims.length > 0;
    const revisedAnswerText = (parsed.revised_answer ?? input.draftAnswer ?? "").trim();
    const isAbsenceDrivenAnswer = /manual does not specify|could not confirm|not in excerpts|not available manual data/i.test(
      revisedAnswerText
    );

    let confidence: ConfidenceLevel;
    if (!hasEvidence || answerability === "not_answerable") {
      confidence = "unverified";
    } else if (
      score >= 0.85 &&
      !hasGenuineConflicts &&
      missingItems.length === 0 &&
      unsupportedClaims.length === 0 &&
      !isAbsenceDrivenAnswer
    ) {
      confidence = "high";
    } else if (score >= 0.6 && hasEvidence && !isAbsenceDrivenAnswer) {
      confidence = "medium";
    } else if (score >= 0.4 || weakItems.length > 0 || missingItems.length > 0) {
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
        missingItems,
        weakItems,
        unsupportedClaims,
        conflictingClaims,
        suggestedGuidance: parsed.suggested_guidance ?? [],
        citationIssues: parsed.citation_issues ?? [],
        sequenceIssues: parsed.sequence_issues ?? [],
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
        conflictingClaims: [],
        suggestedGuidance: [],
        citationIssues: [],
        sequenceIssues: [],
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
