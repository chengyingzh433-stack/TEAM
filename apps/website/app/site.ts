export const SITE_NAME = "TEAM";
const repository =
  process.env.NEXT_PUBLIC_LANCER_GITHUB_URL?.replace(/\/$/, "") ??
  "https://github.com/chengyingzh433-stack/TEAM";
export const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository)
  ? repository
  : "";
const origin = process.env.NEXT_PUBLIC_LANCER_SITE_URL ?? "";
export const SITE_URL = /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(origin)
  ? origin
  : "http://localhost:3000";
export const SITE_PUBLISHED = SITE_URL.startsWith("https:") && Boolean(GITHUB_URL);
export const RELEASES_AVAILABLE =
  Boolean(GITHUB_URL) && process.env.NEXT_PUBLIC_LANCER_RELEASES_AVAILABLE === "true";
export const RELEASES_URL = RELEASES_AVAILABLE ? `${GITHUB_URL}/releases` : "#install";
export const PI_URL = "https://github.com/earendil-works/pi";
export const UPSTREAM_URL = "https://github.com/minghinmatthewlam/pi-gui";
export const OG_IMAGE_PATH = "/team-icon.png";
export const OG_IMAGE_ALT = "TEAM research assistance";
export const OG_IMAGE_WIDTH = 1024;
export const OG_IMAGE_HEIGHT = 1024;
export const SITE_TITLE = "TEAM: a research assistance workspace";
export const SITE_DESCRIPTION =
  "TEAM supports research discussion, materials, independent review and traceable delivery with Pi. Source beta; user interface and real-model acceptance remain pending.";
export const SITE_SOCIAL_DESCRIPTION =
  "Research discussion and traceable delivery. TEAM source beta.";
