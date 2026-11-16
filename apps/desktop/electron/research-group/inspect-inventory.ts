import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { decodeImportedResearchMaterials } from "../../contracts/research-materials";
import type { ResearchProject } from "../../contracts/research-group";
import type { ResearchInventorySnapshot } from "../../contracts/research-method";
import {
  planResearchEntryInventory,
  type ResearchInventoryFileObservation,
} from "./inventory-route-plan";

/** Inspect current bytes; registered paths and hashes alone never establish availability. */
export async function inspectResearchInventory(
  p: ResearchProject,
): Promise<ResearchInventorySnapshot> {
  const checks = planResearchEntryInventory(p).requiredChecks;
  const observations = await Promise.all(
    checks.map(async (check): Promise<ResearchInventoryFileObservation> => {
      try {
        const info = await stat(check.file);
        if (!info.isFile() || info.size > 128_000_000)
          return { file: check.file, status: "unreadable" };
        const bytes = await readFile(check.file);
        if (check.kind === "parsed") {
          const decoded: unknown = JSON.parse(bytes.toString("utf8"));
          const registered = p.importedMaterials?.find((item) => item.id === check.ownerId);
          if (
            !registered ||
            !isDeepStrictEqual(decodeImportedResearchMaterials([decoded])[0], registered)
          )
            return { file: check.file, status: "unreadable" };
        }
        return {
          file: check.file,
          status: "readable",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (error) {
        return {
          file: check.file,
          status:
            error && typeof error === "object" && "code" in error && error.code === "ENOENT"
              ? "missing"
              : "unreadable",
        };
      }
    }),
  );
  const plan = planResearchEntryInventory(p, observations);
  return {
    revision: p.revision,
    checkedAt: new Date().toISOString(),
    canStart: plan.canStart,
    firstMissingStage: plan.nextStage,
    evidenceRef:
      plan.inventory?.evidenceRef ??
      `inventory:${createHash("sha256").update(JSON.stringify({ checks, observations })).digest("hex")}`,
    reusable: plan.reusable.map((item) => `${item.id}：${item.reason}`),
    pending: plan.pending.map((item) => `${item.id}：${item.reason}`),
    missing: plan.missing.map(
      (item) => `${item.blocksStart ? "开始前需补齐" : "后续关口"}：${item.reason}`,
    ),
    limitations: plan.limitations,
  };
}
