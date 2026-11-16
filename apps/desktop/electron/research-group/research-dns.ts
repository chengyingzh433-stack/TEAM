import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

/** Some system VPN resolvers synthesize benchmark addresses. These never become public IPs. */
export function isResearchProxyAddress(address: string): boolean {
  const octets = address.split(".");
  return isIP(address) === 4 && octets[0] === "198" && ["18", "19"].includes(octets[1]!);
}
export function decodeResearchDohAddresses(value: unknown, hostname: string): LookupAddress[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("HTTPS DNS 响应无效。");
  const data = value as Record<string, unknown>;
  const normalize = (name: string) => name.toLowerCase().replace(/\.$/, "");
  if (
    data.Status !== 0 ||
    !Array.isArray(data.Question) ||
    data.Question.length !== 1 ||
    !data.Question.some((question: unknown) => {
      if (!question || typeof question !== "object" || Array.isArray(question)) return false;
      const row = question as Record<string, unknown>;
      return (
        row.type === 1 &&
        typeof row.name === "string" &&
        normalize(row.name) === normalize(hostname)
      );
    }) ||
    !Array.isArray(data.Answer) ||
    data.Answer.length > 64
  )
    throw new Error("HTTPS DNS 未确认所请求的公开域名。");
  const addresses: LookupAddress[] = [];
  const answers: unknown[] = data.Answer;
  for (const value of answers) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const answer = value as Record<string, unknown>;
    if (answer.type !== 1) continue;
    const address = answer.data;
    if (typeof address !== "string" || isIP(address) !== 4)
      throw new Error("HTTPS DNS 的地址无效。");
    if (!addresses.some((row) => row.address === address)) addresses.push({ address, family: 4 });
  }
  if (!addresses.length) throw new Error("HTTPS DNS 未返回可检查的域名地址。");
  return addresses;
}
/** The caller still rejects every non-public result and pins checked IPs to each HTTPS connection. */
export async function resolveResearchAddresses(hostname: string): Promise<LookupAddress[]> {
  const system = await lookup(hostname, { all: true });
  if (
    isIP(hostname) ||
    !system.length ||
    !system.every((row) => isResearchProxyAddress(row.address))
  )
    return system;
  // A fixed TLS-authenticated resolver receives only the requested hostname, never research text.
  // It is used solely for proxy benchmark placeholders; localhost/private answers are never bypassed.
  const endpoint = new URL("https://cloudflare-dns.com/dns-query");
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", "A");
  const response = await fetch(endpoint, {
    headers: { accept: "application/dns-json" },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (
    !response.ok ||
    !/application\/(?:dns-json|json)/i.test(response.headers.get("content-type") ?? "")
  )
    throw new Error("系统代理返回测试网段，HTTPS DNS 无法取得真实公开地址；本次访问未成功。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("HTTPS DNS 响应正文缺失。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error("HTTPS DNS 响应字节无效。");
      size += value.length;
      if (size > 65536) throw new Error("HTTPS DNS 响应过大。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return decodeResearchDohAddresses(JSON.parse(Buffer.concat(chunks).toString("utf8")), hostname);
}
