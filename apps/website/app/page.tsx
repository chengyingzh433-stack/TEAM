import { CopyCommand } from "./components/copy-command";
import { DownloadButton } from "./components/download-button";
import {
  GITHUB_URL,
  OG_IMAGE_PATH,
  PI_URL,
  RELEASES_URL,
  RELEASES_AVAILABLE,
  UPSTREAM_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "./site";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "EducationalApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  sameAs: GITHUB_URL ? [GITHUB_URL] : [],
  image: `${SITE_URL}${OG_IMAGE_PATH}`,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

const features = [
  {
    title: "Guided discussion",
    body: "Answer freely, ask follow-up questions, and distinguish exploratory ideas from formal instructions.",
  },
  {
    title: "Four continuing roles",
    body: "A mentor, researcher A, independent reviewer B and librarian retain their own sessions. You remain the final decision maker.",
  },
  {
    title: "Materials and evidence",
    body: "Connect your own methods library and authorized research materials; retain sources, gaps and failed attempts.",
  },
  {
    title: "Versioned delivery",
    body: "Export Word, Markdown and HTML from the same manuscript version, with provenance and a portable research archive.",
  },
  {
    title: "Recovery and usage",
    body: "Track known usage and unknown outcomes. Preserve original records rather than automatically replaying uncertain requests.",
  },
  {
    title: "Pi compatibility",
    body: "Install the locked Pi SDK with the app. Existing Pi users can point TEAM at their agent directory after making a backup.",
  },
] as const;

const installs = [
  {
    platform: "macOS",
    detail: "Apple Silicon · development build checked; functional acceptance pending",
    steps:
      "Build from source with Node 24, pnpm 10.34.9 and Xcode Command Line Tools. Local installation uses your configured persistent signing certificate; public notarization is a separate release gate.",
    command: "pnpm install --frozen-lockfile && pnpm doctor && pnpm dev",
  },
  {
    platform: "Linux",
    detail: "Packaging target · validation in progress",
    steps:
      "AppImage and Debian packaging are supported by the build configuration. Native UI and platform-specific features require separate validation.",
  },
  {
    platform: "Windows",
    detail: "Packaging target · validation in progress",
    steps:
      "Installer and portable targets are configured. Doubao App takeover currently requires macOS accessibility support.",
  },
] as const;

const faqs = [
  {
    q: "What is pi?",
    a: (
      <>
        <a href={PI_URL}>pi</a> is an open source coding agent that runs in your terminal. TEAM is a
        desktop app on top of it: sessions, models, tools and auth all run through pi itself.
      </>
    ),
  },
  {
    q: "Does it cost anything?",
    a: "Application code retains the MIT license. Bundled guidance has separate licenses, including CC BY-NC 4.0. Bring your own model account; provider charges may apply.",
  },
  {
    q: "Can I keep using the pi CLI?",
    a: "TEAM uses a locked Pi SDK and can share the default agent directory. Back up existing data and check version compatibility; do not operate the same active session concurrently.",
  },
  {
    q: "Where do my research materials go?",
    a: "TEAM runs on your machine. Prompts and attachments are sent to your configured model provider. Agent tools, extensions and Doubao may contact other services; inspect the requested actions and keep credentials out of shared recordings.",
  },
  {
    q: "How do updates work?",
    a: "Use the TEAM repository and its source releases. This beta has no signed desktop installer or automatic upstream updates.",
  },
] as const;

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Logo() {
  return (
    <a className="logo" href="#top" aria-label="TEAM home">
      <img src="/icon.svg" alt="" width={24} height={24} />
      <span>TEAM</span>
    </a>
  );
}

export default function Page() {
  return (
    <>
      <header className="nav">
        <div className="nav__inner">
          <Logo />
          <nav className="nav__links" aria-label="Main">
            <a href="#features">Features</a>
            <a href="#install">Install</a>
            <a href="#faq">FAQ</a>
            <a href={GITHUB_URL || "#install"} className="nav__github">
              <GitHubIcon />
              {GITHUB_URL ? "GitHub" : "Release status"}
            </a>
          </nav>
          <DownloadButton className="button button--primary button--small" />
        </div>
      </header>

      <main id="top">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
        />

        <section className="hero">
          <div className="container">
            <a className="hero__badge" href={RELEASES_URL}>
              TEAM 1.1.0-beta.1 · source beta
              <span aria-hidden="true">→</span>
            </a>
            <h1>A workspace for research assistance</h1>
            <p className="hero__lede">
              Explore ideas with a mentor, researchers A and B, and a librarian. You initiate the
              research and make the final decisions. Keep materials, discussions and versions
              together.
            </p>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL || "#install"}>
                {GITHUB_URL ? "View on GitHub" : "Release in preparation"}
              </a>
            </div>
            <p className="hero__note">Built on pi-gui and pi. Bring your own model account.</p>
          </div>
        </section>

        <section id="features" className="grid-section">
          <div className="container">
            <h2 className="section-title">Research and collaboration</h2>
            <div className="feature-grid">
              {features.map((feature) => (
                <div key={feature.title} className="feature-grid__item">
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="install" className="install">
          <div className="container">
            <h2 className="section-title">Install TEAM</h2>
            <p className="section-lede">
              {RELEASES_AVAILABLE ? (
                <a href={RELEASES_URL}>View published TEAM releases</a>
              ) : (
                "Prebuilt installers are not available yet; source is on GitHub."
              )}{" "}
              Connect a provider under Settings, add a project folder and start a conversation.
            </p>
            <div className="install__grid">
              {installs.map((item) => (
                <div key={item.platform} className="install__card">
                  <h3>{item.platform}</h3>
                  <p className="install__detail">{item.detail}</p>
                  <p>{item.steps}</p>
                  {"command" in item ? <CopyCommand command={item.command} /> : null}
                </div>
              ))}
            </div>
            <p className="install__source">
              {GITHUB_URL ? (
                <a href={`${GITHUB_URL}/blob/main/docs/team-install.md`}>
                  Read the source installation guide
                </a>
              ) : (
                "The repository address will be added before release. The commands above apply to an existing source checkout."
              )}
            </p>
          </div>
        </section>

        <section id="faq" className="faq">
          <div className="container container--narrow">
            <h2 className="section-title">Questions</h2>
            {faqs.map((item) => (
              <details key={item.q} className="faq__item">
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing">
          <div className="container">
            <h2>Bring your ideas to the team</h2>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL || "#install"}>
                {GITHUB_URL ? "View on GitHub" : "Release in preparation"}
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <Logo />
          <nav className="footer__links" aria-label="Footer">
            <a href={GITHUB_URL || "#install"}>{GITHUB_URL ? "GitHub" : "Release status"}</a>
            <a href={RELEASES_URL}>Releases</a>
            <a href={PI_URL}>pi</a>
            <a
              href={
                GITHUB_URL ? `${GITHUB_URL}/blob/main/LICENSE` : `${UPSTREAM_URL}/blob/main/LICENSE`
              }
            >
              Code license · upstream credits
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
