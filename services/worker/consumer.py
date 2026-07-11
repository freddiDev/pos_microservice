import pika
import json
import os
from app.odoo_client import OdooClient

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "localhost")

def callback(ch, method, properties, body):
    data = json.loads(body)
    print("Received:", data)

    odoo = OdooClient()
    result = odoo.create_lead(data)

    print("Odoo response:", result)

    connection = pika.BlockingConnection(
    pika.ConnectionParameters(host=RABBITMQ_HOST)
    )
    channel = connection.channel()

    channel.queue_declare(queue='odoo_queue')

    channel.basic_consume(
    queue='odoo_queue',
    on_message_callback=callback,
    auto_ack=True
    )

    print("Worker started...")
    channel.start_consuming()
