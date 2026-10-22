import { adminHomepageFeaturesPut } from "@/lib/http/admin-homepage-features-api";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  return adminHomepageFeaturesPut(request);
}
