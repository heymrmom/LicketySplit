import type { PodcastPlacement, PodcastSetup, PodcastSyncEdge } from "../../../../../../packages/core/src/lickety/podcast-types";

/** Legacy robust fit over training anchors only. Held-out anchors stay checks. */
export function refinePodcastClockNetwork(
  placements: Map<string, PodcastPlacement>,
  edges: PodcastSyncEdge[],
  clockGroups: PodcastSetup["clockGroups"] = [],
) {
  const clockFor = (id: string) => clockGroups.find((group) => group.confirmed && group.assetIds.includes(id));
  for (const component of new Set([...placements.values()].map((placement) => placement.component))) {
    const nodes = [...placements.values()].filter((placement) => placement.component === component && !placement.regions && placement.status !== "excluded");
    const usable = (placement: PodcastPlacement) => placement.status !== "manual" || placement.locked || Boolean(clockFor(placement.assetId)?.sourceStarts);
    const fitting = edges.filter((edge) => edge.basis !== "recorder" && nodes.some((placement) => placement.assetId === edge.a && usable(placement)) && nodes.some((placement) => placement.assetId === edge.b && usable(placement)))
      .flatMap((edge) => edge.anchors.filter((anchor) => anchor.role === "fit").map((anchor) => ({ edge, anchor })));
    const unitKey = (placement: PodcastPlacement) => clockFor(placement.assetId)?.sourceStarts ? clockFor(placement.assetId)!.id : placement.assetId;
    const starts = (placement: PodcastPlacement) => clockFor(placement.assetId)?.sourceStarts?.[placement.assetId] || 0;
    const units = [...new Set(nodes.map(unitKey))].map((key) => {
      const members = nodes.filter((placement) => unitKey(placement) === key);
      const fixed = members.filter((placement) => placement.assetId === component || placement.locked || placement.status === "manual");
      const anchor = fixed[0] || members[0];
      const scale = anchor.mapping.scale, offset = anchor.mapping.offsetSeconds - scale * starts(anchor);
      if (fixed.some((placement) => Math.abs(placement.mapping.scale - scale) > 1e-10 || Math.abs(placement.mapping.offsetSeconds - scale * starts(placement) - offset) > 1e-7)) {
        throw new Error("Confirmed recorder timing conflicts with a manual placement. Review the recording relationship in Setup.");
      }
      for (const placement of members) placement.mapping = { version: 1, scale, offsetSeconds: offset + scale * starts(placement) };
      const times = fitting.flatMap(({ edge, anchor: row }) => members.some((placement) => placement.assetId === edge.a)
        ? [row.referenceSeconds + starts(placements.get(edge.a)!)]
        : members.some((placement) => placement.assetId === edge.b) ? [row.sourceSeconds + starts(placements.get(edge.b)!)] : []);
      return { key, members, fixed: fixed.length > 0, center: times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length) };
    });
    const free = units.filter((unit) => !unit.fixed), indices = new Map(free.map((unit, index) => [unit.key, index]));
    const slopes = new Map<string, number>(); let variables = free.length;
    for (const unit of free) {
      const clock = clockFor(unit.members[0].assetId), key = clock?.id || unit.key;
      const members = clock ? nodes.filter((placement) => clock.assetIds.includes(placement.assetId)) : unit.members;
      const fixed = members.filter((placement) => placement.assetId === component || placement.locked || placement.status === "manual");
      if (fixed.some((placement) => Math.abs(placement.mapping.scale - fixed[0].mapping.scale) > 1e-10)) throw new Error("Confirmed recorder clock conflicts with locked/manual rates.");
      const common = fixed[0]?.mapping.scale ?? members[0].mapping.scale;
      for (const placement of unit.members) {
        placement.mapping.offsetSeconds += (placement.mapping.scale - common) * (unit.center - starts(placement));
        placement.mapping.scale = common;
      }
      if (!fixed.length && !slopes.has(key)) slopes.set(key, variables++);
    }
    if (!variables || !fitting.length) continue;
    const unitFor = (id: string) => units.find((unit) => unit.members.some((placement) => placement.assetId === id))!;
    const slopeFor = (id: string) => slopes.get(clockFor(id)?.id || unitKey(placements.get(id)!));
    const rows = fitting.map(({ edge, anchor }) => {
      const pa = placements.get(edge.a)!, pb = placements.get(edge.b)!, coefficients = new Float64Array(variables);
      for (const [placement, time, sign] of [[pa, anchor.referenceSeconds, 1], [pb, anchor.sourceSeconds, -1]] as const) {
        const unit = unitFor(placement.assetId), index = indices.get(unit.key);
        if (index === undefined) continue;
        coefficients[index] += sign;
        const slope = slopeFor(placement.assetId);
        if (slope !== undefined) coefficients[slope] += sign * (time + starts(placement) - unit.center) / 1000;
      }
      return { coefficients, target: (anchor.sourceSeconds * pb.mapping.scale + pb.mapping.offsetSeconds) - (anchor.referenceSeconds * pa.mapping.scale + pa.mapping.offsetSeconds), weight: Math.max(0.05, anchor.score * anchor.score) };
    });
    let solution = new Float64Array(variables);
    for (let iteration = 0; iteration < 8; iteration++) {
      const matrix = Array.from({ length: variables }, () => new Float64Array(variables + 1));
      for (const row of rows) {
        const residual = row.coefficients.reduce((sum, value, index) => sum + value * solution[index], 0) - row.target;
        const weight = row.weight * Math.min(1, 0.0025 / Math.max(1e-12, Math.abs(residual)));
        for (let i = 0; i < variables; i++) if (row.coefficients[i]) {
          matrix[i][variables] += weight * row.coefficients[i] * row.target;
          for (let j = 0; j < variables; j++) if (row.coefficients[j]) matrix[i][j] += weight * row.coefficients[i] * row.coefficients[j];
        }
      }
      for (let i = 0; i < variables; i++) matrix[i][i] += 1e-10;
      for (let i = 0; i < variables; i++) {
        let pivot = i; for (let j = i + 1; j < variables; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
        [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
        const divisor = matrix[i][i]; for (let k = i; k <= variables; k++) matrix[i][k] /= divisor;
        for (let j = 0; j < variables; j++) if (j !== i) { const factor = matrix[j][i]; for (let k = i; k <= variables; k++) matrix[j][k] -= factor * matrix[i][k]; }
      }
      solution = Float64Array.from(matrix, (row) => row[variables]);
    }
    for (const unit of free) for (const placement of unit.members) {
      const index = indices.get(unit.key)!, slope = slopeFor(placement.assetId), deltaScale = slope === undefined ? 0 : solution[slope] / 1000;
      if (!Number.isFinite(deltaScale) || !Number.isFinite(solution[index]) || placement.mapping.scale + deltaScale <= 0) continue;
      placement.mapping = { version: 1, scale: placement.mapping.scale + deltaScale, offsetSeconds: placement.mapping.offsetSeconds + solution[index] + deltaScale * (starts(placement) - unit.center) };
      placement.provenance.push(`robust-network-fit:${fitting.length}-fit-anchors; validation-held-out`);
    }
  }
}
