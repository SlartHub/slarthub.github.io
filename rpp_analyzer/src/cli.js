#!/usr/bin/env node
/**
 * Reaper RPP Analyzer — Node.js CLI
 *
 * Usage:
 *   node src/cli.js path/to/project.rpp -o report.html
 *   node src/cli.js path/to/folder/ -o report.html --recursive
 *   node src/cli.js path/to/folder/ --recursive --json --no-open
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname, basename } from 'path';
import { exec } from 'child_process';
import { parseRppFile } from './rppParser.js';
import { extractProjectData } from './dataExtractor.js';
import { computeProjectStats, computeBatchStats } from './statsEngine.js';
import { generateHtml } from './htmlReport.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args  = argv.slice(2);
  const opts  = { input: null, output: 'reaper_report.html',
                  recursive: false, json: false, noOpen: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output')   { opts.output    = args[++i]; }
    else if (a === '--recursive')          { opts.recursive = true; }
    else if (a === '--json')               { opts.json      = true; }
    else if (a === '--no-open')            { opts.noOpen    = true; }
    else if (!a.startsWith('-'))           { opts.input     = a; }
  }
  return opts;
}

function findRppFiles(dir, recursive) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st   = statSync(full);
    if (st.isDirectory() && recursive)    results.push(...findRppFiles(full, true));
    else if (extname(entry).toLowerCase() === '.rpp') results.push(full);
  }
  return results;
}

function openBrowser(filePath) {
  const abs = resolve(filePath);
  const url = `file://${abs.replace(/\\/g, '/')}`;
  const cmd = process.platform === 'win32' ? `start "" "${abs}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, err => { if (err) console.warn('Could not auto-open browser:', err.message); });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.input) {
    console.error('Usage: node src/cli.js <file.rpp|folder/> [-o report.html] [--recursive] [--json] [--no-open]');
    process.exit(1);
  }

  const inputPath = resolve(opts.input);
  const stat = statSync(inputPath);
  const files = stat.isDirectory()
    ? findRppFiles(inputPath, opts.recursive)
    : [inputPath];

  if (!files.length) {
    console.error('No .rpp files found.');
    process.exit(1);
  }

  console.log(`Found ${files.length} .rpp file(s). Parsing…`);

  const allStats = [];
  for (const file of files) {
    try {
      const root  = parseRppFile(file);
      const name  = basename(file, '.rpp');
      const data  = extractProjectData(root, name);
      const stats = computeProjectStats(data);
      allStats.push(stats);
      console.log(`  ✓ ${name} (${stats.totalTracks} tracks, ${stats.totalPluginInstances} plugins, ${stats.totalItems} items)`);
    } catch (err) {
      console.warn(`  ✗ ${basename(file)}: ${err.message}`);
    }
  }

  if (!allStats.length) {
    console.error('All files failed to parse.');
    process.exit(1);
  }

  const batch = allStats.length > 1 ? computeBatchStats(allStats) : null;

  console.log('\nGenerating HTML report…');
  const html = generateHtml(allStats, batch);
  writeFileSync(opts.output, html, 'utf8');
  console.log(`Report saved → ${resolve(opts.output)}`);

  if (opts.json) {
    const jsonPath = opts.output.replace(/\.html$/i, '.json');
    writeFileSync(jsonPath, JSON.stringify(allStats, null, 2), 'utf8');
    console.log(`JSON saved  → ${resolve(jsonPath)}`);
  }

  if (!opts.noOpen) openBrowser(opts.output);
}

main().catch(err => { console.error(err); process.exit(1); });
