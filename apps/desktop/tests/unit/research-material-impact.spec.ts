import { expect, test } from "@playwright/test";
import type { ResearchProject } from "../../contracts/research-group";
import type { ResearchMaterialChangeRequest } from "../../contracts/research-material-impact";
import { decodeResearchMaterialChangeCommit } from "../../contracts/research-material-impact";
import {
  planResearchMaterialChange,
  previewResearchMaterialChange,
} from "../../electron/research-group/material-change";
import {
  createResearchTaskGraph,
  setResearchInput,
  applyResearchChange,
  addResearchTask,
  startResearchTask,
  markResearchTaskDispatched,
  publishResearchTaskResult,
  finishResearchTaskAttempt,
  attachResearchTaskArtifact,
  reviewResearchTaskArtifact,
} from "../../electron/research-group/task-graph";
const at = "2026-11-07T00:00:00Z";
function fixture(): ResearchProject {
  let graph = createResearchTaskGraph("project", "2.0.0");
  graph = setResearchInput(graph, {
    inputId: "source:s",
    version: 1,
    kind: "material",
    availability: "available",
    actual: true,
    label: "原文",
    sourceRef: "/old",
    digest: "a".repeat(64),
  });
  graph = applyResearchChange(graph, {
    id: "adopt",
    at,
    inputId: "source:s",
    fromVersion: null,
    toVersion: 1,
    reason: "采用",
    authorizedBy: "user",
    authorizationRef: "user",
  });
  for (const id of ["related", "unrelated"]) {
    graph = addResearchTask(graph, {
      id,
      stage: "reading",
      role: "lead",
      kind: "research",
      goal: id,
      inputs:
        id === "related" ? [{ inputId: "source:s", version: 1, requirement: "available" }] : [],
      dependencies: [],
      earlyHandoff: "初稿",
      deliverable: "全文",
      reviewRequired: true,
      writeScope: [id],
    });
    graph = markResearchTaskDispatched(
      startResearchTask(graph, id, { id: `attempt-${id}`, at, reservedTokens: 10 }),
      `attempt-${id}`,
      at,
    );
    graph = publishResearchTaskResult(graph, {
      id: `artifact-${id}`,
      projectId: "project",
      attemptId: `attempt-${id}`,
      at,
      content: id,
      usedTokens: 5,
    });
  }
  return {
    id: "project",
    revision: 1,
    root: { workspaceId: "w", sessionId: "s" },
    workspacePath: "/tmp",
    objective: "研究",
    status: "paused",
    createdAt: at,
    updatedAt: at,
    knowledge: { directory: "/tmp", sha256: "hash", version: "1", count: 0 },
    members: [],
    artifacts: [],
    packets: [],
    events: [],
    fusion: graph,
    evidence: {
      directory: "/tmp",
      sources: [
        {
          id: "s",
          file: "/old",
          sha256: "a".repeat(64),
          title: "旧材料",
          authors: "作者",
          year: "2026",
          url: "local",
          kind: "paper",
          access: "provided-text",
        },
      ],
      datasets: [],
    },
    importedMaterials: [
      {
        id: "candidate",
        name: "new.txt",
        sha256: "b".repeat(64),
        bytes: 4,
        importedAt: at,
        original: "/new",
        parsed: "/new.json",
        parserVersion: "1",
        duplicate: false,
        metadata: {},
        status: "ready",
        locations: [],
        tables: [],
        warnings: [],
      },
    ],
  };
}
for (const kind of ["replace", "withdraw"] as const)
  test(`${kind} invalidates only related inputs and preserves history; duplicate is idempotent`, () => {
    const p = fixture(),
      before = structuredClone(p);
    const request: ResearchMaterialChangeRequest =
      kind === "withdraw"
        ? { kind, sourceId: "s", reason: "撤回" }
        : {
            kind,
            sourceId: "s",
            candidateMaterialId: "candidate",
            reason: "修正",
            declaration: { category: "paper", sourceDescription: "修正版本" },
          };
    const impact = previewResearchMaterialChange(p, request);
    expect(impact.affectedTaskIds).toEqual(["related"]);
    expect(impact.reusableTaskIds).toEqual(["unrelated"]);
    const commit = { changeId: "one", expectedImpactToken: impact.token, request };
    const prepared =
      request.kind === "replace"
        ? {
            source: {
              ...p.evidence!.sources[0]!,
              materialImportId: "candidate",
              file: "/new-working",
              sha256: "b".repeat(64),
            },
            declaration: request,
          }
        : undefined;
    const result = planResearchMaterialChange(p, commit, at, prepared);
    expect(p).toEqual(before);
    expect(result.project.fusion!.artifacts.find((a) => a.taskId === "related")!.reviewState).toBe(
      "needs-review",
    );
    expect(result.project.fusion!.tasks.find((t) => t.id === "unrelated")).toEqual(
      p.fusion!.tasks.find((t) => t.id === "unrelated"),
    );
    expect(result.project.fusion!.adoptedInputs).toEqual([{ inputId: "source:s", version: 2 }]);
    expect(result.project.fusion!.inputs.at(-1)!.availability).toBe(
      kind === "replace" ? "available" : "withdrawn",
    );
    expect(result.archivedEvidence.sources).toEqual(p.evidence!.sources);
    expect(result.project.evidence!.sources).toHaveLength(kind === "replace" ? 1 : 0);
    const repeated = planResearchMaterialChange(result.project, commit, at, prepared);
    expect(repeated.alreadyApplied).toBe(true);
    expect(repeated.project).toEqual(result.project);
    expect(() =>
      planResearchMaterialChange(
        result.project,
        { ...commit, request: { ...request, reason: "不同意图" } },
        at,
        prepared,
      ),
    ).toThrow("身份");
  });
test("stale impact rejects before mutation and narrow decoder rejects hidden authorization", () => {
  const p = fixture();
  const request = { kind: "withdraw" as const, sourceId: "s", reason: "撤回" };
  const commit = {
    changeId: "x",
    expectedImpactToken: previewResearchMaterialChange(p, request).token,
    request,
  };
  p.fusion!.artifacts[0]!.content = "预览之后新交付的内容";
  expect(() => planResearchMaterialChange(p, commit, at)).toThrow("重新查看影响");
  expect(() => decodeResearchMaterialChangeCommit({ ...commit, actor: "user" })).toThrow(
    "未知字段",
  );
});
test("withdrawing the last dataset closes aggregate availability and archives working evidence", () => {
  const p = fixture();
  p.evidence!.sources[0]!.kind = "dataset";
  p.evidence!.datasets.push({
    id: "d",
    sourceId: "s",
    file: "/data.csv",
    sha256: "c".repeat(64),
    description: "数据",
    dataKind: "observed",
    permission: "user-authorized",
    delimiter: ",",
  });
  for (const inputId of ["dataset:d", "implementation-material"]) {
    p.fusion = setResearchInput(p.fusion!, {
      inputId,
      version: 1,
      kind: "material",
      availability: "available",
      actual: true,
      label: inputId,
      sourceRef: "/data.csv",
      digest: "c".repeat(64),
    });
    p.fusion = applyResearchChange(p.fusion, {
      id: `adopt-${inputId}`,
      at,
      inputId,
      fromVersion: null,
      toVersion: 1,
      reason: "数据采用",
      authorizedBy: "user",
      authorizationRef: "user",
    });
  }
  const request = { kind: "withdraw" as const, sourceId: "s", reason: "撤回数据" };
  const impact = previewResearchMaterialChange(p, request);
  const result = planResearchMaterialChange(
    p,
    { changeId: "data", expectedImpactToken: impact.token, request },
    at,
  );
  expect(result.project.evidence!.datasets).toEqual([]);
  expect(result.project.currentStage).toBe("design");
  for (const id of ["dataset:d", "implementation-material"]) {
    const ref = result.project.fusion!.adoptedInputs.find((i) => i.inputId === id)!;
    expect(
      result.project.fusion!.inputs.find((i) => i.inputId === id && i.version === ref.version),
    ).toMatchObject({ availability: "withdrawn", actual: false });
  }
  expect(result.archivedEvidence.datasets).toEqual(p.evidence!.datasets);
});

const replaceRequest: Extract<ResearchMaterialChangeRequest, { kind: "replace" }> = {
  kind: "replace",
  sourceId: "s",
  candidateMaterialId: "candidate",
  reason: "以操作者确认的修正原文替换旧材料",
  declaration: { category: "paper", sourceDescription: "明确的合成软件测试修正材料" },
};
function preparedReplacement(p: ResearchProject) {
  return {
    source: {
      ...p.evidence!.sources[0]!,
      materialImportId: "candidate",
      file: "/new-working",
      sha256: "b".repeat(64),
    },
    declaration: replaceRequest,
  };
}
function addRunningTask(p: ResearchProject, id: string, related = true, dispatch = true) {
  p.fusion = addResearchTask(p.fusion!, {
    id,
    stage: "reading",
    role: "reviewer",
    kind: "research",
    goal: "合成测试：真实任务图内的运行边界",
    inputs: related ? [{ inputId: "source:s", version: 1, requirement: "available" }] : [],
    dependencies: [],
    earlyHandoff: "可定位的材料意见",
    deliverable: "完成本材料判断",
    reviewRequired: true,
    writeScope: [id],
  });
  p.fusion = startResearchTask(p.fusion, id, { id: `attempt-${id}`, at, reservedTokens: 10 });
  if (dispatch) p.fusion = markResearchTaskDispatched(p.fusion, `attempt-${id}`, at);
}

for (const movement of ["output", "native-completion", "dispatch", "read-receipt"] as const)
  test(`material replacement keeps its authorization after ${movement} when its complete impact is unchanged`, () => {
    const p = fixture();
    if (movement === "native-completion" || movement === "dispatch")
      addRunningTask(p, "inflight", true, movement !== "dispatch");
    const before = previewResearchMaterialChange(p, replaceRequest);
    const commit = {
      changeId: `benign-${movement}`,
      expectedImpactToken: before.token,
      request: replaceRequest,
    };
    if (movement === "native-completion") {
      p.fusion = finishResearchTaskAttempt(p.fusion!, "attempt-inflight", {
        at: "2026-11-07T00:00:01Z",
        usedTokens: 7,
      });
    } else if (movement === "dispatch") {
      p.fusion = markResearchTaskDispatched(p.fusion!, "attempt-inflight", "2026-11-07T00:00:01Z");
    } else if (movement === "read-receipt") {
      // A locator receipt alone does not acquire a new dependency. Actual graph
      // consumption is separately tested below through attachResearchTaskArtifact.
      p.sourceReads = [
        {
          id: "receipt",
          sourceId: "s",
          sourceSha256: "a".repeat(64),
          bodySha256: "a".repeat(64),
          locatorId: "line-1",
          start: 0,
          end: 1,
          depth: "full-text",
          sessionId: "lead",
          at: "2026-11-07T00:00:01Z",
          evidenceRef: "synthetic-source-read",
        },
      ];
    } else {
      p.status = "running";
      p.updatedAt = "2026-11-07T00:00:01Z";
      p.members = [
        { role: "lead", ref: p.root, status: "running", startedAt: at, firstOutputAt: p.updatedAt },
      ];
      p.events.push({
        id: "output-only",
        at: p.updatedAt,
        revision: 1,
        type: "output",
        role: "lead",
        runId: "synthetic-native",
        runtimeAt: p.updatedAt,
        detail: "合成流式进度，没有发布新稿或取得新依赖。",
      });
      p.fusion!.attempts[0]!.sessionTotalTokens = 900;
      p.fusion!.attempts[0]!.usedTokens = 8;
    }
    const after = previewResearchMaterialChange(p, replaceRequest);
    const { token: _beforeToken, ...beforeImpact } = before;
    const { token: _afterToken, ...afterImpact } = after;
    expect(afterImpact).toEqual(beforeImpact);
    expect(after.token).toBe(before.token);
    const result = planResearchMaterialChange(
      p,
      commit,
      "2026-11-07T00:00:02Z",
      preparedReplacement(p),
    );
    expect(result.alreadyApplied).toBe(false);
    expect(result.project.evidence!.sources[0]!.sha256).toBe("b".repeat(64));
    expect(result.project.fusion!.adoptedInputs).toEqual([{ inputId: "source:s", version: 2 }]);
  });

const materialChanges: { name: string; change(p: ResearchProject): void }[] = [
  {
    name: "project identity",
    change: (p) => {
      p.id = "different-project";
      p.fusion!.projectId = p.id;
    },
  },
  {
    name: "input revision",
    change: (p) => {
      p.revision++;
    },
  },
  {
    name: "source bytes",
    change: (p) => {
      p.evidence!.sources[0]!.sha256 = "c".repeat(64);
    },
  },
  {
    name: "source declaration",
    change: (p) => {
      p.evidence!.sources[0]!.textScope = "partial-text";
    },
  },
  {
    name: "new source",
    change: (p) => {
      p.evidence!.sources.push({
        ...p.evidence!.sources[0]!,
        id: "new-source",
        file: "/new-source",
        sha256: "d".repeat(64),
      });
    },
  },
  {
    name: "candidate bytes",
    change: (p) => {
      p.importedMaterials![0]!.sha256 = "e".repeat(64);
    },
  },
  {
    name: "candidate parsed content",
    change: (p) => {
      p.importedMaterials![0]!.locations.push({
        kind: "line",
        locator: "line-1",
        text: "候选原文实质改变",
      });
    },
  },
  {
    name: "candidate declaration",
    change: (p) => {
      p.importedMaterials![0]!.metadata.purpose = "候选材料用途在预览后实质改变";
    },
  },
  {
    name: "new graph input",
    change: (p) => {
      p.fusion = setResearchInput(p.fusion!, {
        inputId: "new-condition",
        version: 1,
        kind: "context",
        availability: "planned",
        actual: false,
        label: "新条件",
        sourceRef: "pending",
        digest: "f".repeat(64),
      });
    },
  },
  {
    name: "affected task version",
    change: (p) => {
      const task = p.fusion!.tasks.find((t) => t.id === "related")!;
      task.inputVersion++;
      delete task.currentArtifactId;
      task.state = "pending";
      p.fusion!.artifacts.find((a) => a.taskId === task.id)!.reviewState = "needs-review";
    },
  },
  {
    name: "affected artifact body",
    change: (p) => {
      p.fusion!.artifacts.find((a) => a.taskId === "related")!.content = "预览后实质新稿";
    },
  },
  {
    name: "affected artifact review",
    change: (p) => {
      p.fusion = reviewResearchTaskArtifact(p.fusion!, "artifact-related", {
        id: "synthetic-review",
        at,
        actor: "model",
        reviewer: "synthetic-reviewer",
        verdict: "accepted",
        reason: "合成测试的真实图审阅记录，不是研究结论。",
      });
    },
  },
];
for (const mutation of materialChanges)
  test(`material replacement rejects its old preview after ${mutation.name} changes`, () => {
    const p = fixture(),
      before = previewResearchMaterialChange(p, replaceRequest);
    mutation.change(p);
    // A valid fresh preview prevents decoder errors from masquerading as stale authorization.
    expect(previewResearchMaterialChange(p, replaceRequest).token).not.toBe(before.token);
    expect(() =>
      planResearchMaterialChange(
        p,
        {
          changeId: "changed-semantic-input",
          expectedImpactToken: before.token,
          request: replaceRequest,
        },
        at,
        preparedReplacement(p),
      ),
    ).toThrow("重新查看影响");
  });

test("material preview is stale after an adopted input advances or its declared replacement changes", () => {
  const p = fixture(),
    before = previewResearchMaterialChange(p, replaceRequest);
  p.fusion = setResearchInput(p.fusion!, {
    ...p.fusion!.inputs[0]!,
    version: 2,
    digest: "c".repeat(64),
  });
  p.fusion = applyResearchChange(p.fusion, {
    id: "new-input-adoption",
    at,
    inputId: "source:s",
    fromVersion: 1,
    toVersion: 2,
    reason: "另一个真实输入授权",
    authorizedBy: "user",
    authorizationRef: "synthetic-new-input",
  });
  expect(previewResearchMaterialChange(p, replaceRequest).token).not.toBe(before.token);
  expect(() =>
    planResearchMaterialChange(
      p,
      { changeId: "old-preview", expectedImpactToken: before.token, request: replaceRequest },
      at,
      preparedReplacement(p),
    ),
  ).toThrow("重新查看影响");
  const original = fixture(),
    impact = previewResearchMaterialChange(original, replaceRequest);
  const request = {
    ...replaceRequest,
    declaration: { ...replaceRequest.declaration, sourceDescription: "用户改为另一项材料声明" },
  };
  expect(() =>
    planResearchMaterialChange(
      original,
      { changeId: "changed-declaration", expectedImpactToken: impact.token, request },
      at,
      { ...preparedReplacement(original), declaration: request },
    ),
  ).toThrow("重新查看影响");
});

test("newly consumed handoff enlarges the displayed impact and requires a new material authorization", () => {
  const p = fixture();
  addRunningTask(p, "actual-consumer", false);
  const before = previewResearchMaterialChange(p, replaceRequest);
  expect(before.reusableTaskIds).toContain("actual-consumer");
  p.fusion = attachResearchTaskArtifact(p.fusion!, "attempt-actual-consumer", "artifact-related", {
    at: "2026-11-07T00:00:01Z",
    evidenceRef: "synthetic-actual-artifact-read",
  });
  const after = previewResearchMaterialChange(p, replaceRequest);
  expect(after.affectedTaskIds).toContain("actual-consumer");
  expect(after.reusableTaskIds).not.toContain("actual-consumer");
  expect(after.token).not.toBe(before.token);
  expect(() =>
    planResearchMaterialChange(
      p,
      {
        changeId: "old-consumption-scope",
        expectedImpactToken: before.token,
        request: replaceRequest,
      },
      at,
      preparedReplacement(p),
    ),
  ).toThrow("重新查看影响");
});

test("a real new publication makes the old material preview stale even when its affected tasks stay the same", () => {
  const p = fixture();
  addRunningTask(p, "publishing");
  const before = previewResearchMaterialChange(p, replaceRequest);
  p.fusion = publishResearchTaskResult(p.fusion!, {
    projectId: p.id,
    id: "new-published-result",
    attemptId: "attempt-publishing",
    at: "2026-11-07T00:00:01Z",
    content: "合成新交付稿，具有真实图中身份",
    usedTokens: 7,
  });
  const after = previewResearchMaterialChange(p, replaceRequest);
  expect(after.affectedTaskIds).toEqual(before.affectedTaskIds);
  expect(after.affectedArtifactIds).toContain("new-published-result");
  expect(() =>
    planResearchMaterialChange(
      p,
      {
        changeId: "old-publication-preview",
        expectedImpactToken: before.token,
        request: replaceRequest,
      },
      at,
      preparedReplacement(p),
    ),
  ).toThrow("重新查看影响");
});

test("material authorization pins manuscript bodies and fixed export identity beyond visible task IDs", () => {
  for (const change of ["manuscript", "export", "superseded-export"] as const) {
    const p = fixture();
    p.artifacts.push({
      id: "artifact-related",
      role: "lead",
      kind: "stage-draft",
      revision: 1,
      round: 0,
      createdAt: at,
      content: "预览时的完整稿件",
      refs: [],
      toolCallId: "synthetic-draft",
      stage: "question",
    });
    p.finalPaper = {
      markdown: "/accepted.md",
      html: "/accepted.html",
      provenance: "/accepted.json",
    };
    const before = previewResearchMaterialChange(p, replaceRequest);
    if (change === "manuscript") p.artifacts[0]!.content = "同一ID的稿件实质变化";
    else if (change === "export") p.finalPaper.markdown = "/different-accepted.md";
    else p.supersededExports = [{ files: { ...p.finalPaper }, at, reason: "另一项真实旧稿归档" }];
    expect(previewResearchMaterialChange(p, replaceRequest).token).not.toBe(before.token);
    expect(() =>
      planResearchMaterialChange(
        p,
        {
          changeId: `old-${change}-preview`,
          expectedImpactToken: before.token,
          request: replaceRequest,
        },
        at,
        preparedReplacement(p),
      ),
    ).toThrow("重新查看影响");
  }
});

test("dataset bytes, file identity and use declarations remain part of material authorization", () => {
  const base = fixture();
  base.evidence!.sources[0]!.kind = "dataset";
  base.evidence!.datasets.push({
    id: "d",
    sourceId: "s",
    file: "/old.csv",
    sha256: "c".repeat(64),
    description: "合成公共数据声明",
    dataKind: "observed",
    permission: "public",
    delimiter: ",",
  });
  for (const inputId of ["dataset:d", "implementation-material"]) {
    base.fusion = setResearchInput(base.fusion!, {
      inputId,
      version: 1,
      kind: "material",
      availability: "available",
      actual: true,
      label: inputId,
      sourceRef: "/old.csv",
      digest: "c".repeat(64),
    });
    base.fusion = applyResearchChange(base.fusion, {
      id: `adopt-${inputId}`,
      at,
      inputId,
      fromVersion: null,
      toVersion: 1,
      reason: "合成数据采用",
      authorizedBy: "user",
      authorizationRef: "synthetic-data-input",
    });
  }
  const request = { kind: "withdraw" as const, sourceId: "s", reason: "撤回已确认数据" };
  for (const field of ["sha256", "file", "dataKind", "permission", "delimiter"] as const) {
    const p = structuredClone(base),
      before = previewResearchMaterialChange(p, request),
      dataset = p.evidence!.datasets[0]!;
    if (field === "sha256") dataset.sha256 = "d".repeat(64);
    else if (field === "file") dataset.file = "/changed.csv";
    else if (field === "dataKind") dataset.dataKind = "synthetic";
    else if (field === "permission") dataset.permission = "user-authorized";
    else dataset.delimiter = ";";
    expect(previewResearchMaterialChange(p, request).token).not.toBe(before.token);
    expect(() =>
      planResearchMaterialChange(
        p,
        { changeId: `stale-dataset-${field}`, expectedImpactToken: before.token, request },
        at,
      ),
    ).toThrow("重新查看影响");
  }
});
