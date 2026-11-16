import { RELEASES_URL, RELEASES_AVAILABLE } from "../site";

export function DownloadButton({ className }: { readonly className?: string }) {
  return (
    <a className={className} href={RELEASES_URL}>
      {RELEASES_AVAILABLE ? "Source releases" : "Source installation"}
    </a>
  );
}
