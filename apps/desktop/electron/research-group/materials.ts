import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { resolveResearchAddresses } from "./research-dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type {
  ResearchDataset,
  ResearchEvidence,
  ResearchSource,
} from "../../contracts/research-evidence";

export const researchHash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("研究材料清单格式无效。");
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 4000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error("研究材料字段缺失或过长。");
  return v.trim();
};
const identifier = (v: unknown) => {
  const s = text(v, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("材料 ID 仅使用字母、数字、下划线和连字符。");
  return s;
};

async function contained(directory: string, file: string): Promise<string> {
  const base = await realpath(directory),
    target = await realpath(resolve(base, file)),
    part = relative(base, target);
  if (!part || part.startsWith("..") || isAbsolute(part))
    throw new Error("研究材料必须位于指定目录内，不能越界或通过链接读取其他位置。");
  return target;
}
async function limitedFile(file: string, limit: number): Promise<Buffer> {
  if ((await stat(file)).size > limit) throw new Error("研究材料超过读取上限。");
  const data = await readFile(file);
  if (data.length > limit) throw new Error("研究材料超过读取上限。");
  return data;
}
export async function openResearchEvidence(directory?: string): Promise<ResearchEvidence> {
  if (!directory?.trim()) return { directory: "", sources: [], datasets: [] };
  const base = await realpath(directory),
    bytes = await limitedFile(await contained(base, "manifest.json"), 1_000_000),
    manifest = object(JSON.parse(bytes.toString("utf8")));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.datasets) ||
    manifest.sources.length > 40 ||
    manifest.datasets.length > 8
  )
    throw new Error(
      "研究材料清单需要 version=1、sources 和 datasets；最多 40 个来源、8 个数据集。",
    );
  const sources: ResearchSource[] = [];
  for (const raw of manifest.sources) {
    const s = object(raw),
      file = await contained(base, text(s.file)),
      data = await limitedFile(file, 300_000);
    if (!["paper", "dataset", "method", "manuscript", "design"].includes(String(s.kind)))
      throw new Error("无效来源类型。");
    if (
      s.textScope !== undefined &&
      !["metadata", "abstract", "partial-text", "full-text"].includes(String(s.textScope))
    )
      throw new Error("来源文本范围无效。");
    sources.push({
      id: identifier(s.id),
      title: text(s.title, 1000),
      authors: text(s.authors, 2000),
      year: text(s.year, 40),
      url: text(s.url),
      file,
      sha256: researchHash(data),
      kind: s.kind as ResearchSource["kind"],
      access: "provided-text",
      ...(s.textScope ? { textScope: s.textScope as ResearchSource["textScope"] } : {}),
    });
  }
  if (new Set(sources.map((s) => s.id)).size !== sources.length) throw new Error("来源 ID 重复。");
  const datasets: ResearchDataset[] = [];
  for (const raw of manifest.datasets) {
    const d = object(raw),
      file = await contained(base, text(d.file)),
      data = await limitedFile(file, 10_000_000);
    if (
      !["observed", "synthetic"].includes(String(d.dataKind)) ||
      !["public", "user-authorized"].includes(String(d.permission)) ||
      ![",", ";", "\t"].includes(String(d.delimiter))
    )
      throw new Error("请声明数据为实测或合成、使用许可及 CSV 分隔符。");
    const sourceId = identifier(d.sourceId);
    if (!sources.some((s) => s.id === sourceId)) throw new Error("数据集缺少已登记的出处。");
    datasets.push({
      id: identifier(d.id),
      file,
      sha256: researchHash(data),
      description: text(d.description),
      sourceId,
      dataKind: d.dataKind as ResearchDataset["dataKind"],
      permission: d.permission as ResearchDataset["permission"],
      delimiter: d.delimiter as ResearchDataset["delimiter"],
    });
  }
  if (new Set(datasets.map((d) => d.id)).size !== datasets.length)
    throw new Error("数据集 ID 重复。");
  return { directory: base, manifestSha256: researchHash(bytes), sources, datasets };
}
export async function readPinnedResearchFile(
  entry: { file: string; sha256: string },
  limit = 300_000,
): Promise<string> {
  const data = await limitedFile(entry.file, limit);
  if (researchHash(data) !== entry.sha256)
    throw new Error("研究原文或数据已变化，请保留当前成果后开启新输入版本重新锁定材料。");
  return data.toString("utf8");
}
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");
blockedV6.addSubnet("3fff::", 20, "ipv6");
export function isPublicResearchAddress(address: string): boolean {
  return isIP(address) === 4
    ? !blockedV4.check(address, "ipv4")
    : isIP(address) === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}
async function publicFetch(url: string): Promise<{ url: string; text: string }> {
  let target = new URL(url);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      (target.port && target.port !== "443") ||
      /(^localhost$|\.(local|internal)$)/i.test(target.hostname)
    )
      throw new Error("仅支持公开 HTTPS 来源。");
    const addresses = await resolveResearchAddresses(target.hostname.replace(/^\[|\]$/g, ""));
    if (!addresses.length || addresses.some((a) => !isPublicResearchAddress(a.address)))
      throw new Error("不能将本机或内网地址作为研究来源。");
    // Pin the checked DNS result to the connection; redirects get a new validation.
    const response = await new Promise<{ status: number; location?: string; text: string }>(
      (resolve, reject) => {
        const req = request(
          target,
          {
            agent: false,
            signal: AbortSignal.timeout(15_000),
            lookup: (_hostname, options, callback) => {
              const chosen = addresses[0]!;
              if (options.all) callback(null, [chosen]);
              else callback(null, chosen.address, chosen.family);
            },
            headers: {
              "User-Agent": "Lancer-Research/1.0",
              Accept: "text/html,text/plain,application/json",
            },
          },
          (res) => {
            void (async () => {
              const status = res.statusCode ?? 0;
              if ([301, 302, 303, 307, 308].includes(status)) {
                res.destroy();
                resolve({ status, location: res.headers.location, text: "" });
                return;
              }
              if (status < 200 || status >= 300) throw new Error(`来源请求失败：${status}`);
              if (!/text\/|application\/json/.test(res.headers["content-type"] ?? ""))
                throw new Error("此来源不是可读取网页正文；PDF/扫描件请先提供提取后的原文文本。");
              let size = 0;
              const chunks: Buffer[] = [];
              for await (const raw of res) {
                const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
                size += chunk.length;
                if (size > 2_000_000) throw new Error("来源正文过大，请提供所需原文文本。");
                chunks.push(chunk);
              }
              resolve({ status, text: Buffer.concat(chunks).toString("utf8") });
            })().catch((error: unknown) => {
              res.destroy();
              reject(error);
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location) throw new Error("来源重定向无效。");
      target = new URL(response.location, target);
      continue;
    }
    return { url: target.toString(), text: response.text };
  }
  throw new Error("来源重定向次数过多。");
}
export async function searchResearchSources(query: string): Promise<unknown> {
  const { text: body } = await publicFetch(
    `https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(query.slice(0, 300))}`,
  );
  const data = object(JSON.parse(body)),
    message = object(data.message);
  return {
    warning: "以下只有候选元数据，不代表已经读取原文。",
    candidates: (Array.isArray(message.items) ? message.items : []).map((raw) => {
      const item = object(raw);
      return {
        doi: item.DOI,
        title: item.title,
        author: item.author,
        published: item.published,
        url: item.URL,
        links: item.link,
      };
    }),
  };
}
export async function retrieveResearchSource(
  input: Record<string, unknown>,
  directory: string,
): Promise<ResearchSource> {
  const response = await publicFetch(text(input.url)),
    cleaned = response.text
      .replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  if (
    cleaned.length < 300 ||
    /checking your browser|verify you are human|captcha/i.test(cleaned.slice(0, 600))
  )
    throw new Error("未取得可读研究正文；请提供原文文本，不能将验证页面登记为论文。");
  if (cleaned.length > 180_000) throw new Error("网页正文过长，请提供提取后的所需原文。");
  const id = `SRC-${randomUUID()}`,
    file = join(directory, "sources", `${id}.txt`);
  await mkdir(join(directory, "sources"), { recursive: true });
  await writeFile(file, cleaned, { flag: "wx" });
  return {
    id,
    title: text(input.title, 1000),
    authors: text(input.authors, 2000),
    year: text(input.year, 40),
    url: response.url,
    file,
    sha256: researchHash(cleaned),
    kind: "paper",
    access: "retrieved-text",
  };
}
