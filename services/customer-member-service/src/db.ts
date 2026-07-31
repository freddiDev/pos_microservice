import { Collection, Db, MongoClient } from "mongodb";

import { AppConfig } from "./config.js";
import {
  LoyaltyProgramDocument,
  MemberDocument,
  MemberSnapshotDocument,
  MemberSyncStateDocument,
  MemberTierDocument
} from "./member/normalizers.js";

export type MemberCollections = {
  members: Collection<MemberDocument>;
  memberSnapshots: Collection<MemberSnapshotDocument>;
  tiers: Collection<MemberTierDocument>;
  loyaltyPrograms: Collection<LoyaltyProgramDocument>;
  syncState: Collection<MemberSyncStateDocument>;
};

export type MongoResources = {
  client: MongoClient;
  db: Db;
  collections: MemberCollections;
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
    members: db.collection<MemberDocument>("member_customers"),
    memberSnapshots: db.collection<MemberSnapshotDocument>("member_customer_snapshots"),
    tiers: db.collection<MemberTierDocument>("member_tiers"),
    loyaltyPrograms: db.collection<LoyaltyProgramDocument>("member_loyalty_programs"),
    syncState: db.collection<MemberSyncStateDocument>("member_sync_state")
  };
  await ensureIndexes(collections);
  return { client, db, collections };
}

export async function ensureIndexes(collections: MemberCollections): Promise<void> {
  await Promise.all([
    collections.members.createIndex(
      { company_odoo_id: 1, odoo_partner_id: 1 },
      { unique: true, name: "uniq_member_company_partner" }
    ),
    collections.memberSnapshots.createIndex(
      { snapshot_id: 1, company_odoo_id: 1, odoo_partner_id: 1 },
      { unique: true, name: "uniq_member_snapshot_partner" }
    ),
    collections.memberSnapshots.createIndex(
      { snapshot_id: 1, company_odoo_id: 1, active: 1, is_membership: 1, write_date: 1, odoo_partner_id: 1 },
      { name: "idx_member_snapshot_list" }
    ),
    collections.memberSnapshots.createIndex(
      { snapshot_id: 1, company_odoo_id: 1, name_search: 1 },
      { name: "idx_member_snapshot_name" }
    ),
    collections.memberSnapshots.createIndex(
      { snapshot_id: 1, company_odoo_id: 1, member_code_search: 1 },
      { name: "idx_member_snapshot_code" }
    ),
    collections.members.createIndex({ company_odoo_id: 1, active: 1, write_date: 1, odoo_partner_id: 1 }, { name: "idx_member_active_write" }),
    collections.members.createIndex({ company_odoo_id: 1, name_search: 1 }, { name: "idx_member_name_search" }),
    collections.members.createIndex({ company_odoo_id: 1, phone_digits: 1 }, { name: "idx_member_phone_digits" }),
    collections.members.createIndex({ company_odoo_id: 1, mobile_digits: 1 }, { name: "idx_member_mobile_digits" }),
    collections.members.createIndex({ company_odoo_id: 1, email_search: 1 }, { name: "idx_member_email_search" }),
    collections.members.createIndex({ company_odoo_id: 1, member_code_search: 1 }, { name: "idx_member_code_search" }),
    collections.members.createIndex({ company_odoo_id: 1, barcode_search: 1 }, { name: "idx_member_barcode_search" }),
    collections.members.createIndex({ company_odoo_id: 1, member_type_id: 1 }, { name: "idx_member_tier" }),
    collections.tiers.createIndex(
      { company_odoo_id: 1, odoo_id: 1 },
      { unique: true, name: "uniq_tier_company" }
    ),
    collections.tiers.createIndex({ company_odoo_id: 1, sequence: 1, name: 1 }, { name: "idx_tier_sequence" }),
    collections.loyaltyPrograms.createIndex(
      { company_odoo_id: 1, odoo_id: 1 },
      { unique: true, name: "uniq_loyalty_program_company" }
    ),
    collections.loyaltyPrograms.createIndex({ company_odoo_id: 1, active: 1, name: 1 }, { name: "idx_loyalty_program_active" }),
    collections.syncState.createIndex({ company_odoo_id: 1 }, { unique: true, name: "uniq_member_sync_company" })
  ]);
}
