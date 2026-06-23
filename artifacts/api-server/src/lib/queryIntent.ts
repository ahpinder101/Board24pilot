import type { TechnicalDomain } from "./domainSpecialist.js";
import { isElectricalLikeDocument } from "./documentTypeUtils.js";

export type RetrievalMode =
  | "fact_lookup"
  | "process_trace"
  | "troubleshooting_flow"
  | "relationship_trace";

const RETRIEVAL_MODES: RetrievalMode[] = [
  "fact_lookup",
  "process_trace",
  "troubleshooting_flow",
  "relationship_trace",
];

/** Matches questions that ask for a full multi-step procedure. */
export const PROCEDURAL_QUERY_RE =
  /\b(walk\s+me\s+through|step[-\s]by[-\s]step|steps?\s+to\s+\w|how\s+(do\s+I|to)\s+(replace|remove|install|disassemble|assemble|adjust|clean|set\s+up|change|perform|fix)|procedure\s+for|guide\s+me|show\s+me\s+(how|the\s+steps?)|all\s+steps?|sequence\s+for|process\s+of)\b/i;

/** Fault / symptom / diagnostic ordering (Q3-style). */
export const TROUBLESHOOTING_QUERY_RE =
  /\b(stopped|not working|won't|wont|fault|failure|malfunction|symptom|no fault|check first|diagnos|troubleshoot|what (?:to|should I) check|list the (?:components|parts|items)|in what order|has tripped|tripped)\b/i;

/** E-stop / circuit path / interlock chain (Q8-style). */
export const RELATIONSHIP_TRACE_QUERY_RE =
  /\b(e[-\s]?stop|emergency stop|circuit path|describe the .* path|what happens when|trace|interlock|safety relay|de[-\s]?energ|inhibit signal|when .* is pressed)\b/i;

/** Terminal block / interconnect / cable (Q9-style). */
export const INTERCONNECT_QUERY_RE =
  /\b(interconnect|interconnecting cable|terminal block|terminal strip|\bXT\d+|\bTB\d+|core count|how many cores|cable terminates|wiring diagram)\b/i;

/** PLC address / I/O assignment (Q4, Q6, Q10). */
export const PLC_IO_QUERY_RE =
  /\b(plc|input address|output address|\bX[0-9]+[.:]|Y[0-9]+[.:]|I\/O|io table|solenoid valve|\bSV\d+)\b/i;

export function isTroubleshootingQuestion(question: string): boolean {
  return TROUBLESHOOTING_QUERY_RE.test(question);
}

export function isRelationshipTraceQuestion(question: string): boolean {
  return RELATIONSHIP_TRACE_QUERY_RE.test(question);
}

export function isInterconnectQuestion(question: string): boolean {
  return INTERCONNECT_QUERY_RE.test(question);
}

export function isPlcIoQuestion(question: string): boolean {
  return PLC_IO_QUERY_RE.test(question);
}

export function isProceduralQuestion(question: string): boolean {
  return PROCEDURAL_QUERY_RE.test(question);
}

/** Resolve retrieval mode from explicit request or question shape. */
export function resolveRetrievalMode(
  question: string,
  requested?: string | null,
): RetrievalMode {
  if (requested && requested !== "auto" && RETRIEVAL_MODES.includes(requested as RetrievalMode)) {
    return requested as RetrievalMode;
  }
  if (isProceduralQuestion(question)) return "process_trace";
  if (isTroubleshootingQuestion(question)) return "troubleshooting_flow";
  if (isRelationshipTraceQuestion(question)) return "relationship_trace";
  return "fact_lookup";
}

/** Infer domain when client sends auto/omits domain and a manual is pinned. */
export function resolvePinnedManualDomain(
  pinnedDocumentType: string | null | undefined,
  question: string,
  requestedDomain?: string | null,
): TechnicalDomain | null {
  if (
    requestedDomain &&
    requestedDomain !== "auto" &&
    [
      "electrical_control",
      "hydraulic_schematic",
      "pneumatic_schematic",
      "mechanical_assembly",
      "troubleshooting",
      "generic_process",
    ].includes(requestedDomain)
  ) {
    return requestedDomain as TechnicalDomain;
  }

  if (isElectricalLikeDocument(pinnedDocumentType)) {
    return "electrical_control";
  }

  if (isTroubleshootingQuestion(question)) {
    return "troubleshooting";
  }

  return null;
}

/** Symbol / keyword seeds for relationship-trace retrieval (E-stop chains). */
export function relationshipTraceSeeds(question: string): string[] {
  const seeds = new Set<string>();
  const q = question.toUpperCase();
  if (/E[-\s]?STOP|EMERGENCY STOP/.test(q)) {
    seeds.add("E-STOP");
    seeds.add("EMERGENCY");
  }
  for (const m of question.matchAll(/\b(?:RL|KM|FR|HL|KA|ES|SV|SQ|M)\d+[A-Z]?\b/gi)) {
    seeds.add(m[0]!.toUpperCase());
  }
  if (/\bsafety relay\b/i.test(question)) seeds.add("SAFETY");
  if (/\bvfd|inverter|drive\b/i.test(question)) seeds.add("VFD");
  return [...seeds].slice(0, 12);
}

/** Component candidates for fault-diagnosis retrieval (Q3). */
export const TROUBLESHOOTING_COMPONENT_KEYWORDS = [
  "sensor",
  "photocell",
  "proximity",
  "contactor",
  "overload",
  "relay",
  "VFD",
  "inverter",
  "drive",
  "indicator",
  "lamp",
  "solenoid",
] as const;

export function troubleshootingComponentSymbols(question: string): string[] {
  const fromQuestion = [
    ...question.matchAll(/\b(?:RL|KM|FR|HL|TB|XT|SQ|SV|KA|FU|PS|PLC|M)\d+[A-Z]?\b/gi),
  ].map((m) => m[0]!.toUpperCase());

  const defaults = ["SQ", "RL", "KM", "FR", "HL", "SV"];
  return [...new Set([...fromQuestion, ...defaults])].slice(0, 14);
}
