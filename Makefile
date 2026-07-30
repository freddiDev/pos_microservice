UV ?= uv
ENV_FILE ?= .env
COMPOSE ?= docker compose --env-file $(ENV_FILE)
PYTHON_RUNTIME_DIR ?= packages/pos-python-runtime
PRODUCT_SERVICE_DIR ?= services/product-catalog-service
MEMBER_SERVICE_DIR ?= services/customer-member-service

include $(ENV_FILE)
override ENVIRONMENT := $(shell sed -n 's/^ENVIRONMENT=//p' $(ENV_FILE) | tail -n 1)
export $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' $(ENV_FILE))

.PHONY: docker-build docker-up docker-down docker-restart ps logs test test-member e2e docker-e2e pgadmin mongo-express shell-auth shell-pos shell-product shell-member shell-gateway db-shell pos-db-shell mongo-shell

docker-build:
	$(COMPOSE) build

docker-up:
	$(COMPOSE) up -d --build --remove-orphans

docker-down:
	$(COMPOSE) down

docker-restart: docker-down docker-up

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=200

test:
	cd $(PYTHON_RUNTIME_DIR) && $(UV) run pytest -q

test-member:
	cd $(MEMBER_SERVICE_DIR) && npm test && npm run build

e2e:
	cd $(PYTHON_RUNTIME_DIR) && $(UV) run python ../../scripts/e2e_validate.py

docker-e2e:
	$(COMPOSE) run --rm auth-service python scripts/e2e_validate.py

pgadmin:
	$(COMPOSE) up -d pgadmin
	@echo "PgAdmin: http://localhost:$(PGADMIN_PORT)"
	@echo "Login: $(PGADMIN_DEFAULT_EMAIL) / $(PGADMIN_DEFAULT_PASSWORD)"
	@echo "Auth DB: host $(POSTGRES_HOST), database $(POSTGRES_DB), user/password $(POSTGRES_USER)"
	@echo "POS DB: host $(POS_POSTGRES_HOST), database $(POS_POSTGRES_DB), user/password $(POS_POSTGRES_USER)"

mongo-express:
	$(COMPOSE) up -d mongo-express
	@echo "Mongo Express: http://localhost:$(MONGO_EXPRESS_PORT)"
	@echo "Catalog DB: $(CATALOG_MONGO_DB)"

shell-auth:
	$(COMPOSE) exec auth-service bash

shell-pos:
	$(COMPOSE) exec pos-service bash

shell-product:
	$(COMPOSE) exec product-service sh

shell-member:
	$(COMPOSE) exec member-service sh

shell-gateway:
	$(COMPOSE) exec gateway bash

db-shell:
	$(COMPOSE) exec auth-db psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

pos-db-shell:
	$(COMPOSE) exec pos-db psql -U $(POS_POSTGRES_USER) -d $(POS_POSTGRES_DB)

mongo-shell:
	$(COMPOSE) exec catalog-mongo mongosh -u $(CATALOG_MONGO_ROOT_USER) -p $(CATALOG_MONGO_ROOT_PASSWORD) --authenticationDatabase admin $(CATALOG_MONGO_DB)
