import { patchHairstyleMediaApi } from "@/lib/http/admin-hairstyle-media-api";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ hairstyleId: string }> }) {
  const { hairstyleId } = await context.params;
  return patchHairstyleMediaApi(request, hairstyleId);
}
