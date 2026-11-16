import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeResearchStudyFixture(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "source-a.txt"),
    "合成研究来源 A。六个演练观测用于验证计算与交接。样本不能支持真实学校的效果或因果结论。这里的来源仅用于本地程序验收，不是真实论文。",
  );
  await writeFile(
    join(directory, "source-b.txt"),
    "合成研究来源 B。明确区分相关、预测和因果，使用已冻结的变量与方法；记录完整案例、系数及研究局限。此材料不是实际发表的研究。",
  );
  await writeFile(join(directory, "data.csv"), "x,y\n0,1\n1,3\n2,5\n3,7\n4,9\n5,11\n");
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: ["A", "B"].map((id) => ({
        id: `FIXTURE-${id}`,
        title: `合成来源${id}`,
        authors: "测试作者",
        year: "2026",
        url: `https://example.test/${id}`,
        file: `source-${id.toLowerCase()}.txt`,
        kind: "paper",
      })),
      datasets: [
        {
          id: "FIXTURE-DATA",
          file: "data.csv",
          description: "明确标注的六行合成演练数据。",
          sourceId: "FIXTURE-A",
          dataKind: "synthetic",
          permission: "user-authorized",
          delimiter: ",",
        },
      ],
    }),
  );
}
