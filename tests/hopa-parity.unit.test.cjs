'use strict';

// hopa <-> hop-mcp parity: every MCP tool must be reachable through a hopa
// verb, and every hopa verb must point at a real tool. This is the contract
// that lets the CLI and MCP surfaces share one core without drifting.

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const hopa = require(path.join(__dirname, '..', 'hopa'));
const { HopMCPServer } = require(path.join(__dirname, '..', 'mcp', 'hop-mcp.js'));

function toolDefinitions() {
  const proto = Object.create(HopMCPServer.prototype);
  return proto.getToolDefinitions();
}

test('every MCP tool has a hopa verb (full parity)', () => {
  const toolNames = new Set(toolDefinitions().map((d) => d.name));
  const covered = new Set(Object.values(hopa.VERBS).map((v) => v.tool));
  const missing = [...toolNames].filter((name) => !covered.has(name));
  assert.deepStrictEqual(
    missing,
    [],
    `MCP tools with no hopa verb: ${missing.join(', ')} — add a verb (or alias) to hopa's VERBS map`
  );
});

test('every hopa verb points at a real MCP tool (no typos)', () => {
  const toolNames = new Set(toolDefinitions().map((d) => d.name));
  const bogus = Object.entries(hopa.VERBS)
    .filter(([, v]) => !toolNames.has(v.tool))
    .map(([verb, v]) => `${verb} -> ${v.tool}`);
  assert.deepStrictEqual(bogus, [], `hopa verbs pointing at unknown tools: ${bogus.join(', ')}`);
});

test('verb resolution: groups, aliases, bare default', () => {
  assert.strictEqual(hopa.resolveVerb([]).spec.tool, 'hopx_agents_overview');
  assert.strictEqual(hopa.resolveVerb(['agents']).spec.tool, 'hopx_agents_overview');
  assert.strictEqual(hopa.resolveVerb(['term', 'ls']).spec.tool, 'hop_list_terminals');
  assert.strictEqual(hopa.resolveVerb(['t', 'read', 'x']).spec.tool, 'hop_read_terminal');
  assert.strictEqual(hopa.resolveVerb(['ws', 'rm', 'x']).spec.tool, 'hop_delete_workspace');
  assert.strictEqual(hopa.resolveVerb(['no-such-verb']), null);
});

test('flag names normalize to the schema spelling (snake and camel)', () => {
  const props = { until_regex: {}, uiMaxLines: {}, max_wait_ms: {} };
  assert.strictEqual(hopa.normalizeFlagKey('until-regex', props), 'until_regex');
  assert.strictEqual(hopa.normalizeFlagKey('ui-max-lines', props), 'uiMaxLines');
  assert.strictEqual(hopa.normalizeFlagKey('max-wait-ms', props), 'max_wait_ms');
  assert.strictEqual(hopa.normalizeFlagKey('until_regex', props), 'until_regex');
  // unknown keys fall back to snake_case
  assert.strictEqual(hopa.normalizeFlagKey('some-new-arg', props), 'some_new_arg');
});

test('values coerce by schema type', () => {
  assert.strictEqual(hopa.coerceValue('42', { type: 'number' }), 42);
  assert.strictEqual(hopa.coerceValue('false', { type: 'boolean' }), false);
  assert.strictEqual(hopa.coerceValue(true, { type: 'boolean' }), true);
  assert.deepStrictEqual(hopa.coerceValue('["a","b"]', { type: 'array' }), ['a', 'b']);
  assert.deepStrictEqual(hopa.coerceValue('a,b', { type: 'array' }), ['a', 'b']);
  assert.strictEqual(hopa.coerceValue('7', {}), '7'); // untyped stays string
});

test('buildArgs: positionals, rest join, -- verbatim, arrays, presets', () => {
  const schema = (tool) => {
    const def = toolDefinitions().find((d) => d.name === tool);
    return def;
  };

  // exec: `--` keeps the command verbatim, including flag-looking tokens
  const exec = hopa.buildArgs(
    hopa.VERBS.exec,
    ['my-term', '--timeout-ms', '5000', '--', 'ls', '-la', '--color'],
    schema('hopx_exec')
  );
  assert.strictEqual(exec.args.terminal_id, 'my-term');
  assert.strictEqual(exec.args.timeout_ms, 5000);
  assert.strictEqual(exec.args.command, 'ls -la --color');

  // send: rest tokens join with spaces
  const send = hopa.buildArgs(hopa.VERBS.send, ['t1', 'hello', 'world'], schema('hopx_send_and_wait'));
  assert.strictEqual(send.args.data, 'hello world');

  // wait-any: rest collects an array
  const waitAny = hopa.buildArgs(hopa.VERBS['wait-any'], ['t1', 't2', 't3'], schema('hopx_wait_any'));
  assert.deepStrictEqual(waitAny.args.terminal_ids, ['t1', 't2', 't3']);

  // resize: numeric positionals coerce via schema
  const resize = hopa.buildArgs(
    hopa.VERBS['term resize'],
    ['t1', '120', '40'],
    schema('hop_resize_terminal')
  );
  assert.strictEqual(resize.args.cols, 120);
  assert.strictEqual(resize.args.rows, 40);

  // permit/block presets
  const permit = hopa.buildArgs(hopa.VERBS.permit, ['Venus'], schema('hop_set_agent_permission'));
  assert.strictEqual(permit.args.allowed, true);
  assert.strictEqual(permit.args.name, 'Venus');
  const block = hopa.buildArgs(hopa.VERBS.block, ['Venus'], schema('hop_set_agent_permission'));
  assert.strictEqual(block.args.allowed, false);

  // global flags stay out of tool args
  const read = hopa.buildArgs(
    hopa.VERBS['term read'],
    ['t1', '--mode', 'ui', '--json'],
    schema('hop_read_terminal')
  );
  assert.strictEqual(read.args.mode, 'ui');
  assert.strictEqual(read.global.json, true);
  assert.strictEqual(read.args.json, undefined);
});

test('requiring hopa as a module does not clobber console.error', () => {
  assert.notStrictEqual(console.error.toString(), '() => {}');
});
