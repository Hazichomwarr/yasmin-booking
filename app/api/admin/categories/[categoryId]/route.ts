import { adminCategoryPatch } from "@/lib/http/admin-catalog-api";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ categoryId: string }> },
) {
  return adminCategoryPatch(request, (await context.params).categoryId);
}
