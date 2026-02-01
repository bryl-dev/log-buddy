import * as vscode from 'vscode';
import * as https from 'https';

type TerminalBuffer = {
  terminal: vscode.Terminal;
  buffer: string;
};

const terminalBuffers = new Map<vscode.Terminal, TerminalBuffer>();
let explanationChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Capture terminal output (cast to any because this API is newer than our types)
  const dataDisposable = (vscode.window as any).onDidWriteTerminalData((event: any) => {
    let entry = terminalBuffers.get(event.terminal);
    if (!entry) {
      entry = { terminal: event.terminal, buffer: '' };
      terminalBuffers.set(event.terminal, entry);
    }
    entry.buffer += event.data;
  });

  // Command to visualize the last run (error flow diagram)
  const visualizeCommand = vscode.commands.registerCommand(
    'logBuddy.visualizeLastRun',
    async () => {
      const active = vscode.window.activeTerminal;
      if (!active) {
        vscode.window.showWarningMessage('LogBuddy: No active terminal to analyze.');
        return;
      }
      const entry = terminalBuffers.get(active);
      if (!entry || !entry.buffer.trim()) {
        vscode.window.showInformationMessage('LogBuddy: No terminal output captured yet.');
        return;
      }
      const log = extractRelevantChunk(entry.buffer);
      const flow = parseErrorFlow(log);
      const mermaidCode = buildMermaidFlowchart(flow);
      const panel = vscode.window.createWebviewPanel(
        'logBuddyVisualize',
        'LogBuddy: Error visualization',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = getVisualizationHtml(panel.webview, mermaidCode, flow.errorType, flow.errorMessage);
    }
  );

  // Command to explain the last run
  const explainCommand = vscode.commands.registerCommand(
    'logBuddy.explainLastRun',
    async () => {
      const active = vscode.window.activeTerminal;
      if (!active) {
        vscode.window.showWarningMessage('LogBuddy: No active terminal to analyze.');
        return;
      }

      const entry = terminalBuffers.get(active);
      if (!entry || !entry.buffer.trim()) {
        vscode.window.showInformationMessage('LogBuddy: No terminal output captured yet.');
        return;
      }

      const log = entry.buffer;
      const relevant = extractRelevantChunk(log);
      const channel = getExplanationChannel();
      channel.clear();
      channel.appendLine('=== LogBuddy Explanation ===');
      channel.appendLine('');
      channel.show(true);
      const explanation = await explainLog(relevant, channel);

      channel.appendLine(explanation);

      // Show formatted explanation in a Webview (Markdown → bold, lists, etc.)
      const explainPanel = vscode.window.createWebviewPanel(
        'logBuddyExplain',
        'LogBuddy: Explanation',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      explainPanel.webview.html = getExplanationWebviewHtml(explainPanel.webview, explanation);

      // Short summary back into the terminal
      active.sendText(`# LogBuddy summary: ${summarize(explanation)}`);
    }
  );

  context.subscriptions.push(dataDisposable, explainCommand, visualizeCommand);
}

export function deactivate() {
  terminalBuffers.clear();
}

function extractRelevantChunk(log: string): string {
  const lines = log.split(/\r?\n/);
  return lines.slice(-400).join('\n'); // more lines for context
}

/** Parsed error flow: ordered stack frames + final error for visualization */
type ErrorFlow = {
  errorType?: string;
  errorMessage?: string;
  frames: { label: string; file?: string; line?: number; column?: number }[];
};

/** Parse log into ordered stack frames and error type/message (for diagram) */
function parseErrorFlow(log: string): ErrorFlow {
  const lines = log.split(/\r?\n/);
  const frames: { label: string; file?: string; line?: number; column?: number }[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const raw = line.replace(/\x1b\[[\d;]*m/g, '').replace(/\r$/, '').trim();
    if (!raw) continue;
    // Node: "at ... (path:line:col)" or "at ... (path:line)" — extract content in parens then parse path:line[:col]
    const atParen = raw.match(/at\s+.*?\(([^)]+)\)/);
    let inner: string | null = atParen ? atParen[1].trim() : null;
    if (!inner && /\([^)]*\.(?:js|ts|tsx|jsx|mjs|cjs|py|rs|go):\d+(?::\d+)?\)/.test(raw)) {
      const anyParen = raw.match(/\(([^)]+)\)/g);
      if (anyParen) {
        for (const p of anyParen) {
          const content = p.slice(1, -1);
          if (content.includes('node:') || content.includes('node_modules')) continue;
          if (/\.(?:js|ts|tsx|jsx|mjs|cjs|py|rs|go):\d+/.test(content)) {
            inner = content;
            break;
          }
        }
      }
    }
    if (inner && !inner.includes('node:') && !inner.includes('node_modules')) {
      const parts = inner.split(':');
      let path: string;
      let lineNum: number;
      let column: number | undefined;
      if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(parts[parts.length - 2])) {
        path = parts.slice(0, -2).join(':').trim();
        lineNum = parseInt(parts[parts.length - 2], 10);
        column = parseInt(parts[parts.length - 1], 10);
      } else if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
        path = parts.slice(0, -1).join(':').trim();
        lineNum = parseInt(parts[parts.length - 1], 10);
      } else {
        path = '';
        lineNum = 0;
      }
      if (path && lineNum > 0) {
        const key = `${path}:${lineNum}`;
        if (!seen.has(key)) {
          seen.add(key);
          const base = (path.split(/[/\\]/).pop() || path).replace(/\.[^.]+$/, '') || path;
          frames.push({ label: `${base} line ${lineNum}`, file: path, line: lineNum, column });
        }
      }
      continue;
    }
    // Python: File "path", line N
    const pyMatch = raw.match(/File "([^"]+)", line (\d+)/);
    if (pyMatch) {
      const path = pyMatch[1].trim();
      const lineNum = parseInt(pyMatch[2], 10);
      const key = `${path}:${lineNum}`;
      if (!seen.has(key)) {
        seen.add(key);
        const base = (path.split(/[/\\]/).pop() || path).replace(/\.[^.]+$/, '') || path;
        frames.push({ label: `${base} line ${lineNum}`, file: path, line: lineNum });
      }
    }
  }

  // Stack traces list innermost call first (where error happened); we want Run → entry → ... → failure → Error
  frames.reverse();

  // Find last line that looks like "ErrorType: message" (Node, Python, etc.)
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const errMatch = trimmed.match(/^(\w+Error(?:\w+)?):\s*(.+)$/) || trimmed.match(/^(\w+Error):\s*(.+)$/) || trimmed.match(/^(\w+):\s*(.+)$/);
    if (errMatch && !trimmed.startsWith('at ') && !trimmed.startsWith('File ')) {
      errorType = errMatch[1];
      errorMessage = errMatch[2].slice(0, 80);
      break;
    }
  }

  return { errorType, errorMessage, frames };
}

/** Build Mermaid flowchart: Start -> frame1 -> ... -> Error (top to bottom). All frames show "fileName line N"; failure frame (last) also shows ", col M" when available. */
function buildMermaidFlowchart(flow: ErrorFlow): string {
  const lines: string[] = ['flowchart TB', '  Start([Run])'];
  let prev = 'Start';
  const nodeId = (i: number) => `F${i}`;
  const frameList = flow.frames.slice(0, 8);
  const lastIdx = frameList.length - 1;
  frameList.forEach((f, i) => {
    const id = nodeId(i);
    const isFailureFrame = i === lastIdx;
    let label: string = f.label;
    if (isFailureFrame && f.column != null) {
      label = `${f.label}, col ${f.column}`;
    }
    const safe = label.replace(/"/g, "'").replace(/[\[\]()]/g, ' ');
    lines.push(`  ${id}["${safe}"]`);
    lines.push(`  ${prev} --> ${id}`);
    prev = id;
  });
  const errLabel = flow.errorType
    ? `${flow.errorType}${flow.errorMessage ? ': ' + flow.errorMessage.replace(/"/g, "'") : ''}`
    : 'Error';
  const safeErr = errLabel.slice(0, 50).replace(/"/g, "'");
  lines.push(`  Error["${safeErr}"]`);
  lines.push(`  ${prev} --> Error`);
  return lines.join('\n');
}

/** HTML for Webview: Mermaid.js from CDN + diagram */
function getVisualizationHtml(webview: vscode.Webview, mermaidCode: string, errorType?: string, errorMessage?: string): string {
  const csp = webview.cspSource;
  const escaped = mermaidCode
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${csp} https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${csp} https://cdn.jsdelivr.net 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
    body { font-family: var(--vscode-font-family); padding: 1rem; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    #diagram { min-height: 200px; }
    .error-box { margin-top: 1rem; padding: 0.75rem; border-radius: 6px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    .mermaid { display: flex; justify-content: center; }
  </style>
</head>
<body>
  <h2>Error flow</h2>
  <p style="color: var(--vscode-descriptionForeground);">Stack frames (top to bottom) leading to the error.</p>
  <div id="diagram" class="mermaid">${escaped}</div>
  ${errorType || errorMessage ? `<div class="error-box"><strong>${errorType || 'Error'}</strong>${errorMessage ? ': ' + escapeHtml(errorMessage) : ''}</div>` : ''}
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** HTML for Webview: render explanation as Markdown (bold, lists, etc.) */
function getExplanationWebviewHtml(webview: vscode.Webview, markdownContent: string): string {
  const csp = webview.cspSource;
  const escaped = markdownContent
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${csp} https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${csp} https://cdn.jsdelivr.net 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    body { font-family: var(--vscode-font-family); padding: 1rem; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); line-height: 1.5; }
    #content { max-width: 60em; }
    #content strong { font-weight: 600; }
    #content ul, #content ol { margin: 0.5em 0; padding-left: 1.5em; }
    #content li { margin: 0.25em 0; }
    #content p { margin: 0.75em 0; }
    #content code { background: var(--vscode-textBlockQuote-background); padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <h2>Explanation</h2>
  <div id="content"></div>
  <script>
    (function() {
      const md = \`${escaped}\`;
      document.getElementById('content').innerHTML = marked.parse(md);
    })();
  </script>
</body>
</html>`;
}

/** Detect language/tool from log content for better LLM context */
function detectLogContext(log: string): { language?: string; tool?: string } {
  const ctx: { language?: string; tool?: string } = {};
  if (/\bNode\.js\b|node:internal|at Module\._compile|at Object\.<anonymous>/.test(log)) ctx.language = 'Node.js/JavaScript';
  else if (/Traceback \(most recent call last\)|File ".*\.py"|SyntaxError:.*\n.*\.py/.test(log)) ctx.language = 'Python';
  else if (/error TS\d+|\.ts\(\d+,\d+\)|TypeScript/.test(log)) ctx.language = 'TypeScript';
  else if (/rustc|error\[E\d+\]|\.rs:\d+/.test(log)) ctx.language = 'Rust';
  else if (/go build|\.go:\d+/.test(log)) ctx.language = 'Go';
  if (/npm (ERR!|WARN)|npx |node_modules/.test(log)) ctx.tool = 'npm';
  else if (/pip |venv|requirements\.txt/.test(log)) ctx.tool = 'pip';
  return ctx;
}

/** Extract file path and line number from common stack trace formats */
function extractFileReferences(log: string): { path: string; line: number }[] {
  const refs: { path: string; line: number }[] = [];
  const seen = new Set<string>();

  // Node: "at ... (C:\path\to\file.js:10:5)" or "at ... (file.js:10:5)"
  const nodeRe = /\(([^)]+):(\d+):?\d*\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(log)) !== null) {
    const path = m[1].trim();
    const line = parseInt(m[2], 10);
    if (line > 0 && !path.includes('node:') && !path.includes('node_modules')) {
      const key = `${path}:${line}`;
      if (!seen.has(key)) { seen.add(key); refs.push({ path, line }); }
    }
  }

  // Python: File "path", line N
  const pyRe = /File "([^"]+)", line (\d+)/g;
  while ((m = pyRe.exec(log)) !== null) {
    const path = m[1].trim();
    const line = parseInt(m[2], 10);
    const key = `${path}:${line}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ path, line }); }
  }

  // Generic "path:line" (e.g. C:\Users\...\file.js:1)
  const genericRe = /([A-Za-z]:[\\/][^\s]+\.(?:js|ts|tsx|jsx|py|rs|go)):(\d+)/g;
  while ((m = genericRe.exec(log)) !== null) {
    const path = m[1].trim();
    const line = parseInt(m[2], 10);
    const key = `${path}:${line}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ path, line }); }
  }

  return refs.slice(0, 5); // limit to 5 files to avoid huge prompts
}

const SNIPPET_PADDING = 5;

/** Read a few lines around each referenced line from workspace files */
async function readFileSnippets(refs: { path: string; line: number }[]): Promise<string> {
  const snippets: string[] = [];
  for (const { path, line } of refs) {
    let uri: vscode.Uri | undefined;
    if (path.startsWith('file:')) {
      try { uri = vscode.Uri.parse(path); } catch { uri = undefined; }
    } else {
      const normalized = path.replace(/\\/g, '/');
      const isAbsolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/');
      // Prefer absolute path first (common in stack traces)
      const abs = vscode.Uri.file(path);
      try {
        await vscode.workspace.fs.stat(abs);
        uri = abs;
      } catch {
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceUri && !isAbsolute) {
          const rel = vscode.Uri.joinPath(workspaceUri, normalized);
          try {
            await vscode.workspace.fs.stat(rel);
            uri = rel;
          } catch {
            uri = undefined;
          }
        } else {
          uri = undefined;
        }
      }
    }
    if (!uri) continue;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const start = Math.max(0, line - 1 - SNIPPET_PADDING);
      const end = Math.min(doc.lineCount, line - 1 + SNIPPET_PADDING + 1);
      const slice = doc.getText(new vscode.Range(start, 0, end, 0));
      const label = doc.uri.fsPath.split(/[/\\]/).pop() || path;
      snippets.push(`${label} (around line ${line}):\n${slice}`);
    } catch {
      // file not in workspace or not readable
    }
  }
  return snippets.length ? snippets.join('\n\n') : '';
}

const LLM_PROMPT_TEMPLATE = `You are a helpful assistant that explains terminal/console output to developers.

{{CONTEXT}}

{{CODE}}

Use the terminal output and any relevant code above. In plain, friendly language:
1. Say what went wrong (or what the output means).
2. Give 3-5 concrete steps to fix it, referring to file/line when helpful.
Be concise. Do not repeat the raw log.

--- Terminal output ---
{{LOG}}
--- End ---`;

function buildPrompt(log: string, contextHint: string, codeSnippets: string): string {
  const logSlice = log.slice(-12000);
  return LLM_PROMPT_TEMPLATE
    .replace('{{CONTEXT}}', contextHint)
    .replace('{{CODE}}', codeSnippets ? `Relevant code (from stack trace):\n${codeSnippets}` : '(No code snippets extracted.)')
    .replace('{{LOG}}', logSlice);
}

async function explainLogWithOpenAI(
  prompt: string,
  apiKey: string,
  model: string,
  channel: vscode.OutputChannel
): Promise<string | null> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    max_tokens: 1024,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            channel.appendLine(`OpenAI API error (${res.statusCode}): ${data.slice(0, 200)}`);
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(data);
            const content = json?.choices?.[0]?.message?.content?.trim();
            resolve(content || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', (err) => {
      channel.appendLine(`LogBuddy LLM request failed: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/** Google Gemini (Google AI Studio) */
async function explainLogWithGemini(
  prompt: string,
  apiKey: string,
  model: string,
  channel: vscode.OutputChannel
): Promise<string | null> {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1024 },
  });
  const path = `/v1beta/models/${model}:generateContent`;
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            channel.appendLine(`Gemini API error (${res.statusCode}): ${data.slice(0, 200)}`);
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(data);
            const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', (err) => {
      channel.appendLine(`LogBuddy Gemini request failed: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/** Editor host model (Cursor / VS Code built-in LM) */
async function explainLogWithHost(prompt: string, channel: vscode.OutputChannel): Promise<string | null> {
  const lm = (vscode as any).lm;
  if (!lm?.selectChatModels) {
    channel.appendLine('Host language model API (vscode.lm) is not available in this editor.');
    return null;
  }
  const UserMessage = (vscode as any).LanguageModelChatMessage?.User;
  if (!UserMessage) {
    channel.appendLine('Host LanguageModelChatMessage API not available. Use provider "gemini" or "openai" instead.');
    return null;
  }
  try {
    const models = await lm.selectChatModels({});
    if (!models?.length) {
      channel.appendLine('No host language model available. Install Copilot or use provider "openai" / "gemini" with an API key.');
      return null;
    }
    const model = models[0];
    const messages = [UserMessage(prompt)];
    const token = new vscode.CancellationTokenSource().token;
    const response = await model.sendRequest(messages, {}, token);
    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
    }
    return text.trim() || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channel.appendLine(`Host model request failed: ${msg}`);
    return null;
  }
}

async function explainLog(log: string, channel: vscode.OutputChannel): Promise<string> {
  const config = vscode.workspace.getConfiguration('logBuddy');
  const provider = (config.get<string>('provider') ?? 'openai').toLowerCase();
  const useLLM = config.get<boolean>('useLLM') ?? true;

  if (!useLLM) {
    // skip to heuristics below
  } else {
    const ctx = detectLogContext(log);
    const contextHint = [
      'Context:',
      ctx.language ? `- Appears to be: ${ctx.language}` : '',
      ctx.tool ? `- Tool: ${ctx.tool}` : '',
      !ctx.language && !ctx.tool ? '- Could not detect language/tool from log.' : ''
    ].filter(Boolean).join('\n') || 'Context: (none detected from log.)';
    const refs = extractFileReferences(log);
    const codeSnippets = refs.length ? await readFileSnippets(refs) : '';
    const prompt = buildPrompt(log, contextHint, codeSnippets);

    let llmResult: string | null = null;
    if (provider === 'host') {
      channel.appendLine('Using editor host model (e.g. Cursor)...');
      llmResult = await explainLogWithHost(prompt, channel);
    } else if (provider === 'gemini') {
      const apiKey = (config.get<string>('gemini.apiKey') ?? '').trim();
      const model = config.get<string>('gemini.model') ?? 'gemini-2.5-flash';
      if (apiKey) {
        channel.appendLine('Calling Gemini to explain terminal output...');
        llmResult = await explainLogWithGemini(prompt, apiKey, model, channel);
      } else {
        channel.appendLine('LogBuddy provider is "gemini" but no Gemini API key is set. Set logBuddy.gemini.apiKey in Settings.');
      }
    } else {
      const apiKey = (config.get<string>('openai.apiKey') ?? '').trim();
      const model = config.get<string>('openai.model') ?? 'gpt-4o-mini';
      if (apiKey) {
        channel.appendLine('Calling OpenAI to explain terminal output...');
        llmResult = await explainLogWithOpenAI(prompt, apiKey, model, channel);
      } else {
        channel.appendLine('LogBuddy provider is "openai" but no OpenAI API key is set. Set logBuddy.openai.apiKey in Settings.');
      }
    }
    if (llmResult) return llmResult;
    channel.appendLine('Falling back to built-in heuristics.');
    channel.appendLine('');
  }

  // Very simple heuristics for now; later we’ll plug in an LLM

  if (/SyntaxError:\s+Invalid or unexpected token/.test(log)) {
    return [
      'This is a Node.js SyntaxError: “Invalid or unexpected token”.',
      '',
      'What it means:',
      '- Node tried to parse your JavaScript file and hit a character or byte sequence it doesn’t understand as valid JS.',
      '- This often happens if the file was saved with the wrong encoding, copied from somewhere that added weird characters, or contains stray symbols.',
      '',
      'How to fix:',
      '1. Open the file and go to the line shown in the error (e.g., C:\\Users\\...\\test_error.js:1).',
      '2. Delete that line and re‑type it manually in your editor (do not copy‑paste).',
      '3. Make sure the file only contains plain ASCII/UTF‑8 characters like console.log(a.b) and save it.',
      '4. Run node test_error.js again to confirm the SyntaxError is gone.'
    ].join('\n');
  }

  if (/Traceback \(most recent call last\)/.test(log)) {
    return [
      'I see a Python traceback.',
      '',
      '- The bottom-most line shows the exception type and message.',
      '- The lines above form the call stack that led to the error.',
      '',
      'How to fix:',
      '1. Look at the last line for the exception type (e.g., KeyError, TypeError, ValueError).',
      '2. Open the file and line mentioned there and inspect the variables used.',
      '3. Add checks or adjust the logic so you don’t pass invalid values that trigger that exception.'
    ].join('\n');
  }

  if (/TypeError: Cannot read (properties|property) of undefined/.test(log)) {
    return [
      'This looks like a JavaScript/TypeScript TypeError: you are reading a property on `undefined`.',
      '',
      'How to fix:',
      '1. Check the line mentioned in the stack trace and find which variable is `undefined`.',
      '2. Make sure that variable is initialized before use, or add a guard (e.g., `if (!obj) return;`).',
      '3. Trace back where that variable comes from and ensure callers pass a valid value.'
    ].join('\n');
  }

  if (/error:/.test(log) && /compilation terminated/.test(log)) {
    return [
      'This looks like a compilation error (possibly C/C++ or a compiled language).',
      '',
      'How to fix:',
      '1. Read the first error message: it usually points to the real problem.',
      '2. Fix issues in the order they appear (later errors can be side effects).',
      '3. Rebuild after each set of fixes to confirm the error count is going down.'
    ].join('\n');
  }

  // Fallback
  return [
    'I captured your recent terminal output, but there is no specific rule for this pattern yet.',
    'In a later version, this would be sent to a language model for a detailed explanation and suggested fixes.'
  ].join('\n');
}

function getExplanationChannel(): vscode.OutputChannel {
  if (!explanationChannel) {
    explanationChannel = vscode.window.createOutputChannel('LogBuddy');
  }
  return explanationChannel;
}

function summarize(explanation: string): string {
  const firstLine = explanation.split(/\r?\n/).find(line => line.trim().length > 0) ?? '';
  return (firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine) || 'Explanation available in LogBuddy output';
}