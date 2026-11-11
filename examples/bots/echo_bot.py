"""Native SENORA bot. Python 3.10+, standard library only.

Set SENORA_BASE_URL and SENORA_BOT_TOKEN, then run this file.
Open the bot's @username in SENORA and send /start.
"""
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request


class SenoraBot:
    def __init__(self, base_url, token):
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise ValueError('SENORA_BASE_URL must be an HTTP(S) server origin')
        self.base = base_url.rstrip('/') + '/api/v1/bot'
        self.token = token

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={'Authorization': 'Bot ' + self.token,
                     'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=65) as response:
            return json.load(response)

    def handle(self, event):
        data = event['data']
        if event['type'] == 'callback_query':
            try:
                self.call('POST', '/callbacks/' + data['id'] + '/answer',
                          {'text': 'Received: ' + data['data'], 'show_alert': True})
            except urllib.error.HTTPError as error:
                if error.code != 404:  # A replayed answer or expired callback is terminal.
                    raise
        elif event['type'] == 'message.created':
            message = data['message']
            text = message['ciphertext']
            try:
                text = json.loads(text).get('text', '')
            except (ValueError, AttributeError):
                pass
            self.call('POST', '/messages', {
                'conversation_id': message['conversation_id'],
                'reply_to_id': message['id'],
                'text': 'SENORA echo: ' + str(text)[:30000],
                'idempotency_key': 'echo-update-' + str(event['update_id']),
                'buttons': [[{'text': 'Test callback', 'callback_data': 'hello'}]],
            })


def main():
    bot = SenoraBot(os.environ['SENORA_BASE_URL'], os.environ['SENORA_BOT_TOKEN'])
    me = bot.call('GET', '/me')
    # A separate cursor per bot avoids acknowledging another bot's updates.
    checkpoint = Path(os.environ.get('SENORA_BOT_CURSOR', me['id'] + '.cursor.json'))
    offset = json.loads(checkpoint.read_text()).get('offset', 0) if checkpoint.exists() else 0
    print('Running @' + me['username'], flush=True)
    while True:
        try:
            events = bot.call('GET', '/updates?' + urllib.parse.urlencode(
                {'offset': offset, 'timeout': 30}))['updates']
            for event in events:
                bot.handle(event)
                offset = event['update_id'] + 1
                temporary = checkpoint.with_suffix('.tmp')
                temporary.write_text(json.dumps({'offset': offset}))
                temporary.replace(checkpoint)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 409):
                raise SystemExit(f'Bot stopped: HTTP {error.code}; check key, account or webhook mode.')
            print(f'Temporary HTTP error {error.code}; retrying', flush=True)
            time.sleep(3)
        except (urllib.error.URLError, TimeoutError):
            print('Connection interrupted; retrying', flush=True)
            time.sleep(3)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
