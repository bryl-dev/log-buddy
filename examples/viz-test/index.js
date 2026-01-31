// Run from Extension Development Host: node index.js
// (from examples/viz-test or log-buddy root with node examples/viz-test/index.js)
const { doWork } = require('./lib/worker');

function main() {
  console.log('Starting...');
  doWork();
  console.log('Done');
}

main();
