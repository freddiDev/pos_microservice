import { z } from "zod";

export const catalogRequestSchema = z.object({
  pos_config: z.coerce.number().int().positive().optional(),
  pos_config_odoo_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).default(200),
  cursor: z.string().trim().min(1).optional(),
  snapshot_id: z.string().trim().min(1).optional(),
  updated_after: z.string().trim().min(1).optional(),
  last_update: z.string().trim().min(1).optional(),
  refresh: z.coerce.boolean().default(false)
});

export const barcodeParamsSchema = z.object({
  barcode: z.string().trim().min(1)
});

export const productParamsSchema = z.object({
  productId: z.coerce.number().int().positive()
});

export type CatalogRequest = z.infer<typeof catalogRequestSchema>;
