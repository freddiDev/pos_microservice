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
  image_url: string | null;
  raw: Record<string, unknown>;
};

export type SyncStateDocument = {
  pos_config_odoo_id: number;
  warehouse_odoo_id: number;
  warehouse_name: string | null;
  product_count: number;
  last_synced_at: Date;
  last_odoo_write_date: string | null;
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
    image_url: toStringOrNull(input.image_url),
    raw: input
  };
}

export function productToApi(document: ProductDocument): Record<string, unknown> {
  return {
    id: document.odoo_product_id,
    name: document.name,
    list_price: document.list_price,
    barcode: document.barcode,
    uom_id: document.uom_id,
    taxes_id: document.taxes_id,
    categ_id: document.categ_id,
    write_date: document.write_date,
    image_url: document.image_url,
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
