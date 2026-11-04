import { adminCategoriesPut } from "@/lib/http/admin-catalog-api";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  return adminCategoriesPut(request);
}
