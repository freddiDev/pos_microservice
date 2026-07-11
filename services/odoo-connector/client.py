import requests
import os

class OdooClient:
    def __init__(self):
        self.url = os.getenv("ODOO_URL")
        self.db = os.getenv("ODOO_DB")
        self.username = os.getenv("ODOO_USERNAME")
        self.password = os.getenv("ODOO_PASSWORD")

        self.uid = self.authenticate()

    def jsonrpc(self, service, method, args):
        payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "service": service,
                "method": method,
                "args": args
            },
            "id": 1,
        }

        response = requests.post(f"{self.url}/jsonrpc", json=payload)
        return response.json()["result"]

    def authenticate(self):
        return self.jsonrpc(
            "common",
            "login",
            [self.db, self.username, self.password]
        )

    def execute(self, model, method, *args):
        return self.jsonrpc(
            "object",
            "execute_kw",
            [
                self.db,
                self.uid,
                self.password,
                model,
                method,
                args
            ]
        )

    def create_lead(self, data):
        return self.execute(
            "crm.lead",
            "create",
            data
        )
