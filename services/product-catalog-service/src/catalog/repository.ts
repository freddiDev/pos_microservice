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
  snapshotId?: string;
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
  ): Promise<{
    products: number;
    latestWriteDate: string | null;
    latestImageWriteDate: string | null;
  }> {
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
      latestWriteDate: latestWriteDate(products),
      latestImageWriteDate: latestImageWriteDate(products)
    };
  }

  async commitSnapshot(
    posConfigId: number,
    snapshotId: string,
    firstSnapshot: Record<string, unknown>,
    sourceTotal: number,
    latestWriteDate: string | null,
    completedAt = new Date(),
    imageSyncEnabled = true,
    latestImageWriteDate: string | null = null,
    sourceFingerprint: string | null = null
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
      last_odoo_image_write_date:
        latestImageWriteDate || previous?.last_odoo_image_write_date || null,
      source_fingerprint: sourceFingerprint || previous?.source_fingerprint || null,
      active_snapshot_id: snapshotId,
      sync_status: "complete",
      source_total: sourceTotal,
      last_run_id: snapshotId,
      last_run_started_at: previous?.last_run_started_at || null,
      last_run_completed_at: completedAt,
      last_error: null,
      image_sync_status: imageSyncEnabled ? "pending" : "disabled",
      image_sync_snapshot_id: imageSyncEnabled ? snapshotId : null,
      image_sync_revision: previous?.image_sync_revision || null,
      image_sync_started_at: null,
      image_sync_completed_at: imageSyncEnabled ? previous?.image_sync_completed_at || null : completedAt,
      image_sync_total: imageSyncEnabled ? 0 : 0,
      image_synced_count: 0,
      image_failed_count: 0,
      image_sync_error: null
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

  async discardUnchangedSnapshot(
    posConfigId: number,
    snapshotId: string,
    completedAt = new Date()
  ): Promise<void> {
    await this.collections.productSnapshots.deleteMany({
      snapshot_id: snapshotId,
      pos_config_odoo_id: posConfigId
    });
    await this.collections.syncState.updateOne(
      {
        pos_config_odoo_id: posConfigId,
        last_run_id: snapshotId
      },
      {
        $set: {
          sync_status: "complete",
          last_run_completed_at: completedAt,
          last_error: null
        }
      }
    );
  }

  async pruneSnapshots(posConfigId: number, activeSnapshotId: string): Promise<void> {
    const previous = await this.collections.productSnapshots
      .find({ pos_config_odoo_id: posConfigId, snapshot_id: { $ne: activeSnapshotId } })
      .sort({ snapshot_id: -1 })
      .limit(1)
      .toArray();
    const keepSnapshotIds = [activeSnapshotId, previous[0]?.snapshot_id].filter(
      (value): value is string => Boolean(value)
    );
    await this.collections.productSnapshots.deleteMany({
      pos_config_odoo_id: posConfigId,
      snapshot_id: { $nin: keepSnapshotIds }
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
    const latestImage =
      latestImageWriteDate(products) || existingState?.last_odoo_image_write_date || null;

    const state: SyncStateDocument = {
      pos_config_odoo_id: posConfigId,
      warehouse_odoo_id: warehouseId,
      warehouse_name: warehouseName,
      product_count: productCount,
      last_synced_at: new Date(),
      last_odoo_write_date: latest,
      last_odoo_image_write_date: latestImage
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
    const snapshotId = options.snapshotId || state?.active_snapshot_id || null;
    if (state?.sync_status === "running" && !snapshotId) {
      return emptyProductPage(options.offset, options.limit);
    }
    const collection = snapshotId ? this.collections.productSnapshots : this.collections.products;
    const filter: Filter<ProductDocument> = { warehouse_odoo_id: options.warehouseId };
    if (snapshotId) Object.assign(filter, { snapshot_id: snapshotId });
    if (options.updatedAfter) {
      filter.write_date = { $gt: options.updatedAfter };
    }

    // The mobile client pins every page to the active snapshot after the
    // first response. Reusing the validated sync-state count avoids a full
    // Mongo count scan for every page of a large catalog.
    const snapshotIsActive = !options.snapshotId || options.snapshotId === state?.active_snapshot_id;
    const totalPromise = snapshotIsActive && !options.updatedAfter && typeof state?.product_count === "number"
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

  async listSnapshotProductsForImages(
    posConfigId: number,
    snapshotId: string,
    offset: number,
    limit: number
  ): Promise<ProductDocument[]> {
    return this.collections.productSnapshots
      .find(
        {
          pos_config_odoo_id: posConfigId,
          snapshot_id: snapshotId,
          image_url: { $exists: true, $nin: [null, ""] }
        },
        { projection: { _id: 0, raw: 0 } }
      )
      // Match the product API ordering so the eager image batch corresponds
      // to the first cards rendered by the mobile POS.
      .sort({ write_date: 1, odoo_product_id: 1 })
      .skip(offset)
      .limit(limit)
      .toArray();
  }

  async countSnapshotProductsForImages(posConfigId: number, snapshotId: string): Promise<number> {
    return this.collections.productSnapshots.countDocuments({
      pos_config_odoo_id: posConfigId,
      snapshot_id: snapshotId,
      image_url: { $exists: true, $nin: [null, ""] }
    });
  }

  async markImageSyncStarted(
    posConfigId: number,
    snapshotId: string,
    total: number,
    startedAt = new Date()
  ): Promise<void> {
    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId, active_snapshot_id: snapshotId },
      {
        $set: {
          image_sync_status: "running",
          image_sync_snapshot_id: snapshotId,
          image_sync_started_at: startedAt,
          image_sync_completed_at: null,
          image_sync_total: total,
          image_synced_count: 0,
          image_failed_count: 0,
          image_sync_error: null
        }
      }
    );
  }

  async markImageSyncCompleted(
    posConfigId: number,
    snapshotId: string,
    result: { synced: number; failed: number; total: number; error?: string | null },
    completedAt = new Date()
  ): Promise<void> {
    const changed = result.synced > 0;
    const set: Record<string, unknown> = {
      image_sync_status: result.failed > 0 ? "failed" : "complete",
      image_sync_snapshot_id: snapshotId,
      image_sync_completed_at: completedAt,
      image_sync_total: result.total,
      image_synced_count: result.synced,
      image_failed_count: result.failed,
      image_sync_error: result.error || null
    };
    if (changed) set.image_sync_revision = completedAt.toISOString();
    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId, active_snapshot_id: snapshotId },
      { $set: set }
    );
  }

  async markImageSyncFailed(
    posConfigId: number,
    snapshotId: string,
    error: string,
    failedAt = new Date()
  ): Promise<void> {
    await this.collections.syncState.updateOne(
      { pos_config_odoo_id: posConfigId, active_snapshot_id: snapshotId },
      {
        $set: {
          image_sync_status: "failed",
          image_sync_snapshot_id: snapshotId,
          image_sync_completed_at: failedAt,
          image_sync_error: error
        }
      }
    );
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
      // Odoo can expose the source image through image_512/image_128 while
      // the worker stores the normalized image_128 URL. The product write
      // date is the stable change token, so comparing raw URLs would cause
      // every worker cycle to download all images again.
      return image.source_write_date !== productImageWriteDate(product);
    });
  }

  async linkExistingImagesToSnapshot(
    products: ProductDocument[],
    snapshotId: string,
    posConfigId: number
  ): Promise<number> {
    const candidates = products.filter((product) => Boolean(product.image_url));
    if (!candidates.length) return 0;

    const existing = await this.collections.productImages
      .find(
        {
          $or: candidates.map((product) => ({
            odoo_product_id: product.odoo_product_id,
            warehouse_odoo_id: product.warehouse_odoo_id
          }))
        },
        {
          projection: {
            _id: 0,
            odoo_product_id: 1,
            warehouse_odoo_id: 1,
            source_write_date: 1,
            checksum: 1,
            content_type: 1,
            synced_at: 1
          }
        }
      )
      .toArray();
    const existingByKey = new Map(existing.map((image) => [productImageKey(image), image]));
    const links = candidates.flatMap((product) => {
      const image = existingByKey.get(productImageKey(product));
      if (!image || image.source_write_date !== productImageWriteDate(product) || !image.checksum) {
        return [];
      }
      return [{ product, image }];
    });
    if (!links.length) return 0;

    await this.collections.productSnapshots.bulkWrite(
      links.map(({ product, image }) => ({
        updateOne: {
          filter: {
            snapshot_id: snapshotId,
            pos_config_odoo_id: posConfigId,
            odoo_product_id: product.odoo_product_id,
            warehouse_odoo_id: product.warehouse_odoo_id
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
    );
    return links.length;
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

  async removeProductImages(
    products: ProductDocument[],
    snapshotId?: string,
    posConfigId?: number
  ): Promise<number> {
    if (!products.length) return 0;
    const keys = products.map((product) => ({
      odoo_product_id: product.odoo_product_id,
      warehouse_odoo_id: product.warehouse_odoo_id
    }));
    const existing = await this.collections.productImages
      .find({ $or: keys }, { projection: { _id: 1 } })
      .toArray();
    const syncedAt = new Date();
    await Promise.all([
      this.collections.productImages.bulkWrite(
        products.map((product) => ({
          updateOne: {
            filter: {
              odoo_product_id: product.odoo_product_id,
              warehouse_odoo_id: product.warehouse_odoo_id
            },
            update: {
              $set: {
                odoo_product_id: product.odoo_product_id,
                warehouse_odoo_id: product.warehouse_odoo_id,
                content_type: "application/octet-stream",
                data: Buffer.alloc(0),
                checksum: "",
                size: 0,
                source_url: product.image_url || "",
                source_write_date: productImageWriteDate(product),
                synced_at: syncedAt,
                missing: true
              }
            },
            upsert: true
          }
        })),
        { ordered: false }
      ),
      snapshotId && posConfigId
        ? this.collections.productSnapshots.bulkWrite(
            products.map((product) => ({
              updateOne: {
                filter: {
                  snapshot_id: snapshotId,
                  pos_config_odoo_id: posConfigId,
                  odoo_product_id: product.odoo_product_id,
                  warehouse_odoo_id: product.warehouse_odoo_id
                },
                update: {
                  $set: {
                    has_image: false,
                    image_hash: null,
                    image_content_type: null,
                    image_synced_at: null
                  }
                }
              }
            })),
            { ordered: false }
          )
        : this.collections.products.bulkWrite(
            products.map((product) => ({
              updateOne: {
                filter: {
                  odoo_product_id: product.odoo_product_id,
                  warehouse_odoo_id: product.warehouse_odoo_id
                },
                update: {
                  $set: {
                    has_image: false,
                    image_hash: null,
                    image_content_type: null,
                    image_synced_at: null
                  }
                }
              }
            })),
            { ordered: false }
          )
    ]);
    return existing.length;
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

function latestImageWriteDate(products: ProductDocument[]): string | null {
  return products
    .map((product) => product.image_write_date || product.write_date)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
}

function productImageWriteDate(product: ProductDocument): string | null {
  return product.image_write_date || product.write_date;
}
