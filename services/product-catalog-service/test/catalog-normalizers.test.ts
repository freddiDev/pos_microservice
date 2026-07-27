import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProduct, productToApi } from "../src/catalog/normalizers.js";

test("normalizes Product CV warehouse fields into API payload", () => {
  const document = normalizeProduct({
    id: 11,
    name: "Batik Cap",
    list_price: "125000",
    barcode: 899001,
    uom_id: 1,
    taxes_id: [3],
    categ_id: 7,
    product_tmpl_id: 10,
    warehouse_id: 35,
    warehouse_name: "SALATIGA",
    cv_id: 89,
    cv_name: "CV Salatiga",
    product_cv_line_id: 144,
    write_date: "2026-07-20 10:00:00",
    image_url: "http://odoo/web/image/product.product/11/image_512"
  });

  assert.equal(document.odoo_product_id, 11);
  assert.equal(document.warehouse_odoo_id, 35);
  assert.equal(document.cv_odoo_id, 89);
  assert.deepEqual(productToApi(document), {
    id: 11,
    name: "Batik Cap",
    list_price: 125000,
    barcode: "899001",
    uom_id: 1,
    taxes_id: [3],
    categ_id: 7,
    write_date: "2026-07-20 10:00:00",
    image_url: "http://odoo/web/image/product.product/11/image_512",
    product_tmpl_id: 10,
    warehouse_id: 35,
    warehouse_name: "SALATIGA",
    cv_id: 89,
    cv_name: "CV Salatiga",
    product_cv_line_id: 144
  });
});
