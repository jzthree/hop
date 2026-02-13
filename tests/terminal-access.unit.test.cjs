const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromHeaders, canActorAccessSession } = require('../lib/terminal-access');

test('resolveActorFromHeaders defaults to user', () => {
  assert.equal(resolveActorFromHeaders({}), 'user');
  assert.equal(resolveActorFromHeaders(null), 'user');
});

test('resolveActorFromHeaders detects agent header', () => {
  assert.equal(resolveActorFromHeaders({ 'x-hop-actor': 'agent' }), 'agent');
  assert.equal(resolveActorFromHeaders({ 'x-hop-actor': 'Agent' }), 'agent');
  assert.equal(resolveActorFromHeaders({ 'x-hop-actor': 'USER' }), 'user');
});

test('canActorAccessSession allows users and respects agentPermitted', () => {
  assert.equal(canActorAccessSession('user', {}), true);
  assert.equal(canActorAccessSession('agent', {}), false);
  assert.equal(canActorAccessSession('agent', { agentPermitted: false }), false);
  assert.equal(canActorAccessSession('agent', { agentPermitted: true }), true);
});
