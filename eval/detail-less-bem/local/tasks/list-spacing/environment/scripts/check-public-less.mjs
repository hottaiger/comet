#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const BEM = /^\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__(?:[a-z0-9]+(?:-[a-z0-9]+)*))?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const FORBIDDEN = new Set(['gap', 'row-gap', 'column-gap', 'float', 'filter', 'backdrop-filter', 'background-image', 'background', 'outline', 'visibility', 'transition', 'animation', 'text-overflow', 'white-space', 'word-break']);

export function validateLess(source, file = '<input>') {
  const issues = [];
  const stack = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    const selector = trimmed.match(/^(.+?)\s*\{$/);
    if (selector) {
      const value = selector[1].trim();
      if (stack.length || !BEM.test(value)) issues.push(`${file}:${lineNumber} [top-level-single-selector] invalid selector: ${value}`);
      stack.push({ lineNumber, declarations: [] });
      return;
    }
    const declaration = trimmed.match(/^([a-z-]+)\s*:\s*([^;]+);?$/i);
    if (declaration && stack.length) {
      const property = declaration[1].toLowerCase();
      const value = declaration[2].trim();
      stack.at(-1).declarations.push(property);
      if (FORBIDDEN.has(property)) issues.push(`${file}:${lineNumber} [forbidden-property] ${property} is forbidden`);
      if (property === 'line-height' && !/^-?\d+(?:\.\d+)?px$/i.test(value)) issues.push(`${file}:${lineNumber} [line-height-px] line-height must use px`);
      return;
    }
    if (trimmed === '}') {
      const rule = stack.pop();
      if (!rule) issues.push(`${file}:${lineNumber} [syntax] unmatched closing brace`);
      else if (!rule.declarations.length) issues.push(`${file}:${rule.lineNumber} [empty-rule] empty rule`);
    }
  });
  for (const rule of stack) issues.push(`${file}:${rule.lineNumber} [syntax] missing closing brace`);
  return issues;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('[file] provide at least one Less file');
  process.exitCode = 1;
} else {
  const issues = files.flatMap((file) => existsSync(file) ? validateLess(readFileSync(file, 'utf8'), file) : [`${file}:0 [file] file not found`]);
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else console.log(`PASS ${files.length} Less file(s)`);
}

