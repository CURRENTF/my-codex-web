#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args.includes('--continue') || args.includes('--dangerously-skip-permissions')) process.exit(9);
if (args.includes('models')) {
  send({ status: 'SUCCESS', command: { data: { models: [{ id: 'fixture-model', label: 'Fixture model' }, { id: 'fixture-alternate', label: 'Agy alternate' }] } } });
  process.exit(0);
}
if (args.includes('-p')) {
  send({ status: 'SUCCESS', command: { data: { id: 'fixture-model' } } });
  process.exit(0);
}
const id = args.includes('--conversation') ? arg('--conversation') : randomUUID();
const file = `.fixture-agy-${id}.json`;
let history = [];
try { history = JSON.parse(readFileSync(file, 'utf8')); } catch {}
send({ event: 'init', conversation_id: id, init: { model: 'fixture-model' } });
const result = (response, status = 'SUCCESS', error) => send({ event: 'result', result: { conversation_id: id, status, response, error } });
process.on('SIGINT', () => { result('', 'ERROR', 'interrupted'); process.exit(1); });
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.event !== 'user' || typeof input.message.content !== 'string') process.exit(8);
  const text = input.message.content;
  history.push(text); writeFileSync(file, JSON.stringify(history));
  if (text === 'hold') { setInterval(() => {}, 1000); break; }
  if (text === 'slow') await new Promise(resolve => setTimeout(resolve, 3000));
  if (text === 'crash') process.exit(7);
  if (text === 'malformed') { process.stdout.write('invalid json\n'); setInterval(() => {}, 1000); break; }
  if (text === 'timeout') { process.stderr.write('print timeout 1s: turn in progress\n'); result(''); break; }
  if (text === 'no-result') break;
  if (text === 'error') { result('', 'ERROR', 'provider failure'); break; }
  if (text === 'denied-command' || text === 'recovered-tool-error') {
    send({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, step_type: 'tool', state: 'ERROR', tool_info: { name: 'run_command', parameters: { CommandLine: 'printf probe' }, error: { type: 'TOOL_ERROR', message: 'user denied permission to run command: printf probe' } } } });
    send({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: text === 'recovered-tool-error' ? 'Explained the denied operation.' : '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
    break;
  }
  const reply = text === 'recall' ? history[0] : 'hello 世界\u2028agy';
  send({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_info: { name: 'read_file', parameters: { Path: 'README.md' } } } });
  send({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, step_type: 'tool', state: 'DONE', tool_info: { name: 'read_file', output: 'file contents' } } });
  send({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, step_type: 'agent_response', state: 'ACTIVE', text_delta: reply } });
  send({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: '\n' } });
  result(reply + '\n');
  // Keep stdout open briefly: the adapter must not allow another turn until process close.
  await new Promise(resolve => setTimeout(resolve, 50));
}
