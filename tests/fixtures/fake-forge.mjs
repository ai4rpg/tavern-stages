#!/usr/bin/env node
// Minimal stand-in for tavern-cards-forge in unit tests.
// Prints argv and exits 0 so pack/tool paths can run without a real forge.
process.stdout.write(`fake-forge ${process.argv.slice(2).join(' ')}\n`)
process.exit(0)
