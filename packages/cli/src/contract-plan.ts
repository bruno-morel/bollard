/** Paths from planner JSON `affected_files` (modify + create, or a flat path list). */
export function collectAffectedPathsFromPlan(plan: unknown): string[] {
  if (!plan || typeof plan !== "object") return []
  const root = plan as Record<string, unknown>
  const af = root["affected_files"]
  if (!af) return []
  if (Array.isArray(af)) return af.map(String)
  if (typeof af !== "object") return []
  const o = af as Record<string, unknown>
  const mod = Array.isArray(o["modify"]) ? o["modify"].map(String) : []
  const cr = Array.isArray(o["create"]) ? o["create"].map(String) : []
  return [...mod, ...cr]
}
