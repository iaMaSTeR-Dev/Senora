"""SENORA webhook example behind your HTTPS reverse proxy.

Set SENORA_BASE_URL, SENORA_BOT_TOKEN, SENORA_WEBHOOK_SECRET (16+ chars).
Run on 127.0.0.1:9095; proxy a public HTTPS path here and register that URL
using PUT /api/v1/bot/webhook. Do not run polling at the same time.
"""
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import sqlite3

from echo_bot import SenoraBot

bot = None
secret = ''
database = None


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('X-Senora-Bot-Secret', ''), secret):
            self.send_error(403)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256 * 1024:
                self.send_error(413)
                return
            event = json.loads(self.rfile.read(length))
            event_id = int(event['update_id'])
            if not database.execute('SELECT 1 FROM processed WHERE id=?', (event_id,)).fetchone():
                # Outbound messages also carry an idempotency key. If the process
                # dies between sending and recording, retry does not duplicate them.
                bot.handle(event)
                database.execute('INSERT INTO processed(id) VALUES (?)', (event_id,))
                database.commit()
        except (ValueError, KeyError, TypeError):
            self.send_error(400)
            return
        except Exception:
            self.send_error(503)  # SENORA keeps this event and retries.
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_):
        pass  # Never log request headers containing secrets.


def main():
    global bot, secret, database
    bot = SenoraBot(os.environ['SENORA_BASE_URL'], os.environ['SENORA_BOT_TOKEN'])
    secret = os.environ['SENORA_WEBHOOK_SECRET']
    if len(secret) < 16:
        raise SystemExit('Use a webhook secret containing at least 16 characters.')
    database = sqlite3.connect(os.environ.get('SENORA_WEBHOOK_STATE', 'webhook-state.sqlite'))
    database.execute('CREATE TABLE IF NOT EXISTS processed(id INTEGER PRIMARY KEY)')
    server = HTTPServer(('127.0.0.1', int(os.environ.get('PORT', '9095'))), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        database.close()


if __name__ == '__main__':
    main()
