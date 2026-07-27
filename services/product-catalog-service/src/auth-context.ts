import { AppConfig } from "./config.js";
import { unauthorized, upstreamError } from "./errors.js";

export type AuthContext = {
  user_id: string;
  device_id: string;
  odoo_user_id: number;
  login: string;
  name: string;
  role: string;
  company_odoo_id: number | null;
  warehouse_odoo_id: number | null;
  pos_config_odoo_id: number | null;
  device_code: string;
  odoo_access_token: string;
};

export async function resolveAuthContext(config: AppConfig, authorization?: string): Promise<AuthContext> {
  const bearer = authorization?.trim();
  if (!bearer?.toLowerCase().startsWith("bearer ")) {
    throw unauthorized("Bearer token is required.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.authServiceUrl}${config.apiPrefix}/internal/auth/context`, {
      method: "GET",
      headers: {
        Authorization: bearer,
        "X-Internal-Service-Key": config.internalServiceKey
      },
      signal: controller.signal
    });
    if (response.status === 401) {
      throw unauthorized("Invalid bearer token.");
    }
    if (!response.ok) {
      throw upstreamError("Auth service rejected context lookup.", await safeJson(response));
    }
    return (await response.json()) as AuthContext;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw upstreamError("Auth service context lookup timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}
