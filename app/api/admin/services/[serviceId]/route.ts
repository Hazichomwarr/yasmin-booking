import { adminCatalogPatch } from "@/lib/http/admin-catalog-api";
export const runtime = "nodejs";
export async function PATCH(request: Request, ctx: { params: Promise<{ serviceId: string }> }) { return adminCatalogPatch(request, (await ctx.params).serviceId); }
