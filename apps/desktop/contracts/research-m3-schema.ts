const text = { type: "string" };
const texts = { type: "array", items: text };
const integer = { type: "integer" };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown) => ({ type: "array", items });

export const RESEARCH_M3_TOOL_PROPERTIES = {
  memberInputIds: texts,
  memberInputId: text,
  memberInputDisposition: { type: "string", enum: ["no-manuscript-change", "requires-revision"] },
  pathRecordId: text,
  specialistId: text,
  record: object(
    {
      path: { type: "string", enum: ["review", "qualitative", "theoretical"] },
      scope: text,
      approach: text,
      limitations: text,
      evidence: array(
        object({
          id: text,
          sourceId: text,
          locatorId: text,
          start: integer,
          end: integer,
          interpretation: text,
        }),
      ),
      review: object({
        inclusionCriteria: text,
        qualityAssessment: text,
        selectionLimitations: text,
      }),
      qualitative: object({
        approach: { type: "string", enum: ["reflexive-thematic-analysis"] },
        researcherPosition: text,
        codes: array(object({ id: text, label: text, evidenceIds: texts, interpretation: text })),
        themes: array(
          object({ id: text, label: text, codeIds: texts, claim: text, counterEvidenceIds: texts }),
        ),
        negativeCaseSearch: text,
        reflexivity: text,
      }),
      theoretical: object({
        concepts: array(object({ id: text, definition: text, evidenceIds: texts })),
        arguments: array(
          object({
            id: text,
            proposition: text,
            premiseIds: texts,
            steps: texts,
            evidenceIds: texts,
            competingExplanation: text,
            counterexample: text,
          }),
        ),
      }),
    },
    ["path", "scope", "approach", "limitations", "evidence"],
  ),
  scopeEdits: array(object({ start: integer, end: integer, replacement: text })),
  scopeFindings: array(
    object({
      rangeIndex: integer,
      conclusion: {
        type: "string",
        enum: ["supported", "partially-supported", "unsupported", "insufficient-material"],
      },
      reason: text,
    }),
  ),
};
