#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const SERVER_NAME = 'hop';
const MCP_SERVER_PATH = path.join(__dirname, 'mcp', 'hop-mcp.js');

const CONFIG_PATHS = {
  claudeCode: path.join(HOME, '.claude.json'),
  claudeDesktop: path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  cursor: path.join(HOME, '.cursor', 'mcp.json'),
  gemini: path.join(HOME, '.gemini', 'settings.json'),
  codex: path.join(HOME, '.codex', 'config.toml'),
  vscodeWorkspace: path.join(process.cwd(), '.vscode', 'mcp.json'),
  antigravity: path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json')
};

// Prefer the resilient `hop-mcp` bin when it is on PATH (global npm install);
// fall back to absolute node+script paths for source checkouts.
const USE_HOP_MCP_BIN = commandExists('hop-mcp');

const HOP_MCP_CONFIG = USE_HOP_MCP_BIN
  ? { command: 'hop-mcp' }
  : { command: 'node', args: [MCP_SERVER_PATH] };

const HOP_MCP_VSCODE_CONFIG = {
  type: 'stdio',
  ...HOP_MCP_CONFIG
};

function commandExists(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const backupPath = `${filePath}.backup-${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
}

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function mergeServerConfig(existing, desired) {
  if (!isPlainObject(existing)) {
    return desired;
  }

  const merged = { ...existing, ...desired };
  // args belong to the desired command; drop stale args from a previous
  // node+script config when the desired form has none (bare `hop-mcp`).
  if (desired.command && !('args' in desired)) {
    delete merged.args;
  }
  if (isPlainObject(existing.env) || isPlainObject(desired.env)) {
    merged.env = {
      ...(isPlainObject(existing.env) ? existing.env : {}),
      ...(isPlainObject(desired.env) ? desired.env : {})
    };
  }
  return merged;
}

function upsertMcpServer(config, rootKey, serverName, desiredConfig) {
  if (!isPlainObject(config[rootKey])) {
    config[rootKey] = {};
  }
  const existing = config[rootKey][serverName];
  const next = mergeServerConfig(existing, desiredConfig);

  if (deepEqual(existing, next)) {
    return false;
  }

  config[rootKey][serverName] = next;
  return true;
}

function detectTools() {
  const tools = {};
  const hasAntigravityCli = commandExists('antigravity') || commandExists('agy');
  const hasVSCodeWorkspace = fs.existsSync(path.join(process.cwd(), '.vscode'));

  if (commandExists('claude')) {
    tools.claudeCode = { name: 'Claude Code', configPath: CONFIG_PATHS.claudeCode };
  }

  if (fs.existsSync(path.dirname(CONFIG_PATHS.claudeDesktop))) {
    tools.claudeDesktop = { name: 'Claude Desktop', configPath: CONFIG_PATHS.claudeDesktop };
  }

  if (commandExists('cursor') || fs.existsSync(path.join(HOME, '.cursor'))) {
    tools.cursor = { name: 'Cursor IDE', configPath: CONFIG_PATHS.cursor };
  }

  if (commandExists('gemini')) {
    tools.gemini = { name: 'Gemini CLI', configPath: CONFIG_PATHS.gemini };
  }

  if (commandExists('codex')) {
    tools.codex = { name: 'Codex CLI', configPath: CONFIG_PATHS.codex };
  }

  // The workspace entry is written into the *current directory*; only offer it
  // when cwd actually contains a .vscode workspace marker, and label it with
  // the absolute target path so the cwd-dependence is visible.
  if (hasVSCodeWorkspace) {
    tools.vscodeWorkspace = {
      name: `VS Code / GitHub Copilot / Antigravity (workspace: ${CONFIG_PATHS.vscodeWorkspace})`,
      configPath: CONFIG_PATHS.vscodeWorkspace
    };
  }

  if (
    hasAntigravityCli ||
    fs.existsSync(CONFIG_PATHS.antigravity) ||
    fs.existsSync(path.dirname(CONFIG_PATHS.antigravity))
  ) {
    tools.antigravity = {
      name: 'Antigravity (global)',
      configPath: CONFIG_PATHS.antigravity
    };
  }

  return tools;
}

function configureJsonServer(configPath, rootKey, serverConfig, options = {}) {
  const config = readJSON(configPath) || {};
  const changed = upsertMcpServer(config, rootKey, SERVER_NAME, serverConfig);

  if (options.dryRun) {
    return { changed };
  }
  if (!changed) {
    return { changed: false };
  }

  writeJSON(configPath, config);
  return { changed: true };
}

function buildCodexBlock() {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${HOP_MCP_CONFIG.command}"`
  ];
  if (Array.isArray(HOP_MCP_CONFIG.args)) {
    lines.push(`args = [${HOP_MCP_CONFIG.args.map((arg) => `"${arg}"`).join(', ')}]`);
  }
  return lines.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCodexBlockRegex(global = false) {
  const escapedName = escapeRegExp(SERVER_NAME);
  return new RegExp(`\\[mcp_servers\\.${escapedName}\\][\\s\\S]*?(?=\\n\\[|$)`, global ? 'g' : undefined);
}

function getCodexEnvBlockRegex(global = false) {
  const escapedName = escapeRegExp(SERVER_NAME);
  return new RegExp(`\\[mcp_servers\\.${escapedName}\\.env\\][\\s\\S]*?(?=\\n\\[|$)`, global ? 'g' : undefined);
}

function codexHasRequiredConfig(content) {
  const matches = content.match(getCodexBlockRegex(true)) || [];
  if (matches.length !== 1) {
    return false;
  }
  const block = matches[0];
  const hasCommand = new RegExp(`command\\s*=\\s*"${escapeRegExp(HOP_MCP_CONFIG.command)}"`).test(block);
  if (!hasCommand) {
    return false;
  }
  if (Array.isArray(HOP_MCP_CONFIG.args)) {
    const escapedPath = escapeRegExp(MCP_SERVER_PATH);
    return new RegExp(`args\\s*=\\s*\\[\\s*"${escapedPath}"\\s*\\]`).test(block);
  }
  // Bare `hop-mcp` form: a leftover args line would point at a stale script path.
  return !/^\s*args\s*=/m.test(block);
}

function prepareCodexContent(existingContent) {
  const baseMatches = existingContent.match(getCodexBlockRegex(true)) || [];
  const envMatches = existingContent.match(getCodexEnvBlockRegex(true)) || [];
  const hasDuplicates = baseMatches.length > 1 || envMatches.length > 1;

  if (codexHasRequiredConfig(existingContent) && !hasDuplicates) {
    return { changed: false, content: existingContent };
  }

  const uniqueEnvBlocks = Array.from(new Set(envMatches.map((block) => block.trim()).filter(Boolean)));
  let baseContent = existingContent
    .replace(getCodexBlockRegex(true), '')
    .replace(getCodexEnvBlockRegex(true), '')
    .trimEnd();
  if (baseContent.length > 0) {
    baseContent += '\n\n';
  }
  let nextBlock = buildCodexBlock();
  if (uniqueEnvBlocks.length > 0) {
    nextBlock += `\n\n${uniqueEnvBlocks.join('\n\n')}`;
  }
  const nextContent = `${baseContent}${nextBlock}\n`;
  return { changed: true, content: nextContent };
}

function configureCodex(configPath, options = {}) {
  const existingContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const { changed, content } = prepareCodexContent(existingContent);

  if (options.dryRun) {
    return { changed };
  }
  if (!changed) {
    return { changed: false };
  }

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, content);
  return { changed: true };
}

function configureClaudeCode(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', HOP_MCP_CONFIG, options);
}

function configureClaudeDesktop(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', HOP_MCP_CONFIG, options);
}

function configureCursor(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', HOP_MCP_CONFIG, options);
}

function configureGemini(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', HOP_MCP_CONFIG, options);
}

function configureVSCodeWorkspace(configPath, options = {}) {
  return configureJsonServer(configPath, 'servers', HOP_MCP_VSCODE_CONFIG, options);
}

function configureAntigravity(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', HOP_MCP_CONFIG, options);
}

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    yes: args.has('--yes') || args.has('-y'),
    dryRun: args.has('--dry-run'),
    help: args.has('--help') || args.has('-h')
  };
}

function printHelp() {
  console.log('Usage: hop-mcp-setup [--yes] [--dry-run]');
  console.log('');
  console.log('Automatically configures supported MCP clients for hop-mcp.');
  console.log('');
  console.log('Options:');
  console.log('  --yes, -y      Skip confirmation prompt');
  console.log('  --dry-run      Show planned changes without writing');
  console.log('  --help, -h     Show this help');
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  console.log('\nDetecting installed AI tools...\n');

  const tools = detectTools();
  const toolNames = Object.keys(tools);
  if (toolNames.length === 0) {
    console.log('No supported AI tools detected.');
    console.log('Supported tools: Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex CLI, VS Code / GitHub Copilot, Antigravity');
    process.exitCode = 1;
    return;
  }

  console.log('Found:');
  toolNames.forEach((key) => {
    console.log(`  - ${tools[key].name}`);
  });
  console.log('');
  console.log('Hop MCP server command:');
  console.log(`  ${HOP_MCP_CONFIG.command}${Array.isArray(HOP_MCP_CONFIG.args) ? ` ${HOP_MCP_CONFIG.args.join(' ')}` : ''}`);
  console.log('');
  console.log('Will configure:');
  toolNames.forEach((key) => {
    console.log(`  [x] ${tools[key].name} (${tools[key].configPath})`);
  });
  console.log('');

  if (!options.yes) {
    const confirmed = await promptUser('Continue? (y/N): ');
    if (!confirmed) {
      console.log('Setup cancelled.');
      return;
    }
  }

  const configurators = {
    claudeCode: configureClaudeCode,
    claudeDesktop: configureClaudeDesktop,
    cursor: configureCursor,
    gemini: configureGemini,
    codex: configureCodex,
    vscodeWorkspace: configureVSCodeWorkspace,
    antigravity: configureAntigravity
  };

  const plan = {};
  for (const key of toolNames) {
    try {
      plan[key] = configurators[key](tools[key].configPath, { dryRun: true });
    } catch (error) {
      plan[key] = { error };
    }
  }

  const hasPlanError = toolNames.some((key) => plan[key]?.error);
  if (hasPlanError) {
    console.log('\nConfiguration check failed:');
    for (const key of toolNames) {
      if (plan[key]?.error) {
        console.log(`  - ${tools[key].name}: ${plan[key].error.message}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    console.log('\nDry run results:');
    for (const key of toolNames) {
      if (plan[key]?.changed) {
        console.log(`  - ${tools[key].name}: would update ${tools[key].configPath}`);
      } else {
        console.log(`  - ${tools[key].name}: already configured`);
      }
    }
    return;
  }

  const backups = {};
  console.log('\nBacking up configs...');
  for (const key of toolNames) {
    if (!plan[key]?.changed) {
      continue;
    }
    const backup = backupFile(tools[key].configPath);
    if (backup) {
      backups[key] = backup;
      console.log(`  - ${tools[key].name}: backed up ${path.basename(tools[key].configPath)} -> ${path.basename(backup)}`);
    }
  }

  console.log('\nApplying configuration...');
  for (const key of toolNames) {
    if (!plan[key]?.changed) {
      console.log(`  - ${tools[key].name}: already configured`);
      continue;
    }
    try {
      configurators[key](tools[key].configPath);
      console.log(`  - ${tools[key].name}: configured`);
    } catch (error) {
      console.log(`  - ${tools[key].name}: failed (${error.message})`);
      if (backups[key]) {
        fs.copyFileSync(backups[key], tools[key].configPath);
        console.log(`    restored from backup: ${backups[key]}`);
      }
    }
  }

  console.log('\nSetup complete. Restart your AI tools to load hop MCP.');
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
