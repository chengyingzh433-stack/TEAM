import { test, expect } from "@playwright/test";
import {
  isResearchProxyAddress,
  decodeResearchDohAddresses,
} from "../../electron/research-group/research-dns";
import { isPublicResearchAddress } from "../../electron/research-group/materials";

test("proxy benchmark placeholders remain blocked and only a matching resolver question supplies checked candidates", () => {
  for (const address of ["198.18.0.186", "198.19.255.254"]) {
    expect(isResearchProxyAddress(address)).toBe(true);
    expect(isPublicResearchAddress(address)).toBe(false);
  }
  for (const address of ["127.0.0.1", "192.168.1.1", "10.0.0.1", "169.254.169.254", "::1"]) {
    expect(isResearchProxyAddress(address)).toBe(false);
    expect(isPublicResearchAddress(address)).toBe(false);
  }
  const response = {
    Status: 0,
    Question: [{ name: "api.crossref.org", type: 1 }],
    Answer: [{ name: "api.crossref.org", type: 1, data: "3.223.202.196" }],
  };
  expect(decodeResearchDohAddresses(response, "API.CROSSREF.ORG.")).toEqual([
    { address: "3.223.202.196", family: 4 },
  ]);
  expect(() => decodeResearchDohAddresses(response, "other.example")).toThrow(/未确认/);
  expect(() =>
    decodeResearchDohAddresses({ ...response, Status: 3 }, "api.crossref.org"),
  ).toThrow();
  expect(() =>
    decodeResearchDohAddresses({ ...response, Answer: [] }, "api.crossref.org"),
  ).toThrow();
  const privateAnswer = decodeResearchDohAddresses(
    { ...response, Answer: [{ type: 1, data: "127.0.0.1" }] },
    "api.crossref.org",
  );
  expect(privateAnswer.some((row) => !isPublicResearchAddress(row.address))).toBe(true);
});
