import { createHash } from "node:crypto";

import { AppConfig } from "./config.js";
import { upstreamError } from "./errors.js";

export type OdooCatalogRequest = {
  pos_config: number;
  offset: number;
  limit: number;
  updated_after?: string;
  barcode?: string;
  product_id?: number;
};

export async function fetchOdooCatalog(
  config: AppConfig,
  odooAccessToken: string,
  payload: OdooCatalogRequest
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.odooBaseUrl}/api/microservice/catalog/products`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${odooAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const body = await safeJson(response);
    const envelope = unwrapJsonRpc(body);
    if (!response.ok || envelope?.success !== true) {
      const message = envelope?.message || "Odoo catalog API rejected request.";
      throw upstreamError(String(message), envelope || body);
    }
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw upstreamError("Odoo catalog API returned invalid data payload.", envelope);
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamError("Odoo catalog request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export type OdooProductImage = {
  contentType: string;
  data: Buffer;
  checksum: string;
  size: number;
  sourceUrl: string;
};

export async function fetchOdooProductImage(
  config: AppConfig,
  odooAccessToken: string,
  productId: number,
  sourceUrl?: string | null
): Promise<OdooProductImage | null> {
  const url = productImageUrl(config, productId, sourceUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${odooAccessToken}`,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      },
      signal: controller.signal
    });

    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) {
      throw upstreamError(`Odoo product image HTTP ${response.status}.`);
    }

    const contentType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > config.catalogImageMaxBytes) {
      throw upstreamError(`Odoo product image is too large: ${contentLength} bytes.`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return null;
    if (data.length > config.catalogImageMaxBytes) {
      throw upstreamError(`Odoo product image is too large: ${data.length} bytes.`);
    }

    return {
      contentType,
      data,
      checksum: createHash("sha256").update(data).digest("hex"),
      size: data.length,
      sourceUrl: url
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamError("Odoo product image request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function productImageUrl(config: AppConfig, productId: number, sourceUrl?: string | null): string {
  const base = new URL(config.odooBaseUrl);
  if (!sourceUrl) {
    return new URL(`/web/image/product.product/${productId}/${config.catalogImageField}`, base).toString();
  }

  try {
    const parsed = new URL(sourceUrl, base);
    const pathname = parsed.pathname.replace(/\/image(?:_\d+)?$/, `/${config.catalogImageField}`);
    return new URL(`${pathname}${parsed.search}`, base).toString();
  } catch {
    return new URL(`/web/image/product.product/${productId}/${config.catalogImageField}`, base).toString();
  }
}

function unwrapJsonRpc(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const data = body as Record<string, unknown>;
  const result = data.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return data;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}
