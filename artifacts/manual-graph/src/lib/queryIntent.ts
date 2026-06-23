/** Client-side mirror of server queryIntent — keep in sync with artifacts/api-server/src/lib/queryIntent.ts */

export type RetrievalMode =
  | "fact_lookup"
  | "process_trace"
  | "troubleshooting_flow"
  | "relationship_trace";

export type TechnicalDomainHint =
  | "electrical_control"
  | "troubleshooting";

export const PROCEDURAL_QUERY_RE =
  /\b(walk\s+me\s+through|step[-\s]by[-\s]step|steps?\s+to\s+\w|how\s+(do\s+I|to)\s+(replace|remove|install|disassemble|assemble|adjust|clean|set\s+up|change|perform|fix)|procedure\s+for|guide\s+me|show\s+me\s+(how|the\s+steps?)|all\s+steps?|sequence\s+for|process\s+of)\b/i;

export const TROUBLESHOOTING_QUERY_RE =
  /\b(stopped|not working|won't|wont|fault|failure|malfunction|symptom|no fault|check first|diagnos|troubleshoot|what (?:to|should I) check|list the (?:components|parts|items)|in what order|has tripped|tripped)\b/i;

export const RELATIONSHIP_TRACE_QUERY_RE =
  /\b(e[-\s]?stop|emergency stop|circuit path|describe the .* path|what happens when|trace|interlock|safety relay|de[-\s]?energ|inhibit signal|when .* is pressed)\b/i;

function isElectricalLikeDocument(documentType: string | null | undefined): boolean {
  const text = (documentType ?? "").toLowerCase();
  return (
    text.includes("electrical") ||
    text.includes("wiring") ||
    text.includes("schematic") ||
    text.includes("control")
  );
}

export function resolveRetrievalMode(
  question: string,
  requested?: string | null,
): RetrievalMode {
  const modes: RetrievalMode[] = [
    "fact_lookup",
    "process_trace",
    "troubleshooting_flow",
    "relationship_trace",
  ];
  if (requested && requested !== "auto" && modes.includes(requested as RetrievalMode)) {
    return requested as RetrievalMode;
  }
  if (PROCEDURAL_QUERY_RE.test(question)) return "process_trace";
  if (TROUBLESHOOTING_QUERY_RE.test(question)) return "troubleshooting_flow";
  if (RELATIONSHIP_TRACE_QUERY_RE.test(question)) return "relationship_trace";
  return "fact_lookup";
}

export function resolvePinnedManualDomain(
  pinnedDocumentType: string | null | undefined,
  question: string,
): TechnicalDomainHint | null {
  if (isElectricalLikeDocument(pinnedDocumentType)) {
    return "electrical_control";
  }
  if (TROUBLESHOOTING_QUERY_RE.test(question)) {
    return "troubleshooting";
  }
  return null;
}
