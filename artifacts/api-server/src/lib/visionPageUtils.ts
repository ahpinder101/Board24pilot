/** Parse PAGE_TYPE from vision interpretation output. */
export function parsePageTypeFromVisionText(text: string): string | null {
  const firstLines = text.split("\n").slice(0, 5);
  for (const line of firstLines) {
    const match = line.match(/^PAGE_TYPE:\s*(\S+)/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

const ELECTRICAL_SECTION_RE =
  /POWER\s+RAILS|SWITCHING\s+ELEMENTS|RELAY\/CONTACTOR\s+CONTACTS|INDICATOR\s+LAMPS|CIRCUIT\s+TRACES/i;
const PLC_IO_SECTION_RE =
  /DIGITAL\s+INPUTS|DIGITAL\s+OUTPUTS|ADDRESS\s*\|\s*DESCRIPTION|\bI\/O\b/i;
const SCHEMATIC_SECTION_RE = /ACTUATORS:|DIRECTIONAL\s+CONTROL\s+VALVES|CIRCUIT\s+FLOW\s+DESCRIPTION/i;

/** True when vision output contains expected sections for the classified page type. */
export function passesVisionQualityGate(pageType: string | null, text: string): boolean {
  const body = text.trim();
  if (body.length < 80) return false;

  switch (pageType) {
    case "ELECTRICAL_WIRING":
      return ELECTRICAL_SECTION_RE.test(body);
    case "PLC_IO_TABLE":
      return PLC_IO_SECTION_RE.test(body);
    case "PNEUMATIC_SCHEMATIC":
    case "HYDRAULIC_SCHEMATIC":
      return SCHEMATIC_SECTION_RE.test(body);
    case "MECHANICAL_DRAWING":
      return /DIMENSIONS:|BOM\s+TABLE|PART\/ASSEMBLY/i.test(body);
    case "TEXT_TABLE":
      return body.length >= 120;
    default:
      return body.length >= 120;
  }
}

export function buildPageClassifyPrompt(pageNumber: number): string {
  return `You are classifying page ${pageNumber} of an engineering manual.

Look at the image and output EXACTLY one line — no other text:
PAGE_TYPE: PNEUMATIC_SCHEMATIC
PAGE_TYPE: HYDRAULIC_SCHEMATIC
PAGE_TYPE: ELECTRICAL_WIRING
PAGE_TYPE: PLC_IO_TABLE
PAGE_TYPE: MECHANICAL_DRAWING
PAGE_TYPE: TEXT_TABLE

Choose the single best match.`;
}
