import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import {
  loyaltyProgramToApi,
  memberToApi,
  normalizeLoyaltyProgram,
  normalizeMember,
  normalizeSearch,
  normalizeTier,
  tierToApi
} from "../src/member/normalizers.js";
import { memberRequestSchema } from "../src/member/schemas.js";

test("normalizes Odoo partner false values, many2one tier, and search fields", () => {
  const document = normalizeMember(
    {
      id: "230",
      name: "RICKY POINT",
      phone: false,
      mobile: "+62 812-345",
      email: "Ricky@example.com ",
      member_code: false,
      ref: " MBR-230 ",
      barcode: 9900230,
      member_type_id: [4, "Gold Member"],
      membership_date: "2026-01-17",
      pos_loyal_point: "12.5",
      active: true,
      is_membership: true,
      company_id: [1, "Batik Benang Raja"],
      write_date: "2026-05-23 16:43:07"
    },
    1
  );

  assert.equal(document.odoo_partner_id, 230);
  assert.equal(document.phone, null);
  assert.equal(document.mobile_digits, "62812345");
  assert.equal(document.email_search, "ricky@example.com");
  assert.equal(document.member_code, "MBR-230");
  assert.equal(document.member_type_id, 4);
  assert.equal(document.member_type, "Gold Member");
  assert.equal(document.pos_loyal_point, 12.5);
  assert.equal(document.name_search, "ricky point");

  assert.deepEqual(memberToApi(document), {
    id: 230,
    name: "RICKY POINT",
    phone: null,
    mobile: "+62 812-345",
    email: "Ricky@example.com",
    member_code: "MBR-230",
    barcode: "9900230",
    member_type: "Gold Member",
    member_type_id: 4,
    membership_date: "2026-01-17",
    pos_loyal_point: 12.5,
    loyalty_points: 12.5,
    active: true,
    is_membership: true,
    company_id: 1,
    write_date: "2026-05-23 16:43:07"
  });
});

test("normalizes tiers and loyalty programs without requiring custom optional fields", () => {
  const tier = normalizeTier({ id: 2, name: "Silver", active: false }, 7);
  const program = normalizeLoyaltyProgram({ id: "5", name: "Points", expired_days: "30" }, 7);

  assert.deepEqual(tierToApi(tier), {
    id: 2,
    name: "Silver",
    code: null,
    sequence: null,
    active: false,
    company_id: 7,
    write_date: null
  });
  assert.deepEqual(loyaltyProgramToApi(program), {
    id: 5,
    name: "Points",
    pos_loyalty_type: null,
    expired_days: 30,
    active: true,
    company_id: 7,
    write_date: null
  });
});

test("parses member requests and config fallbacks", () => {
  const request = memberRequestSchema.parse({
    offset: "10",
    limit: "250",
    q: "alice",
    refresh: "true"
  });

  assert.equal(request.offset, 10);
  assert.equal(request.limit, 250);
  assert.equal(request.q, "alice");
  assert.equal(request.refresh, true);

  const config = loadConfig({
    AUTH_SERVICE_URL: "http://auth.local",
    ODOO_BASE_URL: "http://odoo.local",
    INTERNAL_SERVICE_KEY: "internal",
    MEMBER_MONGO_URL: "mongodb://mongo:27017",
    MEMBER_MONGO_DB: "pos_member",
    REDIS_URL: "redis://redis:6379"
  });

  assert.equal(config.mongoUrl, "mongodb://mongo:27017");
  assert.equal(config.mongoDbName, "pos_member");
  assert.equal(config.port, 3001);
});

test("search normalization strips accents and repeated spaces", () => {
  assert.equal(normalizeSearch("  Déwi   Member  "), "dewi member");
});
