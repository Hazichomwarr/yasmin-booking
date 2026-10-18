import { removeHairstyleImageApi } from "@/lib/http/admin-hairstyle-media-removal-api";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ hairstyleId: string; mediaId: string }> },
) {
  const { hairstyleId, mediaId } = await context.params;
  return removeHairstyleImageApi(request, hairstyleId, mediaId);
}
