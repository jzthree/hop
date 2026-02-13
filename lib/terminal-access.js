const DEFAULT_HEADER = 'x-hop-actor';

function resolveActorFromHeaders(headers, headerName = DEFAULT_HEADER) {
  if (!headers || typeof headers !== 'object') return 'user';
  const raw = String(headers[headerName] || '').toLowerCase();
  return raw === 'agent' ? 'agent' : 'user';
}

function canActorAccessSession(actor, config) {
  if (actor !== 'agent') return true;
  return config?.agentPermitted === true;
}

module.exports = {
  resolveActorFromHeaders,
  canActorAccessSession
};
