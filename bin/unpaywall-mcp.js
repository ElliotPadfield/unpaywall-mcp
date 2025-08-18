#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const entry = path.join(__dirname, '..', 'dist', 'index.js');

// Defer to the compiled entrypoint. It runs main() on import.
await import(entry);
