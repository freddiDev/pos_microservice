import { AppConfig } from "./config.js";
import { upstreamError } from "./errors.js";

export type OdooMemberRequest = {
  offset: number;
  limit: number;
  updated_after?: string;
  query?: string;
  partner_id?: number;
  include_inactive?: boolean;
};

export async function fetchOdooMembers(
  config: AppConfig,
  odooAccessToken: string,
  payload: OdooMemberRequest
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.odooRequestTimeoutMs);
  try {
    const response = await fetch(`${config.odooBaseUrl}/api/microservice/members`, {
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
      const message = envelope?.message || "Odoo members API rejected request.";
      throw upstreamError(String(message), envelope || body);
    }
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw upstreamError("Odoo members API returned invalid data payload.", envelope);
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamError("Odoo members request timed out.");
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
