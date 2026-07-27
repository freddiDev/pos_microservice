import { Collection, Db, MongoClient } from "mongodb";

import { AppConfig } from "./config.js";
import { ProductDocument, SyncStateDocument } from "./catalog/normalizers.js";

export type CatalogCollections = {
  products: Collection<ProductDocument>;
  categories: Collection<Record<string, unknown>>;
  uoms: Collection<Record<string, unknown>>;
  taxes: Collection<Record<string, unknown>>;
  categoryCv: Collection<Record<string, unknown>>;
  productCvs: Collection<Record<string, unknown>>;
  productTemplateCv: Collection<Record<string, unknown>>;
  syncState: Collection<SyncStateDocument>;
};

export type MongoResources = {
  client: MongoClient;
  db: Db;
  collections: CatalogCollections;
};

export async function connectMongo(config: AppConfig): Promise<MongoResources> {
  const client = new MongoClient(config.mongoUrl, {
    maxPoolSize: 20,
    minPoolSize: 2,
    retryWrites: true
  });
  await client.connect();
  const db = client.db(config.mongoDbName);
  const collections = {
    products: db.collection<ProductDocument>("catalog_products"),
    categories: db.collection<Record<string, unknown>>("catalog_categories"),
    uoms: db.collection<Record<string, unknown>>("catalog_uoms"),
    taxes: db.collection<Record<string, unknown>>("catalog_taxes"),
    categoryCv: db.collection<Record<string, unknown>>("catalog_category_cv_assignments"),
    productCvs: db.collection<Record<string, unknown>>("catalog_product_cvs"),
    productTemplateCv: db.collection<Record<string, unknown>>("catalog_product_template_cv_assignments"),
    syncState: db.collection<SyncStateDocument>("catalog_sync_state")
  };
  await ensureIndexes(collections);
  return { client, db, collections };
}

export async function ensureIndexes(collections: CatalogCollections): Promise<void> {
  await Promise.all([
    collections.products.createIndex(
      { odoo_product_id: 1, warehouse_odoo_id: 1 },
      { unique: true, name: "uniq_product_warehouse" }
    ),
    collections.products.createIndex({ barcode: 1, warehouse_odoo_id: 1 }, { name: "idx_barcode_warehouse" }),
    collections.products.createIndex({ warehouse_odoo_id: 1, write_date: 1 }, { name: "idx_warehouse_write_date" }),
    collections.products.createIndex({ odoo_template_id: 1, warehouse_odoo_id: 1 }, { name: "idx_template_warehouse" }),
    collections.syncState.createIndex({ pos_config_odoo_id: 1 }, { unique: true, name: "uniq_config_sync" }),
    collections.categories.createIndex({ odoo_id: 1 }, { unique: true, name: "uniq_category" }),
    collections.uoms.createIndex({ odoo_id: 1 }, { unique: true, name: "uniq_uom" }),
    collections.taxes.createIndex({ odoo_id: 1 }, { unique: true, name: "uniq_tax" }),
    collections.categoryCv.createIndex(
      { category_odoo_id: 1, warehouse_odoo_id: 1 },
      { unique: true, name: "uniq_category_warehouse" }
    ),
    collections.productCvs.createIndex(
      { odoo_id: 1, warehouse_odoo_id: 1 },
      { unique: true, name: "uniq_cv_warehouse" }
    ),
    collections.productTemplateCv.createIndex(
      { odoo_template_id: 1, warehouse_odoo_id: 1 },
      { unique: true, name: "uniq_template_warehouse" }
    )
  ]);
}
