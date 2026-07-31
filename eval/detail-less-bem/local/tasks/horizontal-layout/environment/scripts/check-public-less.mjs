#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

const forbidden = new Set(['gap', 'row-gap', 'column-gap', 'float', 'filter', 'backdrop-filter', 'background', 'background-image', 'box-shadow', 'outline', 'text-overflow', 'white-space', 'word-break', 'transition', 'animation']);
const bem = /^\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__(?:[a-z0-9]+(?:-[a-z0-9]+)*))?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

function issue(file, line, rule, message) {
  return `${file}:${line} [${rule}] ${message}`;
}

function validate(file) {
  const errors = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const number = index + 1;
    const selector = line.match(/^(.+?)\s*\{$/);
    if (selector) {
      if (depth > 0) errors.push(issue(file, number, 'top-level-single-selector', '公共 Less 不允许嵌套规则'));
      if (!bem.test(selector[1].trim())) errors.push(issue(file, number, 'bem-selector', '选择器必须是单个 BEM 类'));
      depth += 1;
      continue;
    }
    if (line === '}') {
      depth -= 1;
      if (depth < 0) errors.push(issue(file, number, 'syntax', '存在未匹配的 }'));
      continue;
    }
    const declaration = line.match(/^([a-z-]+)\s*:\s*([^;]+);?$/i);
    if (!declaration) continue;
    const property = declaration[1].toLowerCase();
    const value = declaration[2].trim();
    if (forbidden.has(property)) errors.push(issue(file, number, 'forbidden-property', `${property} 不允许用于公共 Less`));
    if (property === 'line-height' && !/^-?\d+(?:\.\d+)?px$/i.test(value)) errors.push(issue(file, number, 'line-height-px', 'line-height 必须为 px 数值'));
    if (/\b(?:calc|var)\s*\(/.test(value) || /\b\d+(?:\.\d+)?(?:vh|vw|em|rem|rpx)\b/.test(value)) errors.push(issue(file, number, 'forbidden-unit', '公共 Less 不允许该单位或函数'));
  }
  if (depth !== 0) errors.push(issue(file, lines.length, 'syntax', '规则括号不匹配'));
  return errors;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('[file] 必须提供 Less 文件');
  process.exit(1);
}
const errors = files.flatMap(validate);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`PASS ${files.length} 个 Less 文件`);
