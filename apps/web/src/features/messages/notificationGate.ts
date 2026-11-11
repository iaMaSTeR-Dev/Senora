type MessageEvent = { type: string; replay?: boolean; payload: any };

// History remains available to message subscribers, but must not alert again.
export class MessageNotificationGate {
  private account = '';
  private seen = new Set<string>();

  shouldNotify(event: MessageEvent, account: string): boolean {
    if (account !== this.account) {
      this.account = account;
      this.seen.clear();
    }
    if (!account || event.type !== 'message.created') return false;
    const message = event.payload;
    if (!message?.id) return false;
    const key = `${message.conversation_id}:${message.id}`;
    const duplicate = this.seen.has(key);
    this.seen.add(key);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    return !event.replay && !duplicate && message.sender_id !== account;
  }
}
