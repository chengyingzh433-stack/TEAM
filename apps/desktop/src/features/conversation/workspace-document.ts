/** Only Markdown link destinations are interpreted as documents; prose stays untouched. */
export function parseWorkspaceDocument(raw: string, workspacePath: string | null): string | null {
  let path = raw.trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path.startsWith("file://")) {
    try {
      const url = new URL(raw);
      if (url.host && url.host !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || /[\\\u0000-\u001f]/.test(path))
    return null;
  // A fragment identifies a position in an HTML/PDF document, not part of its filename.
  path = path.split("#")[0] ?? "";
  const root = workspacePath?.replace(/\/+$/, "");
  if (path.startsWith("/")) {
    if (!root || !path.startsWith(`${root}/`)) return null;
    path = path.slice(root.length + 1);
  }
  path = path.replace(/^\.\//, "");
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return /\.[\p{L}\d]+$/u.test(path) ? path : null;
}
