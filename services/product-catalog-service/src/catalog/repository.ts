import { Filter } from "mongodb";

import { CatalogCollections } from "../db.js";
import { normalizeProduct, ProductDocument, productToApi, SyncStateDocument, toNumber } from "./normalizers.js";

export type ProductListOptions = {
  warehouseId: number;
  offset: number;
  limit: number;
  updatedAfter?: string;
};

export class ProductCatalogRepository {
  constructor(private readonly collections: CatalogCollections) {}

  async upsertSnapshot(posConfigId: number, snapshot: Record<string, unknown>): Promise<SyncStateDocument> {
    const productItems = extractItems(snapshot.products);
    const products = productItems.map(normalizeProduct);
    const warehouseId = resolveWarehouseId(snapshot, products);
    const warehouseName = resolveWarehouseName(snapshot, products);

    await Promise.all([
      this.upsertProducts(products),
      this.upsertSimpleCollection(this.collections.categories, snapshot.categories, "odoo_id"),
      this.upsertSimpleCollection(this.collections.uoms, snapshot.uoms, "odoo_id"),
      this.upsertSimpleCollection(this.collections.taxes, snapshot.taxes, "odoo_id"),
      this.upsertSimpleCollection(this.collections.categoryCv, snapshot.category_cv, "id"),
      this.upsertSimpleCollection(this.collections.productCvs, snapshot.product_cvs, "id"),
      this.upsertSimpleCollection(this.collections.productTemplateCv, snapshot.product_template_cv, "id")
    ]);

    const state: SyncStateDocument = {
      pos_config_odoo_id: posConfigId,
      warehouse_odoo_id: warehouseId,
      warehouse_name: warehouseName,
      product_count: products.length,
      last_synced_at: new Date(),
      last_odoo_write_date: latestWriteDate(products)
    };

    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId },
      { $set: state },
      { upsert: true }
    );
    return state;
  }

  async syncState(posConfigId: number): Promise<SyncStateDocument | null> {
    return this.collections.syncState.findOne({ pos_config_odoo_id: posConfigId }, { projection: { _id: 0 } });
  }

  async listProducts(options: ProductListOptions): Promise<Record<string, unknown>> {
    const filter: Filter<ProductDocument> = { warehouse_odoo_id: options.warehouseId };
    if (options.updatedAfter) {
      filter.write_date = { $gt: options.updatedAfter };
    }

    const [items, total] = await Promise.all([
      this.collections.products
        .find(filter, { projection: { _id: 0, raw: 0 } })
        .sort({ write_date: 1, odoo_product_id: 1 })
        .skip(options.offset)
        .limit(options.limit)
        .toArray(),
      this.collections.products.countDocuments(filter)
    ]);

    return {
      items: items.map(productToApi),
      offset: options.offset,
      limit: options.limit,
      total,
      has_more: options.offset + options.limit < total
    };
  }

  async findByBarcode(warehouseId: number, barcode: string): Promise<Record<string, unknown> | null> {
    const document = await this.collections.products.findOne(
      { warehouse_odoo_id: warehouseId, barcode },
      { projection: { _id: 0, raw: 0 } }
    );
    return document ? productToApi(document) : null;
  }

  async findByOdooId(warehouseId: number, productId: number): Promise<Record<string, unknown> | null> {
    const document = await this.collections.products.findOne(
      { warehouse_odoo_id: warehouseId, odoo_product_id: productId },
      { projection: { _id: 0, raw: 0 } }
    );
    return document ? productToApi(document) : null;
  }

  private async upsertProducts(products: ProductDocument[]): Promise<void> {
    if (!products.length) return;
    await this.collections.products.bulkWrite(
      products.map((product) => ({
        updateOne: {
          filter: {
            odoo_product_id: product.odoo_product_id,
            warehouse_odoo_id: product.warehouse_odoo_id
          },
          update: { $set: product },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  private async upsertSimpleCollection(
    collection: CatalogCollections[keyof CatalogCollections],
    source: unknown,
    idField: "id" | "odoo_id"
  ): Promise<void> {
    const items = normalizeSimpleItems(source, idField);
    if (!items.length) return;
    await collection.bulkWrite(
      items.map((item) => ({
        updateOne: {
          filter: item.filter,
          update: { $set: item.document },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }
}

function extractItems(source: unknown): Record<string, unknown>[] {
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const items = (source as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function normalizeSimpleItems(source: unknown, idField: "id" | "odoo_id") {
  if (!Array.isArray(source)) return [];
  return source
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const odooId = toNumber(item.id);
      if (!odooId) return null;
      const warehouseId = toNumber(item.warehouse_id);
      const categoryId = toNumber(item.category_id);
      const templateId = toNumber(item.product_tmpl_id);
      const document = {
        ...item,
        odoo_id: odooId,
        warehouse_odoo_id: warehouseId,
        category_odoo_id: categoryId,
        odoo_template_id: templateId
      };
      const filter: Record<string, number> = idField === "odoo_id" ? { odoo_id: odooId } : { id: odooId };
      if (warehouseId && categoryId) {
        filter.category_odoo_id = categoryId;
        filter.warehouse_odoo_id = warehouseId;
      } else if (warehouseId && templateId) {
        filter.odoo_template_id = templateId;
        filter.warehouse_odoo_id = warehouseId;
      } else if (warehouseId) {
        filter.odoo_id = odooId;
        filter.warehouse_odoo_id = warehouseId;
      }
      return { filter, document };
    })
    .filter(Boolean) as { filter: Record<string, number>; document: Record<string, unknown> }[];
}

function resolveWarehouseId(snapshot: Record<string, unknown>, products: ProductDocument[]): number {
  const config = snapshot.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const value = toNumber((config as Record<string, unknown>).warehouse_id);
    if (value) return value;
  }
  const first = products[0]?.warehouse_odoo_id;
  if (first) return first;
  throw new Error("Catalog snapshot does not contain warehouse information.");
}

function resolveWarehouseName(snapshot: Record<string, unknown>, products: ProductDocument[]): string | null {
  const config = snapshot.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>).warehouse_name;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return products[0]?.warehouse_name || null;
}

function latestWriteDate(products: ProductDocument[]): string | null {
  return products
    .map((product) => product.write_date)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
}
