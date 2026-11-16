import { expect, test } from "@playwright/test";
import { parseWorkspaceDocument } from "../../src/features/conversation/workspace-document";

test("document links resolve Chinese, spaces, local file URLs and absolute workspace paths", () => {
  for (const link of [
    "精读资料/完整 文档.docx",
    "./精读资料/完整%20文档.docx",
    "/repo/精读资料/完整 文档.docx",
    "file:///repo/%E7%B2%BE%E8%AF%BB%E8%B5%84%E6%96%99/%E5%AE%8C%E6%95%B4%20%E6%96%87%E6%A1%A3.docx",
  ])
    expect(parseWorkspaceDocument(link, "/repo")).toBe("精读资料/完整 文档.docx");
  expect(parseWorkspaceDocument("report.html#summary", "/repo")).toBe("report.html");
});

test("document recognition does not turn remote protocols, anchors or escaping paths into local files", () => {
  for (const link of [
    "https://example.com/report.pdf",
    "mailto:a@example.com",
    "javascript:alert(1)",
    "data:text/html,foo",
    "file://example.com/report.pdf",
    "//example.com/report.pdf",
    "../private.pdf",
    "%2E%2E/private.pdf",
    "/other/report.pdf",
    "/repo-other/report.pdf",
    "report%00.pdf",
    "folder\\report.pdf",
    "%xx.pdf",
    "#summary",
    "",
  ])
    expect(parseWorkspaceDocument(link, "/repo"), link).toBeNull();
});
