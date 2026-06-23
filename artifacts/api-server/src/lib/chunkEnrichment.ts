export const PLC_IO_TABLE_TAG =
  "\n[PLC I/O assignment table: digital inputs, digital outputs, PLC address, sensor, actuator, solenoid valve, X input, Y output]";

/** Detect PLC I/O assignment table content from vision OCR or structured rows. */
export function isPlcIoTableContent(text: string): boolean {
  if (/DIGITAL INPUTS|DIGITAL OUTPUTS|ANALOGUE INPUTS|ANALOGUE OUTPUTS|TEMPERATURE INPUTS/i.test(text)) {
    return true;
  }
  if (/ADDRESS\s*\|\s*DESCRIPTION/i.test(text)) {
    return true;
  }
  const addrMatches = text.match(/\b[XYI][0-9]+[.:][0-9]{1,2}\b/gi);
  return (addrMatches?.length ?? 0) >= 3;
}

/** Append PLC I/O retrieval tag when chunk content looks like an I/O assignment table. */
export function applyPlcIoTableTag(content: string): string {
  if (content.includes("[PLC I/O assignment")) return content;
  if (!isPlcIoTableContent(content)) return content;
  return content + PLC_IO_TABLE_TAG;
}
