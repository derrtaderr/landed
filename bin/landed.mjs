#!/usr/bin/env node
import { main } from '../src/cli.mjs';

process.exitCode = await main({ argv: process.argv.slice(2) });
