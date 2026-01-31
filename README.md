# LogBuddy – Explain Terminal Errors

A VS Code extension that watches terminal output and helps you understand errors: natural-language explanations and an error-flow visualization.

## Features

- **Explain Last Terminal Run** – Captures the last run’s terminal output and either:
  - Sends it to an LLM (OpenAI or Google Gemini) for a plain-language explanation and fix steps, or  
  - Falls back to built-in heuristics for common errors (Python tracebacks, Node TypeError, SyntaxError, etc.).
- **Visualize Last Terminal Run** – Parses the same output into an error-flow diagram (stack frames → error) and shows it in a side panel using [Mermaid](https://mermaid.js.org/).

## Requirements

- **VS Code** (or Cursor) **^1.90.0**
- For **Explain** with an LLM: an API key for **OpenAI** or **Google Gemini** (optional; without a key, only heuristics are used)
- **Windows**: If the build task fails with a PowerShell execution policy error, the project uses a `cmd`-based compile task (see [.vscode/tasks.json](.vscode/tasks.json))

## Quick Start

1. **Clone or open** the `log-buddy` folder in VS Code / Cursor.
2. **Install dependencies** (if needed):
   ```bash
   npm install
   ```
3. **Compile**:
   ```bash
   npm run compile
   ```
4. **Run the extension** – Press **F5** to launch the Extension Development Host.
5. In the **Extension Development Host** window:
   - Open a terminal and run something that fails (e.g. a script with a bug).
   - **Explain**: `Ctrl+Shift+P` → **LogBuddy: Explain Last Terminal Run**.
   - **Visualize**: `Ctrl+Shift+P` → **LogBuddy: Visualize Last Terminal Run**.

## Configuration

In **Settings** (`Ctrl+,`), search for **LogBuddy**:

| Setting | Description |
|--------|-------------|
| **LogBuddy: Provider** | `openai`, `gemini`, or `host`. Which LLM to use for explanations. |
| **LogBuddy: Openai Api Key** | Your OpenAI API key (used when provider is `openai`). Set in Settings, not in `package.json`. |
| **LogBuddy: Openai Model** | e.g. `gpt-4o-mini`, `gpt-4o`. |
| **LogBuddy: Gemini Api Key** | Your [Google AI (Gemini) API key](https://aistudio.google.com/app/apikey) (used when provider is `gemini`). |
| **LogBuddy: Gemini Model** | e.g. `gemini-2.5-flash`, `gemini-2.5-pro`. |
| **LogBuddy: Use LLM** | When enabled and a key is set, use the LLM; otherwise use built-in heuristics only. |

- **Host** provider uses the editor’s built-in language model API (`vscode.lm`). In Cursor this may not be available; use **openai** or **gemini** with an API key instead.

## Project structure

```
log-buddy/
├── src/
│   └── extension.ts    # Main extension: terminal capture, Explain, Visualize, LLM/Gemini/host
├── examples/
│   └── viz-test/       # Multi-file example for testing the visualization
├── .vscode/
│   ├── launch.json    # Run Extension (F5)
│   └── tasks.json     # npm compile (cmd-based on Windows)
├── package.json
├── tsconfig.json
└── README.md
```

## Testing the visualization

Use the included example to get a multi-frame stack trace:

```bash
cd examples/viz-test
node index.js
```

Then run **LogBuddy: Visualize Last Terminal Run** to see the error flow (Run → index.js → … → stepThree.js → TypeError). See [examples/viz-test/README.md](examples/viz-test/README.md) for details.

## Development

- **Compile**: `npm run compile`
- **Watch**: `npm run watch`
- **Package**: `npm run package` (produces a `.vsix` for Install from VSIX)

## License

See [LICENSE](LICENSE) if present.
