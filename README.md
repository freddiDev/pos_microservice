# Odoo POS Microservice

POS microservice monorepo for API Gateway, Auth/User/Device, POS Config/Session, Product Catalog, and Customer Member services.

## Structure

```text
odoo-pos-microservice/
  services/
    api-gateway/
    auth-service/
    pos-config-session-service/
    product-catalog-service/
    customer-member-service/
  packages/
    pos-python-runtime/
  scripts/
  docker-compose.yml
  Makefile
```

`services/*` contains deployable service modules and Docker entrypoints.
`packages/pos-python-runtime` contains the shared FastAPI runtime used by the
Python services. Product Catalog is an independent Node.js service with MongoDB
and Redis.

## Runtime Roles

- `SERVICE_ROLE=gateway`: public API gateway for Flutter POS.
- `SERVICE_ROLE=auth`: Auth/User/Device service with PostgreSQL persistence.
- `SERVICE_ROLE=pos`: POS Config and POS Session service with PostgreSQL persistence.
- `product-service`: Docker service name for the Node.js Product Catalog module at `services/product-catalog-service`.
- `member-service`: Docker service name for the Node.js Customer Member module at `services/customer-member-service`.

## Main Endpoints

- `GET /health/live`
- `GET /health/ready`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/users/me`
- `GET /api/v1/devices/me`
- `POST /api/v1/devices/heartbeat`
- `GET /api/v1/pos-configs`
- `GET|POST /api/v1/catalog/bootstrap`
- `GET|POST /api/v1/catalog/products`
- `GET /api/v1/catalog/products/:productId`
- `GET /api/v1/catalog/products/:productId/image`
- `GET /api/v1/catalog/products/barcode/:barcode`
- `GET|POST /api/v1/members/bootstrap`
- `GET|POST /api/v1/members`
- `GET /api/v1/members/search`
- `GET /api/v1/members/:partnerId`
- `GET /api/v1/members/:partnerId/loyalty`
- `GET /api/v1/members/tiers`

## Docker

```bash
make docker-build
make docker-up
make pgadmin
make mongo-express
make logs
make docker-down
```

All runtime values are loaded from `.env`. PgAdmin runs on
`http://localhost:${PGADMIN_PORT}`. Use PostgreSQL host `${POSTGRES_HOST}`,
database `${POSTGRES_DB}`, and user `${POSTGRES_USER}` for Auth DB. Use
`${POS_POSTGRES_HOST}`, `${POS_POSTGRES_DB}`, and `${POS_POSTGRES_USER}` for
POS Core DB.

Mongo Express runs on `http://localhost:${MONGO_EXPRESS_PORT}` for the shared
MongoDB used by Product Catalog and Customer Member read models. Product catalog
documents are keyed by Odoo product and `warehouse_odoo_id`; customer member
documents are keyed by Odoo partner and `company_odoo_id`.

## Local Validation

```bash
make test
make e2e
```

The E2E script starts a fake Odoo API, the Auth service, and the Gateway as real local HTTP servers, then validates the login, user, device, POS config, refresh, and logout flow through the gateway.

Product service local checks:

```bash
cd services/product-catalog-service
npm install
npm test
npm run build
```

Product image sync is handled by the catalog worker. The APK only reads cached
image metadata and bytes from Product Catalog service; it does not call Odoo for
product images.

Useful catalog image settings:

```env
CATALOG_IMAGE_SYNC_ENABLED=true
CATALOG_IMAGE_FIELD=image_128
CATALOG_IMAGE_SYNC_CONCURRENCY=4
CATALOG_IMAGE_MAX_BYTES=262144
```

Customer member service local checks:

```bash
cd services/customer-member-service
npm install
npm test
npm run build
```
