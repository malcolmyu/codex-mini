import type { MessageChannel, OutgoingMessage } from './core/types.js';

export class ConsoleChannel implements MessageChannel {
  readonly messages: OutgoingMessage[] = [];

  async send(message: OutgoingMessage): Promise<void> {
    this.messages.push(message);
    process.stdout.write(`\nCodex> ${message.text}\n\n`);
  }
}
