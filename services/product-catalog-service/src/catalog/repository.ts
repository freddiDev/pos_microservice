import { Filter } from "mongodb";

import { CatalogCollections } from "../db.js";
import {
  normalizeProduct,
  ProductDocument,
  ProductImageDocument,
  productToApi,
  SyncStateDocument,
  toNumber
} from "./normalizers.js";

export type ProductListOptions = {
  posConfigId?: number;
  warehouseId: number;
  offset: number;
  limit: number;
  updatedAfter?: string;
};

export class ProductCatalogRepository {
  constructor(
    private readonly collections: CatalogCollections,
    private readonly apiPrefix = "/api/v1"
  ) {}

  async beginSnapshot(posConfigId: number, snapshotId: string, startedAt = new Date()): Promise<void> {
    await this.collections.productSnapshots.deleteMany({ snapshot_id: snapshotId, pos_config_odoo_id: posConfigId });
    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId },
      {
        $set: {
          pos_config_odoo_id: posConfigId,
          sync_status: "running",
          last_run_id: snapshotId,
          last_run_started_at: startedAt,
          last_error: null
        }
      },
      { upsert: true }
    );
  }

  async writeSnapshotPage(
    posConfigId: number,
    snapshotId: string,
    snapshot: Record<string, unknown>
  ): Promise<{ products: number; latestWriteDate: string | null }> {
    const products = extractItems(snapshot.products).map((item) => ({
      ...normalizeProduct(item),
      snapshot_id: snapshotId,
      pos_config_odoo_id: posConfigId
    }));
    if (products.length) {
      await this.collections.productSnapshots.bulkWrite(
        products.map((product) => ({
          updateOne: {
            filter: {
              snapshot_id: snapshotId,
              pos_config_odoo_id: posConfigId,
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

    await Promise.all([
      this.upsertSimpleCollection(this.collections.categories, snapshot.categories, "odoo_id"),
      this.upsertSimpleCollection(this.collections.uoms, snapshot.uoms, "odoo_id"),
      this.upsertSimpleCollection(this.collections.taxes, snapshot.taxes, "odoo_id"),
      this.upsertSimpleCollection(this.collections.categoryCv, snapshot.category_cv, "id"),
      this.upsertSimpleCollection(this.collections.productCvs, snapshot.product_cvs, "id"),
      this.upsertSimpleCollection(this.collections.productTemplateCv, snapshot.product_template_cv, "id")
    ]);

    return {
      products: products.length,
      latestWriteDate: latestWriteDate(products)
    };
  }

  async commitSnapshot(
    posConfigId: number,
    snapshotId: string,
    firstSnapshot: Record<string, unknown>,
    sourceTotal: number,
    latestWriteDate: string | null,
    completedAt = new Date()
  ): Promise<SyncStateDocument> {
    const stagedProducts = await this.collections.productSnapshots.countDocuments({
      snapshot_id: snapshotId,
      pos_config_odoo_id: posConfigId
    });
    if (stagedProducts !== sourceTotal) {
      throw new Error(`Product snapshot validation failed: source=${sourceTotal}, staged=${stagedProducts}.`);
    }

    const firstProducts = extractItems(firstSnapshot.products).map(normalizeProduct);
    const warehouseId = resolveWarehouseId(firstSnapshot, firstProducts);
    const warehouseName = resolveWarehouseName(firstSnapshot, firstProducts);
    const previous = await this.syncState(posConfigId);
    const state: SyncStateDocument = {
      pos_config_odoo_id: posConfigId,
      warehouse_odoo_id: warehouseId,
      warehouse_name: warehouseName,
      product_count: stagedProducts,
      last_synced_at: completedAt,
      last_odoo_write_date: latestWriteDate || previous?.last_odoo_write_date || null,
      active_snapshot_id: snapshotId,
      sync_status: "complete",
      source_total: sourceTotal,
      last_run_id: snapshotId,
      last_run_started_at: previous?.last_run_started_at || null,
      last_run_completed_at: completedAt,
      last_error: null
    };
    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId },
      { $set: state },
      { upsert: true }
    );
    return state;
  }

  async markSnapshotFailed(posConfigId: number, snapshotId: string, error: string): Promise<void> {
    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId },
      { $set: { sync_status: "failed", last_run_id: snapshotId, last_error: error } },
      { upsert: true }
    );
    await this.collections.productSnapshots.deleteMany({ snapshot_id: snapshotId, pos_config_odoo_id: posConfigId });
  }

  async pruneSnapshots(posConfigId: number, activeSnapshotId: string): Promise<void> {
    await this.collections.productSnapshots.deleteMany({
      pos_config_odoo_id: posConfigId,
      snapshot_id: { $ne: activeSnapshotId }
    });
  }

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

    const [existingState, productCount] = await Promise.all([
      this.syncState(posConfigId),
      this.collections.products.countDocuments({ warehouse_odoo_id: warehouseId })
    ]);
    const latest = latestWriteDate(products) || existingState?.last_odoo_write_date || null;

    const state: SyncStateDocument = {
      pos_config_odoo_id: posConfigId,
      warehouse_odoo_id: warehouseId,
      warehouse_name: warehouseName,
      product_count: productCount,
      last_synced_at: new Date(),
      last_odoo_write_date: latest
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
    const state = options.posConfigId
      ? await this.syncState(options.posConfigId)
      : await this.syncStateByWarehouse(options.warehouseId);
    const snapshotId = state?.active_snapshot_id || null;
    if (state?.sync_status === "running" && !snapshotId) {
      return emptyProductPage(options.offset, options.limit);
    }
    const collection = snapshotId ? this.collections.productSnapshots : this.collections.products;
    const filter: Filter<ProductDocument> = { warehouse_odoo_id: options.warehouseId };
    if (snapshotId) Object.assign(filter, { snapshot_id: snapshotId });
    if (options.updatedAfter) {
      filter.write_date = { $gt: options.updatedAfter };
    }

    const totalPromise = !options.updatedAfter && typeof state?.product_count === "number"
      ? Promise.resolve(state.product_count)
      : collection.countDocuments(filter);
    const [items, total] = await Promise.all([
      collection
        .find(filter, { projection: { _id: 0, raw: 0 } })
        .sort({ write_date: 1, odoo_product_id: 1 })
        .skip(options.offset)
        .limit(options.limit)
        .toArray(),
      totalPromise
    ]);

    return {
      items: items.map((item) => productToApi(item, this.apiPrefix)),
      offset: options.offset,
      limit: options.limit,
      total,
      has_more: options.offset + options.limit < total
    };
  }

  async findByBarcode(posConfigId: number, warehouseId: number, barcode: string): Promise<Record<string, unknown> | null> {
    const state = await this.syncState(posConfigId);
    if (state?.sync_status === "running" && !state.active_snapshot_id) return null;
    const collection = state?.active_snapshot_id ? this.collections.productSnapshots : this.collections.products;
    const filter: Filter<ProductDocument> = { warehouse_odoo_id: warehouseId, barcode };
    if (state?.active_snapshot_id) {
      Object.assign(filter, { snapshot_id: state.active_snapshot_id });
    }
    const document = await collection.findOne(
      filter,
      { projection: { _id: 0, raw: 0 } }
    );
    return document ? productToApi(document, this.apiPrefix) : null;
  }

  async findByOdooId(posConfigId: number, warehouseId: number, productId: number): Promise<Record<string, unknown> | null> {
    const state = await this.syncState(posConfigId);
    if (state?.sync_status === "running" && !state.active_snapshot_id) return null;
    const collection = state?.active_snapshot_id ? this.collections.productSnapshots : this.collections.products;
    const filter: Filter<ProductDocument> = {
      warehouse_odoo_id: warehouseId,
      odoo_product_id: productId
    };
    if (state?.active_snapshot_id) {
      Object.assign(filter, { snapshot_id: state.active_snapshot_id });
    }
    const document = await collection.findOne(
      filter,
      { projection: { _id: 0, raw: 0 } }
    );
    return document ? productToApi(document, this.apiPrefix) : null;
  }

  async imagesNeedingSync(products: ProductDocument[]): Promise<ProductDocument[]> {
    const candidates = products.filter((product) => Boolean(product.image_url));
    if (!candidates.length) return [];

    const existing = await this.collections.productImages
      .find(
        {
          $or: candidates.map((product) => ({
            odoo_product_id: product.odoo_product_id,
            warehouse_odoo_id: product.warehouse_odoo_id
          }))
        },
        { projection: { _id: 0, odoo_product_id: 1, warehouse_odoo_id: 1, source_url: 1, source_write_date: 1 } }
      )
      .toArray();
    const existingByKey = new Map(existing.map((image) => [productImageKey(image), image]));

    return candidates.filter((product) => {
      const image = existingByKey.get(productImageKey(product));
      if (!image) return true;
      return image.source_url !== product.image_url || image.source_write_date !== product.write_date;
    });
  }

  async upsertProductImages(images: ProductImageDocument[], snapshotId?: string, posConfigId?: number): Promise<void> {
    if (!images.length) return;
    await Promise.all([
      this.collections.productImages.bulkWrite(
        images.map((image) => ({
          updateOne: {
            filter: {
              odoo_product_id: image.odoo_product_id,
              warehouse_odoo_id: image.warehouse_odoo_id
            },
            update: { $set: image },
            upsert: true
          }
        })),
        { ordered: false }
      ),
      snapshotId && posConfigId
        ? this.collections.productSnapshots.bulkWrite(
            images.map((image) => ({
              updateOne: {
                filter: {
                  snapshot_id: snapshotId,
                  pos_config_odoo_id: posConfigId,
                  odoo_product_id: image.odoo_product_id,
                  warehouse_odoo_id: image.warehouse_odoo_id
                },
                update: {
                  $set: {
                    has_image: true,
                    image_hash: image.checksum,
                    image_content_type: image.content_type,
                    image_synced_at: image.synced_at
                  }
                }
              }
            })),
            { ordered: false }
          )
        : this.collections.products.bulkWrite(
        images.map((image) => ({
          updateOne: {
            filter: {
              odoo_product_id: image.odoo_product_id,
              warehouse_odoo_id: image.warehouse_odoo_id
            },
            update: {
              $set: {
                has_image: true,
                image_hash: image.checksum,
                image_content_type: image.content_type,
                image_synced_at: image.synced_at
              }
            }
          }
        })),
        { ordered: false }
      )
    ]);
  }

  async findImage(warehouseId: number, productId: number): Promise<ProductImageDocument | null> {
    return this.collections.productImages.findOne(
      { warehouse_odoo_id: warehouseId, odoo_product_id: productId },
      { projection: { _id: 0 } }
    );
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

  private async syncStateByWarehouse(warehouseId: number): Promise<SyncStateDocument | null> {
    return this.collections.syncState.findOne(
      { warehouse_odoo_id: warehouseId },
      { projection: { _id: 0 } }
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

function productImageKey(product: Pick<ProductDocument | ProductImageDocument, "odoo_product_id" | "warehouse_odoo_id">): string {
  return `${product.warehouse_odoo_id}:${product.odoo_product_id}`;
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

function emptyProductPage(offset: number, limit: number): Record<string, unknown> {
  return { items: [], offset, limit, total: 0, has_more: false };
}

function latestWriteDate(products: ProductDocument[]): string | null {
  return products
    .map((product) => product.write_date)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
}
