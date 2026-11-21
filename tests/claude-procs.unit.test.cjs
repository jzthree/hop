// Which claude holds a conversation: a fork of it does not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resumeProcesses } = require('../lib/claude-procs');

const ID = '7c643c02-bf17-4a58-974e-abdefe42d9f8';
const ps = [
    `86902 ttys031 /bin/zsh -lc claude --resume ${ID} --fork-session; exec /bin/zsh -l`,
    `86912 ttys031 claude --resume ${ID} --fork-session`,
    `58590 ttys012 claude --dangerously-skip-permissions --resume ${ID}`,
    `11111 ??      ps -axo pid=,tty=,command=`,
    `22222 ttys040 grep ${ID}`,
    `33333 ttys041 tail -f /Users/x/.claude/projects/p/${ID}.jsonl`,
    `44444 ttys042 claude --resume=${ID}0`,
    `55555 ttys043 /opt/homebrew/bin/claude --resume=${ID} --model claude-fable-5-1`
].join('\n');

test('a fork names its origin but does not hold it; the conversation itself is found with its terminal', () => {
    assert.deepEqual(resumeProcesses(ps, ID), [{ pid: 58590, tty: 'ttys012' }, { pid: 55555, tty: 'ttys043' }]);
});

test('only a fork running: the conversation is not open', () => {
    const forks = ps.split('\n').filter((l) => l.includes('fork-session')).join('\n');
    assert.deepEqual(resumeProcesses(forks, ID), []);
    assert.deepEqual(resumeProcesses(ps, ''), []);
    assert.deepEqual(resumeProcesses('', ID), []);
});
