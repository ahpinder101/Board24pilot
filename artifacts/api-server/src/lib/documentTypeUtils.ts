/** True when manual metadata indicates electrical/schematic content. */
export function isElectricalLikeDocument(documentType: string | null | undefined): boolean {
  const text = (documentType ?? "").toLowerCase();
  return (
    text.includes("electrical") ||
    text.includes("wiring") ||
    text.includes("schematic") ||
    text.includes("control")
  );
}
