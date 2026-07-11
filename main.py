from fastapi import FastAPI
import pika
import os
import json

app = FastAPI()

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")

def publish_message(message: dict):
    connection = pika.BlockingConnection(
    pika.ConnectionParameters(host=RABBITMQ_HOST)
    )
    channel = connection.channel()
    channel.queue_declare(queue='odoo_queue')

    channel.basic_publish(
        exchange='',
        routing_key='odoo_queue',
        body=json.dumps(message)
    )
    connection.close()

@app.get("/")
def root():
    return {"status": "API running"}

@app.post("/send")
def send_task(data: dict):
    publish_message(data)
    return {"message": "Task sent to queue"}
