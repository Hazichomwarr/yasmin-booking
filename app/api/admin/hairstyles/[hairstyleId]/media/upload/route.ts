import { handleHairstyleImageUploadApi } from "@/lib/http/admin-hairstyle-media-upload-api";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ hairstyleId: string }> }) {
  const { hairstyleId } = await context.params;
  return handleHairstyleImageUploadApi(request, hairstyleId);
}
