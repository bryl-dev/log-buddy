# LogBuddy visualization test

Run this from the **Extension Development Host** terminal to get a multi-frame stack trace, then use **LogBuddy: Visualize Last Terminal Run**.

From the `viz-test` folder:

```bash
node index.js
```

Or from the `log-buddy` project root:

```bash
node examples/viz-test/index.js
```

You should see a `TypeError: Cannot read properties of undefined (reading 'value')` with a stack like:

- index.js (main)
- worker.js (doWork)
- stepOne.js (stepOne)
- stepTwo.js (stepTwo)
- stepThree.js (stepThree) ← error

Then run **LogBuddy: Visualize Last Terminal Run** to see the error flow diagram.
