export type ProductDocument = {
  odoo_product_id: number;
  odoo_template_id: number | null;
  warehouse_odoo_id: number;
  warehouse_name: string | null;
  cv_odoo_id: number | null;
  cv_name: string | null;
  product_cv_line_id: number | null;
  name: string;
  list_price: number;
  barcode: string | null;
  uom_id: number | null;
  taxes_id: unknown[];
  categ_id: number | null;
  write_date: string | null;
  image_write_date?: string | null;
  image_url: string | null;
  has_image?: boolean;
  image_hash?: string | null;
  image_content_type?: string | null;
  image_synced_at?: Date | null;
  raw: Record<string, unknown>;
};

export type ProductSnapshotDocument = ProductDocument & {
  snapshot_id: string;
  pos_config_odoo_id: number;
};

export type ProductImageDocument = {
  odoo_product_id: number;
  warehouse_odoo_id: number;
  content_type: string;
  data: Buffer;
  checksum: string;
  size: number;
  source_url: string;
  source_write_date: string | null;
  synced_at: Date;
  missing?: boolean;
};

export type SyncStateDocument = {
  pos_config_odoo_id: number;
  warehouse_odoo_id: number;
  warehouse_name: string | null;
  product_count: number;
  last_synced_at: Date;
  last_odoo_write_date: string | null;
  last_odoo_image_write_date?: string | null;
  source_fingerprint?: string | null;
  active_snapshot_id?: string | null;
  sync_status?: "running" | "complete" | "failed";
  source_total?: number;
  last_run_id?: string | null;
  last_run_started_at?: Date | null;
  last_run_completed_at?: Date | null;
  last_error?: string | null;
  image_sync_status?: "disabled" | "pending" | "running" | "complete" | "failed";
  image_sync_snapshot_id?: string | null;
  image_sync_revision?: string | null;
  image_sync_started_at?: Date | null;
  image_sync_completed_at?: Date | null;
  image_sync_total?: number;
  image_synced_count?: number;
  image_failed_count?: number;
  image_sync_error?: string | null;
};

export function normalizeProduct(input: Record<string, unknown>): ProductDocument {
  const id = toNumber(input.id);
  const warehouseId = toNumber(input.warehouse_id);
  if (!id || !warehouseId) {
    throw new Error("Product requires id and warehouse_id.");
  }

  return {
    odoo_product_id: id,
    odoo_template_id: toNumber(input.product_tmpl_id),
    warehouse_odoo_id: warehouseId,
    warehouse_name: toStringOrNull(input.warehouse_name),
    cv_odoo_id: toNumber(input.cv_id),
    cv_name: toStringOrNull(input.cv_name),
    product_cv_line_id: toNumber(input.product_cv_line_id),
    name: toStringOrNull(input.name) || `Product ${id}`,
    list_price: toNumber(input.list_price) || 0,
    barcode: toStringOrNull(input.barcode),
    uom_id: toNumber(input.uom_id),
    taxes_id: Array.isArray(input.taxes_id) ? input.taxes_id : [],
    categ_id: toNumber(input.categ_id),
    write_date: toStringOrNull(input.write_date),
    image_write_date: toStringOrNull(input.image_write_date) || toStringOrNull(input.write_date),
    image_url: toStringOrNull(input.image_url),
    raw: input
  };
}

export function productToApi(document: ProductDocument, apiPrefix = "/api/v1"): Record<string, unknown> {
  // Odoo metadata can arrive before the worker has stored the image bytes.
  // The mobile client must only request an image that the service can serve.
  const imageReady = Boolean(document.has_image && document.image_hash && document.image_synced_at);

  return {
    id: document.odoo_product_id,
    name: document.name,
    list_price: document.list_price,
    barcode: document.barcode,
    uom_id: document.uom_id,
    taxes_id: document.taxes_id,
    categ_id: document.categ_id,
    write_date: document.write_date,
    image_url: imageReady ? `${apiPrefix}/catalog/products/${document.odoo_product_id}/image` : null,
    has_image: imageReady,
    image_hash: imageReady ? document.image_hash : null,
    product_tmpl_id: document.odoo_template_id,
    warehouse_id: document.warehouse_odoo_id,
    warehouse_name: document.warehouse_name,
    cv_id: document.cv_odoo_id,
    cv_name: document.cv_name,
    product_cv_line_id: document.product_cv_line_id
  };
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

export function toStringOrNull(value: unknown): string | null {
  if (value === false || value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}
