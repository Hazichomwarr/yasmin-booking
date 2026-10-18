import type { NextConfig } from "next";

import { parseBlobPublicBaseUrl } from "./lib/media/blob-public-origin";

const blobPublicBaseUrl = parseBlobPublicBaseUrl(process.env.BLOB_PUBLIC_BASE_URL);

const nextConfig: NextConfig = {
  images: {
    // No configured public store means no remote host is trusted. Public UI
    // falls back to its local artwork in that case.
    remotePatterns: blobPublicBaseUrl
      ? [{ protocol: "https", hostname: new URL(blobPublicBaseUrl).hostname, pathname: "/hairstyles/**" }]
      : [],
  },
};

export default nextConfig;
