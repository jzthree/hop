// Hay - Terminal sharing for Hop
// Provides terminal sharing with presence indicators and control modes

const { spawn } = require('child_process');
const EventEmitter = require('events');
const WebSocket = require('ws');
const os = require('os');

// Try to load node-pty
let pty;
try {
    pty = require('node-pty-prebuilt-multiarch');
} catch (e) {
    console.warn('Warning: node-pty-prebuilt-multiarch not found. Terminal sessions will not work.');
}

const MAX_OUTPUT_BUFFER = 200000; // 200KB buffer for reconnecting clients
const ROOM_CLEANUP_DELAY = 300000; // 5 minutes before cleaning up empty rooms (allow reconnection)

// Presence colors (same as termshare)
const COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e',
    '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
    '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e'
];

function pickPresenceColor(index) {
    return COLORS[index % COLORS.length];
}

function sanitizeName(name) {
    if (!name || typeof name !== 'string') return 'Anonymous';
    return name.slice(0, 32).replace(/[^\w\s-]/g, '').trim() || 'Anonymous';
}

function sanitizeRoom(room) {
    if (!room || typeof room !== 'string') return 'default';
    return room.slice(0, 64).replace(/[^\w-]/g, '').toLowerCase() || 'default';
}

function now() {
    return Date.now();
}

function clampBuffer(buf) {
    if (buf.length > MAX_OUTPUT_BUFFER) {
        return buf.slice(-MAX_OUTPUT_BUFFER);
    }
    return buf;
}

// Parse client messages safely
function safeParseClientMessage(data) {
    try {
        const msg = JSON.parse(data);
        if (typeof msg !== 'object' || msg === null) return null;
        return msg;
    } catch {
        return null;
    }
}

// Create PTY factory
function createPty(options = {}) {
    if (!pty) {
        throw new Error('node-pty not available');
    }

    const shell = options.shell || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
    // Use provided cwd, or default to current working directory (not home)
    const cwd = options.cwd || process.cwd();
    const env = options.env || { ...process.env, TERM: 'xterm-256color' };
    const cols = options.cols || 80;
    const rows = options.rows || 24;

    return pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env
    });
}

// Room class - manages a terminal session with multiple clients
class Room extends EventEmitter {
    constructor(id, ptyFactory, initialSize, cwd) {
        super();
        this.id = id;
        this.clients = new Map();
        this.collabMode = true;
        this.controllerId = null;
        this.outputBuffer = '';
        this.cleanupTimer = null;

        this.pty = ptyFactory({ cols: initialSize.cols, rows: initialSize.rows, cwd });

        this.pty.onData((data) => {
            this.outputBuffer = clampBuffer(this.outputBuffer + data);
            this.broadcast({ type: 'output', data });
        });

        this.pty.onExit(() => {
            this.emit('exit');
        });
    }

    attachClient(info, socket) {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        const client = {
            id: info.id,
            name: info.name,
            color: pickPresenceColor(info.colorIndex),
            lastActive: now(),
            typing: false,
            cols: info.cols || 80,
            rows: info.rows || 24,
            socket
        };

        this.clients.set(info.id, client);

        // Send hello with room state
        socket.send(JSON.stringify({
            type: 'hello',
            clientId: info.id,
            collabMode: this.collabMode,
            controllerId: this.controllerId
        }));

        // Send output buffer snapshot
        if (this.outputBuffer) {
            socket.send(JSON.stringify({
                type: 'snapshot',
                data: this.outputBuffer
            }));
        }

        // Broadcast presence update
        this.broadcastPresence();

        // Handle incoming messages
        socket.onMessage((data) => {
            const msg = safeParseClientMessage(data);
            if (!msg) return;
            this.handleClientMessage(client, msg);
        });

        // Handle disconnect
        socket.onClose(() => {
            this.clients.delete(info.id);
            if (this.controllerId === info.id) {
                this.controllerId = null;
            }
            this.broadcastPresence();
            this.maybeScheduleCleanup();
        });

        // Auto-assign controller if locked mode and no controller
        if (!this.collabMode && !this.controllerId) {
            this.controllerId = info.id;
        }
    }

    handleClientMessage(client, msg) {
        switch (msg.type) {
            case 'input':
                this.handleInput(client, msg.data);
                break;
            case 'resize':
                this.handleResize(client, msg.cols, msg.rows);
                break;
            case 'typing':
                this.handleTyping(client, msg.active);
                break;
            case 'toggle_collab':
                this.handleToggleCollab(client, msg.enabled);
                break;
            case 'take_control':
                this.handleTakeControl(client);
                break;
            case 'release_control':
                this.handleReleaseControl(client);
                break;
            case 'kill_session':
                // Notify clients before closing
                for (const c of this.clients.values()) {
                    try {
                        c.socket.send(JSON.stringify({ type: 'error', message: 'Session terminated' }));
                    } catch (e) {}
                }
                this.close();
                this.emit('exit');
                break;
        }
    }

    handleInput(client, data) {
        if (!data || typeof data !== 'string') return;

        // Check if client can type
        if (!this.collabMode && this.controllerId && this.controllerId !== client.id) {
            client.socket.send(JSON.stringify({
                type: 'input_rejected',
                reason: 'Control is locked to another user'
            }));
            return;
        }

        client.lastActive = now();
        this.pty.write(data);
    }

    handleResize(client, cols, rows) {
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
        if (cols < 1 || cols > 500 || rows < 1 || rows > 200) return;

        client.cols = cols;
        client.rows = rows;
        // Only resize PTY if this client is the most recently active (was typing)
        // This prevents disrupting the active typer when others resize their windows
        const isActive = [...this.clients.values()].every(c => c.lastActive <= client.lastActive);
        if (isActive) {
            this.pty.resize(cols, rows);
        }
    }

    broadcastActiveSize(client) {
        // Broadcast to OTHER clients (not the one typing)
        const msg = JSON.stringify({
            type: 'active_size',
            clientId: client.id,
            cols: client.cols,
            rows: client.rows
        });
        for (const c of this.clients.values()) {
            if (c.id !== client.id && c.socket.isOpen && c.socket.isOpen()) {
                try {
                    c.socket.send(msg);
                } catch (e) {
                    // Ignore send errors
                }
            }
        }
    }

    handleTyping(client, active) {
        client.typing = !!active;
        client.lastActive = now();
        this.broadcastPresence();
    }

    handleToggleCollab(client, enabled) {
        this.collabMode = !!enabled;
        if (!this.collabMode && !this.controllerId) {
            this.controllerId = client.id;
        }
        this.broadcast({
            type: 'collab',
            enabled: this.collabMode,
            controllerId: this.controllerId
        });
    }

    handleTakeControl(client) {
        if (this.collabMode) return;
        this.controllerId = client.id;
        this.broadcast({
            type: 'collab',
            enabled: false,
            controllerId: this.controllerId
        });
    }

    handleReleaseControl(client) {
        if (this.controllerId === client.id) {
            this.controllerId = null;
            this.broadcast({
                type: 'collab',
                enabled: this.collabMode,
                controllerId: null
            });
        }
    }

    broadcast(msg) {
        const data = JSON.stringify(msg);
        for (const client of this.clients.values()) {
            try {
                if (client.socket.isOpen && client.socket.isOpen()) {
                    client.socket.send(data);
                }
            } catch (e) {
                // Ignore send errors
            }
        }
    }

    broadcastPresence() {
        const clients = Array.from(this.clients.values()).map(c => ({
            id: c.id,
            name: c.name,
            color: c.color,
            lastActive: c.lastActive,
            typing: c.typing
        }));
        this.broadcast({ type: 'presence', clients });
    }

    maybeScheduleCleanup() {
        if (this.clients.size === 0 && !this.cleanupTimer) {
            this.cleanupTimer = setTimeout(() => {
                if (this.clients.size === 0) {
                    this.emit('empty');
                }
            }, ROOM_CLEANUP_DELAY);
        }
    }

    close() {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
        }
        try {
            this.pty.kill();
        } catch (e) {
            // Ignore
        }
        for (const client of this.clients.values()) {
            try {
                client.socket.close && client.socket.close();
            } catch (e) {
                // Ignore
            }
        }
        this.clients.clear();
    }
}

// Room manager - manages multiple rooms
class RoomManager {
    constructor(ptyFactory = createPty, cwd) {
        this.rooms = new Map();
        this.ptyFactory = ptyFactory;
        this.cwd = cwd; // Default cwd for new rooms
    }

    getRoom(id, initialSize = { cols: 80, rows: 24 }, cwd) {
        if (!this.rooms.has(id)) {
            const room = new Room(id, this.ptyFactory, initialSize, cwd || this.cwd);
            room.on('empty', () => {
                room.close();
                this.rooms.delete(id);
            });
            room.on('exit', () => {
                room.close();
                this.rooms.delete(id);
            });
            this.rooms.set(id, room);
        }
        return this.rooms.get(id);
    }

    hasRoom(id) {
        return this.rooms.has(id);
    }

    closeRoom(id) {
        const room = this.rooms.get(id);
        if (room) {
            room.close();
            this.rooms.delete(id);
        }
    }

    closeAll() {
        for (const room of this.rooms.values()) {
            room.close();
        }
        this.rooms.clear();
    }
}

// Create socket adapter from ws WebSocket
function createSocketAdapter(ws) {
    return {
        send: (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        },
        onMessage: (handler) => {
            ws.on('message', (data) => handler(data.toString()));
        },
        onClose: (handler) => {
            ws.on('close', handler);
        },
        onError: (handler) => {
            ws.on('error', handler);
        },
        isOpen: () => ws.readyState === WebSocket.OPEN,
        close: () => ws.close()
    };
}

// Generate unique client ID
function generateClientId() {
    return require('crypto').randomUUID();
}

// Note: Local terminal attachment is now handled by the hay CLI
// (apps/cli in hay/) to avoid duplicate implementations

module.exports = {
    Room,
    RoomManager,
    createPty,
    createSocketAdapter,
    generateClientId,
    sanitizeName,
    sanitizeRoom,
    pickPresenceColor,
    safeParseClientMessage
};
