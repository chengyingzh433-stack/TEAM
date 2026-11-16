import { RESEARCH_ROLE_LABELS, type ResearchProject } from "../../../../contracts/research-group";

const verdict = { support: "支持", accept: "接受", revise: "修订", hold: "暂缓" };

export function ResearchMethodPackagesPanel({ project }: { project: ResearchProject }) {
  const packages = project.methodPackages ?? [];
  if (!packages.length) return null;
  return (
    <details className="research-group-records" data-testid="research-method-packages">
      <summary>
        方法依据与应用 · {packages.length} 个固定包 · {project.methodApplications?.length ?? 0}{" "}
        条应用
      </summary>
      <p>
        课程知识、原始研究证据和本课题决定分别保存。图片传送、读图观察、方法应用、B 的内容意见和导师
        Agent 裁定各有记录；完整评分工具的取得及适用性须另行核实。
      </p>
      {project.methodProgramChecks?.length ? (
        <details data-testid="research-method-program-checks">
          <summary>方法包程序检查 · {project.methodProgramChecks.length} 次记录</summary>
          <p>检查只对应当时的稿件、应用及图片记录；新的输入或依据需重新核验。</p>
          {[...project.methodProgramChecks].reverse().map((check) => (
            <details
              key={check.id}
              data-method-check-result={check.result}
              data-method-check-role={check.role}
            >
              <summary>
                {check.result === "blocked" ? "检查时仍有阻断" : "检查时无程序阻断"} ·{" "}
                {RESEARCH_ROLE_LABELS[check.role]}提交前 · {check.at}
              </summary>
              {check.issues.length ? (
                <ul>
                  {check.issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              ) : (
                <p>必要上下文、实际图像阅读和对应模型意见记录已齐备；方法判断仍由具名模型负责。</p>
              )}
              <details>
                <summary>检查版本与定位</summary>
                <p>稿件：{check.target?.artifactId ?? "尚无当前稿件"}</p>
                <p>正文摘要：{check.target?.bodySha256 ?? "尚无摘要"}</p>
                <p>程序版本：{check.programVersion}</p>
                {check.packages.map((pkg) => (
                  <p key={pkg.packageId}>
                    {pkg.packageId} · {pkg.applicationId ?? "缺少实际应用"}
                  </p>
                ))}
              </details>
            </details>
          ))}
        </details>
      ) : null}
      {packages.map((pkg) => {
        const uses = project.methodPackageUses?.filter((use) => use.packageId === pkg.id) ?? [];
        const applications =
          project.methodApplications?.filter((entry) => entry.packageId === pkg.id) ?? [];
        return (
          <details className="research-material-item" key={pkg.id} data-method-package-id={pkg.id}>
            <summary>
              {pkg.rootIds.join("、")} · 课程 {pkg.knowledge.version} · {uses.length} 次任务采用
            </summary>
            <details>
              <summary>固定版本与必要上下文</summary>
              <p>包：{pkg.id}</p>
              <p>包摘要：{pkg.packageSha256}</p>
              <p>课程索引摘要：{pkg.knowledge.sha256}</p>
              {pkg.supersedesPackageId ? <p>显式替换前版：{pkg.supersedesPackageId}</p> : null}
              {pkg.records.map((record) => (
                <details key={record.id}>
                  <summary>
                    {record.id} · {record.title}
                  </summary>
                  <p>{record.text}</p>
                  <p>必要上下文：{record.requiredContextIds.join("、") || "无附加块"}</p>
                  <p>来源层次：{record.contentLayers.join("、")}</p>
                  {record.boundaryNote ? <p>{record.boundaryNote}</p> : null}
                </details>
              ))}
            </details>
            {pkg.images.map((image) => {
              const receipts =
                project.methodImageReceipts?.filter(
                  (entry) => entry.packageId === pkg.id && entry.path === image.path,
                ) ?? [];
              const readings =
                project.methodImageReadings?.filter(
                  (entry) => entry.packageId === pkg.id && entry.path === image.path,
                ) ?? [];
              return (
                <details key={image.path}>
                  <summary>
                    {image.path} · {image.state === "bytes-readable" ? "包内字节可读" : image.state}
                    {` · ${receipts.length} 次图片返回 · ${readings.length} 条读图观察`}
                  </summary>
                  <p>固定图片摘要：{image.actualSha256 ?? "尚无可用摘要"}</p>
                  <p>返回图片与模型解释分别记录；历史记录不自动证明当前任务已读。</p>
                  {readings.map((reading) => (
                    <blockquote key={reading.id}>
                      <p>{reading.observations}</p>
                      <p>
                        {reading.actor.kind === "model" ? "模型记录" : reading.actor.kind} ·{" "}
                        {reading.actor.id} · {reading.taskId} · {reading.at}
                      </p>
                    </blockquote>
                  ))}
                </details>
              );
            })}
            {applications.map((application) => (
              <details key={application.id} data-method-application-id={application.id}>
                <summary>实际应用 · {application.taskId}</summary>
                <p>{application.methodSelection}</p>
                <p>{application.applicabilityExplanation}</p>
                <p>
                  不适用条件：
                  {application.nonApplicableConditions.join("；") || "本记录未列附加条件"}
                </p>
                <p>限制：{application.limitations}</p>
                <p>
                  {application.scoringClaim === "partial-indicators-only"
                    ? "仅部分指标，不能作为完整工具总分。"
                    : "本次不计算工具总分。"}
                </p>
                {(project.methodContentOpinions ?? [])
                  .filter((opinion) => opinion.applicationId === application.id)
                  .map((opinion) => (
                    <blockquote key={opinion.id}>
                      <p>研究者 B Agent · {verdict[opinion.verdict]}</p>
                      <p>{opinion.note}</p>
                    </blockquote>
                  ))}
                {(project.methodAdjudications ?? [])
                  .filter((decision) => decision.applicationId === application.id)
                  .map((decision) => (
                    <blockquote key={decision.id}>
                      <p>导师 Agent · {verdict[decision.verdict]}</p>
                      <p>{decision.note}</p>
                    </blockquote>
                  ))}
              </details>
            ))}
          </details>
        );
      })}
    </details>
  );
}
