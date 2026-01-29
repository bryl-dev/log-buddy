import * as vscode from 'vscode';

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
      const explanation = await explainLog(relevant);

      const channel = getExplanationChannel();
      channel.clear();
      channel.appendLine('=== LogBuddy Explanation ===');
      channel.appendLine('');
      channel.appendLine(explanation);
      channel.show(true);

      // Short summary back into the terminal
      active.sendText(`# LogBuddy summary: ${summarize(explanation)}`);
    }
  );

  context.subscriptions.push(dataDisposable, explainCommand);
}

export function deactivate() {
  terminalBuffers.clear();
}

function extractRelevantChunk(log: string): string {
  // v1: take last 200 lines
  const lines = log.split(/\r?\n/);
  return lines.slice(-200).join('\n');
}

async function explainLog(log: string): Promise<string> {
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