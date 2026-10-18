/**
 * The public Blob origin is configuration, not user input. Keeping this
 * parser separate lets the Next image allowlist and the upload adapter apply
 * exactly the same boundary.
 */
export function parseBlobPublicBaseUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** A delivery URL is renderable only when it is in the configured Blob store. */
export function isApprovedBlobDeliveryUrl(
  value: string | null | undefined,
  publicBaseUrl: string | undefined,
): value is string {
  const origin = parseBlobPublicBaseUrl(publicBaseUrl);
  if (!origin || !value) return false;

  try {
    const parsed = new URL(value);
    return (
      parsed.origin === origin &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname.startsWith("/hairstyles/")
    );
  } catch {
    return false;
  }
}
