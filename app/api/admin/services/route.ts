import { adminCatalogPost } from "@/lib/http/admin-catalog-api";
export const runtime = "nodejs";
export async function POST(request: Request) { return adminCatalogPost(request); }
