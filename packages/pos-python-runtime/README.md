# POS Python Runtime

Shared FastAPI runtime package used by the Python POS microservices:

- API Gateway
- Auth/User/Device Service
- POS Config/Session Service

Each service has its own Docker build folder under `services/`, while this
package keeps the shared framework, domain models, and tests in one place.
