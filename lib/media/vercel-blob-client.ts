import { del, head } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import type { BlobObjectMetadata, HairstyleImageContentType } from "./hairstyle-image-upload";

export type ClientUploadCallbacks = {
  onBeforeGenerateToken: (
    pathname: string,
    clientPayload: string | null,
    multipart: boolean,
  ) => Promise<{
    allowedContentTypes: HairstyleImageContentType[];
    maximumSizeInBytes: number;
    validUntil: number;
    addRandomSuffix: false;
    allowOverwrite: false;
    tokenPayload: string;
  }>;
  onUploadCompleted: (payload: {
    blob: { url: string; pathname: string; contentType: string };
    tokenPayload?: string | null;
  }) => Promise<void>;
};

export type BlobClientUploadGateway = {
  handle: (input: {
    token: string;
    request: Request;
    body: HandleUploadBody;
    callbacks: ClientUploadCallbacks;
  }) => Promise<{ type: "blob.generate-client-token"; clientToken: string } | { type: "blob.upload-completed"; response: "ok" }>;
  head: (url: string, token: string) => Promise<BlobObjectMetadata>;
  /** Reserved for 3B.2D's durable deletion/reconciliation workflow. */
  delete: (url: string, token: string) => Promise<void>;
};

/** The only module that speaks to Vercel Blob. It is deliberately server-only. */
export const vercelBlobClientGateway: BlobClientUploadGateway = {
  async handle({ token, request, body, callbacks }) {
    return handleUpload({
      token,
      request,
      body,
      onBeforeGenerateToken: callbacks.onBeforeGenerateToken,
      onUploadCompleted: callbacks.onUploadCompleted,
    });
  },
  async head(url, token) {
    const result = await head(url, { token });
    return {
      url: result.url,
      pathname: result.pathname,
      contentType: result.contentType,
      size: result.size,
    };
  },
  async delete(url, token) {
    await del(url, { token });
  },
};
