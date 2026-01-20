import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import {
  safeParseServerMessage,
  type PresenceClient,
  type ClientMessage
} from "hay-shared";
import { activityLabel, sortPresence } from "./utils/presence";
import { createOptimisticEcho } from "./utils/optimisticEcho";
import { MobileKeyboard } from "./components/MobileKeyboard";

const createRoomId = () => `room-${Math.random().toString(36).slice(2, 7)}`;

const resolveWsUrl = () => {
  // Check for hop session config (when embedded in hop)
  const hopSession = (window as unknown as { __HOP_SESSION__?: { wsUrl?: string } }).__HOP_SESSION__;
  if (hopSession?.wsUrl) {
    const { protocol, host } = window.location;
    const wsProtocol = protocol === "https:" ? "wss" : "ws";
    return `${wsProtocol}://${host}${hopSession.wsUrl}`;
  }
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL as string;
  }
  const { protocol, hostname, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss" : "ws";
  if (import.meta.env.DEV) {
    return `${wsProtocol}://${hostname}:4001/ws`;
  }
  return `${wsProtocol}://${host}/ws`;
};

const formatStatus = (client: PresenceClient) => {
  const state = activityLabel(client);
  if (state === "typing") {
    return "typing";
  }
  if (state === "active") {
    return "active";
  }
  return "idle";
};

const createShareLink = (room: string) => {
  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  url.searchParams.delete("name");
  return url.toString();
};

const terminalTheme = {
  background: "#0b1117",
  foreground: "#e6edf3",
  cursor: "#f97316",
  selection: "#1f2937",
  black: "#0b1117",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#d946ef",
  cyan: "#14b8a6",
  white: "#e5e7eb"
};

const isMobileDevice = () => {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android/i.test(ua) || window.innerWidth < 768;
};

type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";

type SessionInfo = {
  name: string;
  displayName: string;
  active: boolean;
  starting: boolean;
  type?: "terminal" | "port";
  port?: number;
};

// Check if embedded in Hop
const getHopSession = () => (window as unknown as { __HOP_SESSION__?: { room?: string; wsUrl?: string } }).__HOP_SESSION__;
const isEmbeddedInHop = () => !!getHopSession()?.room;

const App = () => {
  const params = new URLSearchParams(window.location.search);
  const hopSession = getHopSession();

  const [name, setName] = useState(() => {
    return params.get("name") ?? localStorage.getItem("hay_name") ?? "User";
  });
  const [room, setRoom] = useState(() => {
    if (hopSession?.room) return hopSession.room;
    return params.get("room") ?? createRoomId();
  });
  // Auto-start session when embedded in Hop (skip join page)
  const [session, setSession] = useState<{ name: string; room: string } | null>(() => {
    if (hopSession?.room) {
      const userName = params.get("name") ?? localStorage.getItem("hay_name") ?? "User";
      return { name: userName, room: hopSession.room };
    }
    return null;
  });
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [presence, setPresence] = useState<PresenceClient[]>([]);
  const [collabMode, setCollabMode] = useState(true);
  const [controllerId, setControllerId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [followOutput, setFollowOutput] = useState(true);
  const [latencyComp, setLatencyComp] = useState(true);
  const [autoFitOnType, setAutoFitOnType] = useState(true);
  const [terminalReady, setTerminalReady] = useState(false);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fabPosition, setFabPosition] = useState({ x: 20, y: window.innerHeight - 80 });
  const fabDragRef = useRef<{ dragging: boolean; startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const [isMobile] = useState(() => isMobileDevice());
  const [keyboardVisible, setKeyboardVisible] = useState(() => isMobileDevice());
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem("hay_font_size");
    return saved ? parseInt(saved, 10) : 14;
  });
  const [viewMode, setViewMode] = useState<"fit" | "full">(() => {
    const saved = localStorage.getItem("hay_view_mode");
    return saved === "fit" ? "fit" : "full"; // Default to full
  });

  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const optimisticEchoRef = useRef(createOptimisticEcho());
  const optimisticPrevRef = useRef(false);
  const typingTimeout = useRef<number | null>(null);
  const typingActive = useRef(false);
  const noticeTimeout = useRef<number | null>(null);
  const autoFitOnTypeRef = useRef(autoFitOnType);
  const viewModeRef = useRef(viewMode);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);

  const shareUrl = useMemo(() => {
    return session ? createShareLink(session.room) : createShareLink(room);
  }, [session, room]);

  const pushNotice = (message: string) => {
    setNotice(message);
    if (noticeTimeout.current) {
      window.clearTimeout(noticeTimeout.current);
    }
    noticeTimeout.current = window.setTimeout(() => {
      setNotice(null);
    }, 3000);
  };

  const sortedPresence = useMemo(() => sortPresence(presence, clientId), [presence, clientId]);

  const controllerName = useMemo(() => {
    if (!controllerId) {
      return "";
    }
    return presence.find((client) => client.id === controllerId)?.name ?? "Someone";
  }, [presence, controllerId]);

  const optimisticActive =
    latencyComp && status === "connected" && !collabMode && controllerId === clientId;

  useEffect(() => {
    if (optimisticPrevRef.current && !optimisticActive) {
      optimisticEchoRef.current.reset();
    }
    optimisticPrevRef.current = optimisticActive;
  }, [optimisticActive]);

  useEffect(() => {
    autoFitOnTypeRef.current = autoFitOnType;
  }, [autoFitOnType]);

  useEffect(() => {
    viewModeRef.current = viewMode;
    localStorage.setItem("hay_view_mode", viewMode);
    // When switching to fit mode, refit terminal
    if (viewMode === "fit" && termRef.current) {
      setTimeout(() => {
        fitToViewport();
        handleResize();
      }, 0);
    }
  }, [viewMode]);

  const sendMessage = (message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  };

  const sendTyping = (active: boolean) => {
    sendMessage({ type: "typing", active });
  };

  const handleUserInput = (data: string) => {
    // Strip focus reporting sequences that can be echoed back as visible text
    const sanitized = data.replace(/\x1b\[I/g, '').replace(/\x1b\[O/g, '');
    if (!sanitized) {
      return;
    }
    const echoed = optimisticEchoRef.current.onInput(sanitized, optimisticActive);
    if (echoed) {
      writeToTerminal(echoed);
    }
    sendMessage({ type: "input", data: sanitized });
    if (autoFitOnTypeRef.current && viewModeRef.current === "fit") {
      fitToViewport();
      handleResize();
    }
    if (!typingActive.current) {
      typingActive.current = true;
      sendTyping(true);
    }
    if (typingTimeout.current) {
      window.clearTimeout(typingTimeout.current);
    }
    typingTimeout.current = window.setTimeout(() => {
      typingActive.current = false;
      sendTyping(false);
    }, 1200);
  };

  const handleResize = () => {
    if (!termRef.current) {
      return;
    }
    sendMessage({ type: "resize", cols: termRef.current.cols, rows: termRef.current.rows });
  };

  // Fit based on the scroll container viewport rather than the terminal element itself.
  // This ensures correct sizing across desktop padding and mobile full-bleed layouts.
  const fitToViewport = () => {
    if (!termRef.current || !containerRef.current) return;

    const terminal = termRef.current;
    const core = (terminal as any)._core;
    if (!core?._renderService?.dimensions?.css?.cell) return;

    const cellWidth = core._renderService.dimensions.css.cell.width;
    const cellHeight = core._renderService.dimensions.css.cell.height;
    if (!cellWidth || !cellHeight) return;

    const scrollContainer = containerRef.current.closest(".terminal-scroll");
    if (!scrollContainer) return;

    const rect = scrollContainer.getBoundingClientRect();
    const styles = window.getComputedStyle(scrollContainer);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;

    const availableWidth = rect.width - paddingLeft - paddingRight;
    const availableHeight = rect.height - paddingTop - paddingBottom;

    const cols = Math.max(2, Math.floor(availableWidth / cellWidth));
    const rows = Math.max(1, Math.floor(availableHeight / cellHeight));

    if (terminal.cols !== cols || terminal.rows !== rows) {
      terminal.resize(cols, rows);
    }
  };

  const scrollToCursor = (force: boolean) => {
    if (!termRef.current || !containerRef.current) return;

    const terminal = termRef.current;
    const scrollContainer = containerRef.current?.closest(".terminal-scroll");
    if (!scrollContainer) return;

    const core = (terminal as any)._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (!cell?.width || !cell?.height) return;

    const cursorX = terminal.buffer.active.cursorX;
    const cursorY = terminal.buffer.active.cursorY;
    const cursorLeft = cursorX * cell.width;
    const cursorTop = cursorY * cell.height;
    const cursorRight = cursorLeft + cell.width;
    const cursorBottom = cursorTop + cell.height;

    const viewportLeft = scrollContainer.scrollLeft;
    const viewportTop = scrollContainer.scrollTop;
    const viewportRight = viewportLeft + scrollContainer.clientWidth;
    const viewportBottom = viewportTop + scrollContainer.clientHeight;

    const needsX = cursorLeft < viewportLeft || cursorRight > viewportRight;
    const needsY = cursorTop < viewportTop || cursorBottom > viewportBottom;
    if (!force && !needsX && !needsY) return;

    let nextLeft = viewportLeft;
    let nextTop = viewportTop;

    if (cursorLeft < viewportLeft) {
      nextLeft = cursorLeft;
    } else if (cursorRight > viewportRight) {
      nextLeft = cursorRight - scrollContainer.clientWidth;
    }

    if (cursorTop < viewportTop) {
      nextTop = cursorTop;
    } else if (cursorBottom > viewportBottom) {
      nextTop = cursorBottom - scrollContainer.clientHeight;
    }

    const maxLeft = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth);
    const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    scrollContainer.scrollLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    scrollContainer.scrollTop = Math.max(0, Math.min(nextTop, maxTop));
  };

  const writeToTerminal = (data: string) => {
    if (!termRef.current) {
      return;
    }
    // Filter focus reporting sequences that can leak as visible text
    const filtered = data.replace(/\x1b\[I/g, '').replace(/\x1b\[O/g, '');
    termRef.current.write(filtered, () => {
      if (followOutput) {
        termRef.current?.scrollToBottom();
        scrollToCursor(false);
      }
    });
  };

  const scheduleReconnect = (nextSession: { name: string; room: string }) => {
    if (!shouldReconnectRef.current) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
    reconnectAttemptRef.current += 1;

    pushNotice(`Reconnecting in ${Math.round(delay / 1000)}s...`);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (shouldReconnectRef.current) {
        connect(nextSession);
      }
    }, delay);
  };

  const connect = (nextSession: { name: string; room: string }) => {
    // Clear any pending reconnect
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const wsUrl = resolveWsUrl();
    const cols = termRef.current?.cols ?? 80;
    const rows = termRef.current?.rows ?? 24;
    const url = `${wsUrl}?room=${encodeURIComponent(nextSession.room)}&name=${encodeURIComponent(
      nextSession.name
    )}&cols=${cols}&rows=${rows}`;

    wsRef.current?.close();
    setStatus("connecting");
    shouldReconnectRef.current = true;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setStatus("connected");
      reconnectAttemptRef.current = 0; // Reset backoff on successful connection
      handleResize();
    });

    ws.addEventListener("message", (event) => {
      const message = safeParseServerMessage(event.data);
      if (!message) {
        return;
      }
      switch (message.type) {
        case "hello":
          setClientId(message.clientId);
          setCollabMode(message.collabMode);
          setControllerId(message.controllerId);
          break;
        case "presence":
          setPresence(message.clients);
          break;
        case "output":
          {
            const reconciled = optimisticEchoRef.current.reconcileOutput(message.data);
            if (reconciled) {
              writeToTerminal(reconciled);
            }
          }
          break;
        case "snapshot":
          optimisticEchoRef.current.reset();
          if (termRef.current) {
            // Clear buffer without resetting modes to preserve existing terminal state on reconnect.
            termRef.current.clear();
          }
          writeToTerminal(message.data);
          break;
        case "collab":
          setCollabMode(message.enabled);
          setControllerId(message.controllerId);
          pushNotice(message.enabled ? "Collaborative typing enabled" : "Control locked to a single editor");
          break;
        case "input_rejected":
          pushNotice(message.reason);
          break;
        case "active_size":
          // Resize terminal to match active user's size.
          // This allows overflow/panning when the active user is larger than the viewport.
          if (termRef.current) {
            const currentCols = termRef.current.cols;
            const currentRows = termRef.current.rows;
            if (message.cols !== currentCols || message.rows !== currentRows) {
              termRef.current.resize(message.cols, message.rows);
              scrollToCursor(true);
            }
          }
          break;
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      optimisticEchoRef.current.reset();
      setStatus("disconnected");
      scheduleReconnect(nextSession);
    });

    ws.addEventListener("error", () => {
      optimisticEchoRef.current.reset();
      setStatus("disconnected");
      // Error is usually followed by close, so don't double-schedule
    });
  };

  useEffect(() => {
    if (!session || !terminalReady) {
      return;
    }
    connect(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, terminalReady, reconnectToken]);

  useEffect(() => {
    if (!session || !containerRef.current || termRef.current) {
      return;
    }

    const terminal = new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize,
      lineHeight: 1.3,
      cursorBlink: true,
      theme: terminalTheme
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    termRef.current = terminal;
    fitRef.current = fitAddon;
    if (viewModeRef.current === "fit") {
      setTimeout(() => {
        fitToViewport();
        handleResize();
      }, 0);
    }

    // Register OSC handlers for sequences xterm.js doesn't fully support
    // These swallow the sequences so they don't appear as visible text
    const oscIds = [
      4,   // Color palette query/set
      10,  // Foreground color query/set
      11,  // Background color query/set
      12,  // Cursor color query/set
      52,  // Clipboard operations
      104, // Reset color palette
      110, // Reset foreground color
      111, // Reset background color
      112  // Reset cursor color
    ];
    for (const id of oscIds) {
      terminal.parser.registerOscHandler(id, () => true);
    }

    // Register CSI handlers for focus reporting sequences
    // ESC[I = Focus In, ESC[O = Focus Out
    terminal.parser.registerCsiHandler({ final: 'I' }, () => true);
    terminal.parser.registerCsiHandler({ final: 'O' }, () => true);

    setTerminalReady(true);

    // On mobile, disable the terminal's internal textarea to prevent:
    // 1. Native keyboard from appearing when touching terminal
    // 2. Double input from xterm's internal event handling
    if (isMobile) {
      const textarea = containerRef.current.querySelector('textarea');
      if (textarea) {
        textarea.setAttribute('readonly', 'true');
        textarea.setAttribute('tabindex', '-1');
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
      }
    } else {
      // Desktop: register onData for keyboard input
      terminal.onData(handleUserInput);
    }

    // Prevent browser from intercepting common terminal shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Allow ctrl+shift+c/v for copy/paste
      if (event.ctrlKey && event.shiftKey && (event.key === 'c' || event.key === 'v')) {
        return false;
      }
      // Capture all other ctrl key combinations for the terminal
      if (event.ctrlKey && !event.altKey && !event.metaKey) {
        return true;
      }
      return true;
    });

    const resizeObserver = new ResizeObserver(() => {
      // Only auto-fit in fit mode
      if (viewModeRef.current === "fit") {
        fitToViewport();
        // Force a full refresh to clear any stale canvas content after resize
        terminal.refresh(0, terminal.rows - 1);
        handleResize();
      }
    });

    const scrollContainer = containerRef.current.closest(".terminal-scroll");
    if (scrollContainer) {
      resizeObserver.observe(scrollContainer);
    }

    // Mobile touch scrolling with momentum (native-feeling)
    // xterm.js has the viewport underneath the rows, so native scroll doesn't work
    // We implement our own with inertia/momentum for iOS-like feel
    if (isMobile && containerRef.current) {
      let lastY = 0;
      let scrollDebt = 0; // Accumulated sub-line scroll distance
      let velocitySamples: number[] = []; // Recent velocities for smoothing
      let lastMoveTime = 0;
      let momentumVelocity = 0;
      let momentumId: number | null = null;
      let isScrolling = false;
      let isPanning = false;
      let panStartScrollLeft = 0;
      let panStartScrollTop = 0;
      let panStartX = 0;
      let panStartY = 0;

      const getCellHeight = () => {
        const core = (terminal as any)._core;
        const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
        return cellHeight && cellHeight > 0 ? cellHeight : 18;
      };

      const getTwoFingerCenter = (touches: TouchList) => {
        const x = (touches[0].clientX + touches[1].clientX) / 2;
        const y = (touches[0].clientY + touches[1].clientY) / 2;
        return { x, y };
      };

      const friction = 0.94; // Momentum decay (higher = longer coast)
      const minMomentumVelocity = 0.25; // Minimum px/frame to continue momentum

      const stopMomentum = () => {
        if (momentumId !== null) {
          cancelAnimationFrame(momentumId);
          momentumId = null;
        }
        momentumVelocity = 0;
      };

      const applyMomentum = () => {
        if (Math.abs(momentumVelocity) < minMomentumVelocity) {
          momentumId = null;
          return;
        }

        // Apply momentum as fractional scroll
        scrollDebt += momentumVelocity;
        const lines = Math.trunc(scrollDebt / getCellHeight());
        if (lines !== 0) {
          terminal.scrollLines(lines);
          scrollDebt -= lines * getCellHeight();
        }

        momentumVelocity *= friction;
        momentumId = requestAnimationFrame(applyMomentum);
      };

      const handleTouchStart = (e: TouchEvent) => {
        stopMomentum();
        if (e.cancelable) {
          e.preventDefault();
        }

        if (e.touches.length === 2) {
          isPanning = true;
          const center = getTwoFingerCenter(e.touches);
          panStartX = center.x;
          panStartY = center.y;
          const panTarget = containerRef.current?.closest(".terminal-scroll");
          if (panTarget) {
            panStartScrollLeft = panTarget.scrollLeft;
            panStartScrollTop = panTarget.scrollTop;
          }
          return;
        }

        if (e.touches.length !== 1) {
          isPanning = false;
          isScrolling = false;
          return;
        }

        isPanning = false;
        lastY = e.touches[0].clientY;
        lastMoveTime = Date.now();
        scrollDebt = 0;
        velocitySamples = [];
        isScrolling = true;
      };

      const handleTouchMove = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          if (!isPanning) {
            isPanning = true;
            const center = getTwoFingerCenter(e.touches);
            panStartX = center.x;
            panStartY = center.y;
            const panTarget = containerRef.current?.closest(".terminal-scroll");
            if (panTarget) {
              panStartScrollLeft = panTarget.scrollLeft;
              panStartScrollTop = panTarget.scrollTop;
            }
          }

          const center = getTwoFingerCenter(e.touches);
          const deltaX = panStartX - center.x;
          const deltaY = panStartY - center.y;
          const panTarget = containerRef.current?.closest(".terminal-scroll");
          if (panTarget) {
            panTarget.scrollLeft = panStartScrollLeft + deltaX;
            panTarget.scrollTop = panStartScrollTop + deltaY;
          }
          e.preventDefault();
          return;
        }

        if (e.touches.length !== 1) return;

        if (isPanning) {
          isPanning = false;
          isScrolling = true;
        }

        const touchY = e.touches[0].clientY;
        const now = Date.now();
        const deltaY = lastY - touchY; // positive = scroll down (finger up)
        const deltaTime = Math.max(1, now - lastMoveTime);

        // ALWAYS track velocity (even before direction is locked)
        // This ensures quick flicks have velocity data
        if (deltaTime > 0 && deltaTime < 100) { // Ignore stale samples
          velocitySamples.push(deltaY / deltaTime);
          if (velocitySamples.length > 5) velocitySamples.shift();
        }

        e.preventDefault();
        // Accumulate scroll and apply whole lines
        scrollDebt += deltaY;
        const lines = Math.trunc(scrollDebt / getCellHeight());
        if (lines !== 0) {
          terminal.scrollLines(lines);
          scrollDebt -= lines * getCellHeight();
        }

        lastY = touchY;
        lastMoveTime = now;
      };

      const handleTouchEnd = () => {
        if (isPanning) {
          isPanning = false;
          return;
        }

        // Only apply momentum if we were scrolling vertically
        if (isScrolling && velocitySamples.length > 0) {
          // Use peak velocity (max absolute value) - users often slow down at end of flick
          // but we want to capture their flick intent, not their stopping motion
          let peakVelocity = 0;
          for (const v of velocitySamples) {
            if (Math.abs(v) > Math.abs(peakVelocity)) {
              peakVelocity = v;
            }
          }
          // Convert to pixels per frame (~16ms)
          momentumVelocity = peakVelocity * 16;

          // Start momentum if significant (lowered threshold for responsiveness)
          if (Math.abs(momentumVelocity) >= minMomentumVelocity) {
            momentumId = requestAnimationFrame(applyMomentum);
          }
        }
        isScrolling = false;
      };

      const container = containerRef.current.closest(".terminal-scroll");
      if (!container) {
        return;
      }
      // Use capture: true to intercept events before xterm's internal handlers
      container.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
      container.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
      container.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
      container.addEventListener('touchcancel', handleTouchEnd, { passive: true, capture: true });

      // Store cleanup handlers
      (terminal as any).__touchCleanup = () => {
        stopMomentum();
        container.removeEventListener('touchstart', handleTouchStart, { capture: true });
        container.removeEventListener('touchmove', handleTouchMove, { capture: true });
        container.removeEventListener('touchend', handleTouchEnd, { capture: true });
        container.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
      };
    }

    if (import.meta.env.VITE_E2E === "true") {
      (window as any).__hay = {
        getBufferText: () => {
          const buffer = terminal.buffer.active;
          let text = "";
          for (let i = 0; i < buffer.length; i += 1) {
            text += `${buffer.getLine(i)?.translateToString(true) ?? ""}\n`;
          }
          return text;
        }
      };
    }

    return () => {
      resizeObserver.disconnect();
      // Clean up touch handlers
      if ((terminal as any).__touchCleanup) {
        (terminal as any).__touchCleanup();
      }
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      setTerminalReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session) {
      // Stop auto-reconnect when leaving session
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      optimisticEchoRef.current.reset();
      reconnectAttemptRef.current = 0;
    }
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [session]);

  const fetchSessions = useCallback(async () => {
    if (!isEmbeddedInHop()) return;
    setLoadingSessions(true);
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json();
      const sessionMap = new Map<string, SessionInfo>();

      // Process sessions from the API
      for (const s of data.sessions || []) {
        sessionMap.set(s.name, {
          name: s.name,
          displayName: s.displayName || s.name,
          active: (data.active || []).includes(s.name),
          starting: (data.starting || []).includes(s.name),
          type: s.type,
          port: s.port
        });
      }

      // Add active sessions that might not be in sessions list
      for (const name of data.active || []) {
        if (!sessionMap.has(name)) {
          sessionMap.set(name, {
            name,
            displayName: name,
            active: true,
            starting: false
          });
        }
      }

      setSessions(Array.from(sessionMap.values()));
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  // Fetch sessions when drawer opens
  useEffect(() => {
    if (drawerOpen) {
      fetchSessions();
    }
  }, [drawerOpen, fetchSessions]);

  // Update terminal font size when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      if (viewModeRef.current === "fit") {
        fitToViewport();
        handleResize();
      } else {
        termRef.current.refresh(0, termRef.current.rows - 1);
      }
    }
    localStorage.setItem("hay_font_size", String(fontSize));
  }, [fontSize]);

  const switchSession = (sessionName: string) => {
    // Navigate to the new session
    window.location.href = `/s/${encodeURIComponent(sessionName)}/`;
  };

  const handleJoin = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !room.trim()) {
      pushNotice("Enter a name and room to start.");
      return;
    }
    localStorage.setItem("hay_name", name.trim());
    setSession({ name: name.trim(), room: room.trim() });
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      pushNotice("Share link copied.");
    } catch {
      pushNotice("Copy failed. Select the link manually.");
    }
  };

  const handleToggleCollab = () => {
    sendMessage({ type: "toggle_collab", enabled: !collabMode });
  };

  const handleTakeControl = () => {
    sendMessage({ type: "take_control" });
  };

  const handleReleaseControl = () => {
    sendMessage({ type: "release_control" });
  };

  const handleFabDragStart = (clientX: number, clientY: number) => {
    fabDragRef.current = {
      dragging: false,
      startX: clientX,
      startY: clientY,
      startPosX: fabPosition.x,
      startPosY: fabPosition.y
    };
  };

  const handleFabDragMove = (clientX: number, clientY: number) => {
    if (!fabDragRef.current) return;
    const dx = clientX - fabDragRef.current.startX;
    const dy = clientY - fabDragRef.current.startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      fabDragRef.current.dragging = true;
    }
    if (fabDragRef.current.dragging) {
      setFabPosition({
        x: Math.max(0, Math.min(window.innerWidth - 56, fabDragRef.current.startPosX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 56, fabDragRef.current.startPosY + dy))
      });
    }
  };

  const handleFabDragEnd = () => {
    if (fabDragRef.current && !fabDragRef.current.dragging) {
      setDrawerOpen(true);
    }
    fabDragRef.current = null;
  };

  const handleKeyboardToggle = useCallback(() => {
    setKeyboardVisible((prev) => !prev);
    // Refit terminal after keyboard toggle
    setTimeout(() => {
      if (viewModeRef.current === "fit") {
        fitToViewport();
        handleResize();
      }
    }, 100);
  }, []);

  const handleKeyboardInput = useCallback(
    (data: string) => {
      handleUserInput(data);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <div>
            <p className="brand-title">Hay</p>
            <p className="brand-subtitle">Collaborative terminal sharing for Hop.</p>
          </div>
        </div>
        <div className="presence-strip">
          {sortedPresence.map((client) => (
            <div
              key={client.id}
              className={`presence-chip ${client.id === clientId ? "self" : ""}`}
              title={`${client.name} · ${formatStatus(client)}`}
            >
              <span className="presence-dot" style={{ backgroundColor: client.color }} />
              <span className="presence-name">{client.name}</span>
              <span className={`presence-status ${formatStatus(client)}`}>{formatStatus(client)}</span>
            </div>
          ))}
          {sortedPresence.length === 0 && <span className="presence-empty">No viewers yet</span>}
        </div>
      </header>

      {!session ? (
        <main className="join">
          <div className="join-card">
            <h1>Terminal session</h1>
            <p>Connect to an existing session or start a new one.</p>
            <form onSubmit={handleJoin} className="join-form">
              <label>
                Display name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Casey"
                />
              </label>
              <label>
                Session
                <input
                  value={room}
                  onChange={(event) => setRoom(event.target.value)}
                  placeholder="my-session"
                />
              </label>
              <button type="submit" className="primary">
                Connect
              </button>
            </form>
          </div>
        </main>
      ) : (
        <main className={`session${isMobile && keyboardVisible ? " has-keyboard" : ""}`}>
          <button
            type="button"
            className="drawer-toggle"
            style={{ left: fabPosition.x, top: fabPosition.y, bottom: 'auto' }}
            onMouseDown={(e) => handleFabDragStart(e.clientX, e.clientY)}
            onMouseMove={(e) => handleFabDragMove(e.clientX, e.clientY)}
            onMouseUp={handleFabDragEnd}
            onMouseLeave={handleFabDragEnd}
            onTouchStart={(e) => handleFabDragStart(e.touches[0].clientX, e.touches[0].clientY)}
            onTouchMove={(e) => handleFabDragMove(e.touches[0].clientX, e.touches[0].clientY)}
            onTouchEnd={handleFabDragEnd}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
            </svg>
          </button>
          {drawerOpen && (
            <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
          )}
          <section className={`controls ${drawerOpen ? "open" : ""}`}>
            <button
              type="button"
              className="drawer-close"
              onClick={() => setDrawerOpen(false)}
            >
              ✕
            </button>
            <div className="room-info">
              <p className="room-label">Session</p>
              <h2>{session.room}</h2>
              <p className="room-meta">
                {status === "connected" ? "Live" : status === "connecting" ? "Connecting" : "Offline"}
              </p>
            </div>
            <div className="control-actions">
              {isMobile && (
                <button type="button" onClick={() => { handleKeyboardToggle(); setDrawerOpen(false); }}>
                  {keyboardVisible ? "Hide keyboard" : "Show keyboard"}
                </button>
              )}
              <button type="button" onClick={handleCopyLink}>
                Copy link
              </button>
              <button type="button" onClick={() => { fitToViewport(); handleResize(); }}>
                Fit to screen
              </button>
              {status === "disconnected" && (
                <button type="button" onClick={() => setReconnectToken((value) => value + 1)}>
                  Reconnect
                </button>
              )}
            </div>
            <div className="font-size-control">
              <label>Font size</label>
              <div className="font-size-buttons">
                <button type="button" onClick={() => setFontSize((s) => Math.max(8, s - 1))}>−</button>
                <span>{fontSize}px</span>
                <button type="button" onClick={() => setFontSize((s) => Math.min(24, s + 1))}>+</button>
              </div>
            </div>
            <div className="view-mode-control">
              <label>View mode</label>
              <div className="view-mode-buttons">
                <button
                  type="button"
                  className={viewMode === "fit" ? "active" : ""}
                  onClick={() => setViewMode("fit")}
                >
                  Auto-fit
                </button>
                <button
                  type="button"
                  className={viewMode === "full" ? "active" : ""}
                  onClick={() => setViewMode("full")}
                >
                  Manual
                </button>
              </div>
            </div>
            {notice && <p className="notice">{notice}</p>}
            {isEmbeddedInHop() && (() => {
              const otherSessions = sessions.filter((s) => s.name !== session?.room);
              if (!loadingSessions && otherSessions.length === 0) return null;
              return (
                <div className="session-switcher">
                  <p className="session-switcher-label">Switch session</p>
                  {loadingSessions ? (
                    <div className="session-list-loading">Loading...</div>
                  ) : (
                    <div className="session-list">
                      {otherSessions.map((s) => (
                        <button
                          key={s.name}
                          type="button"
                          className={`session-list-item${s.active ? " active" : ""}${s.starting ? " starting" : ""}`}
                          onClick={() => switchSession(s.name)}
                        >
                          <span className="session-list-name">{s.displayName}</span>
                          {s.active && <span className="session-badge live">LIVE</span>}
                          {s.starting && !s.active && <span className="session-badge starting">STARTING</span>}
                          {s.type === "port" && <span className="session-badge port">PORT {s.port}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </section>
          <section className="terminal">
            <div
              className="terminal-frame"
              onClick={() => {
                // On mobile, don't focus terminal to prevent system keyboard
                if (!isMobile) {
                  termRef.current?.focus();
                }
              }}
            >
              <div className="terminal-scroll">
                <div className="terminal-inner" ref={containerRef} />
              </div>
            </div>
            <div className="terminal-footer">
              <span>{status === "connected" ? "Live" : "Awaiting connection"}</span>
              <span>
                {sortedPresence.length} viewer{sortedPresence.length === 1 ? "" : "s"}
              </span>
            </div>
          </section>
          {isMobile && (
            <MobileKeyboard
              onInput={handleKeyboardInput}
              visible={keyboardVisible}
              onToggle={handleKeyboardToggle}
            />
          )}
        </main>
      )}
    </div>
  );
};

export default App;
