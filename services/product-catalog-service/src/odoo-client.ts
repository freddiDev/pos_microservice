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
