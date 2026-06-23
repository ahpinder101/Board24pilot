/** Parse manualId from API request bodies (number or numeric string). */
export function parsePinnedManualId(raw: unknown): number | null {
  const id = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Drop chunks that fall outside the active manual scope. */
export function filterChunksToManualIds<T extends { manual_id: number }>(
  chunks: T[],
  manualIds: number[],
): T[] {
  if (manualIds.length === 0) return chunks;
  const allowed = new Set(manualIds);
  return chunks.filter((c) => allowed.has(c.manual_id));
}
