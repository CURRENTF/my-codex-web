#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const model = { provider: 'test', id: 'local', reasoning: false, input: ['text'] };
let timer;
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') { send({ type: 'agent_settled' }); continue; }
  const respond = (data) => send({ type: 'response', command: command.type, id: command.id, success: true, data });
  switch (command.type) {
    case 'get_state': respond({ model, thinkingLevel: 'off' }); break;
    case 'get_available_models': respond({ models: [model] }); break;
    case 'get_available_thinking_levels': respond({ levels: ['off'] }); break;
    case 'get_session_stats': respond({ cost: 0, contextUsage: { tokens: 42, contextWindow: 8192 } }); break;
    case 'prompt': {
      respond({ disposition: command.message === 'handled' ? 'handled' : 'started' });
      if (command.message === 'crash') { process.exit(7); }
      if (command.message === 'hold' || command.message === 'handled') break;
      if (command.message === 'question') { send({ type: 'extension_ui_request', id: 'native-question', method: 'confirm', title: 'Run tool?' }); break; }
      const message = { role: 'assistant', content: [{ type: 'text', text: 'hello\u2028world' }], stopReason: 'stop' };
      send({ type: 'message_start', message });
      send({ type: 'message_update', message });
      send({ type: 'message_end', message });
      send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
      send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file contents' }] } });
      send({ type: 'agent_end' });
      // agent_end is not the end of retries / queued work.
      timer = setTimeout(() => send({ type: 'agent_settled' }), 100);
      break;
    }
    case 'abort': clearTimeout(timer); respond(); send({ type: 'agent_settled' }); break;
    default: respond();
  }
}
