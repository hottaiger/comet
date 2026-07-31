#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLATFORMS = new Set(['rn', 'h5', 'weapp']);
const FORBIDDEN_PROPERTIES = new Set([
  'gap',
  'row-gap',
  'column-gap',
  'float',
  'filter',
  'backdrop-filter',
  'background-image',
  'background',
  'outline',
  'visibility',
  'transition',
  'animation',
  'text-overflow',
  'white-space',
  'word-break',
]);
const BEM_SELECTOR = /^\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__(?:[a-z0-9]+(?:-[a-z0-9]+)*))?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

function parseCondition(line, lineNumber) {
  const match = line.match(/^\s*\/\*\s*#(ifdef|ifndef)\s+([^*]+?)\s*\*\/\s*$/);
  if (!match) return null;

  const platforms = match[2].trim().split(/\s+/);
  const invalidPlatform = platforms.find((platform) => !PLATFORMS.has(platform));
  if (invalidPlatform) {
    return {
      issue: {
        file: '',
        line: lineNumber,
        rule: 'platform-condition',
        message: `条件编译平台必须使用小写 rn、h5、weapp，当前为 ${invalidPlatform}`,
      },
    };
  }
  return { type: match[1], platforms };
}

function getIncludedPlatforms(conditionStack) {
  let included = new Set(PLATFORMS);
  for (const condition of conditionStack) {
    if (condition.type === 'ifdef') {
      included = new Set([...included].filter((platform) => condition.platforms.includes(platform)));
    } else {
      included = new Set([...included].filter((platform) => !condition.platforms.includes(platform)));
    }
  }
  return included;
}

function createIssue(file, line, rule, message) {
  return { file, line, rule, message };
}

function isForbiddenDeclaration(property, value) {
  if (FORBIDDEN_PROPERTIES.has(property)) return true;
  if (property === 'position' && /\b(?:fixed|sticky)\b/.test(value)) return true;
  if (property === 'border-style' && /\bnone\b/.test(value)) return true;
  if (property === 'transform' && /translateZ\s*\(/i.test(value)) return true;
  if (property === 'line-height' && !/^-?\d+(?:\.\d+)?px$/i.test(value)) return true;
  if (/\b(?:calc|var)\s*\(/.test(value)) return true;
  if (/\b\d+(?:\.\d+)?(?:vh|vw|em|rem|rpx)\b/.test(value)) return true;
  return false;
}

export function validateLess(source, file = '<input>') {
  const issues = [];
  const conditionStack = [];
  const ruleStack = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();

    const condition = parseCondition(line, lineNumber);
    if (condition) {
      if (condition.issue) {
        issues.push({ ...condition.issue, file });
      } else {
        conditionStack.push(condition);
      }
      continue;
    }
    if (/^\s*\/\*\s*#endif\s*\*\/\s*$/.test(line)) {
      if (!conditionStack.pop()) {
        issues.push(createIssue(file, lineNumber, 'platform-condition', '#endif 没有匹配的条件编译开始标记'));
      }
      continue;
    }
    if (/^\s*\/\*\s*#(?:if|else)\b/.test(line)) {
      issues.push(createIssue(file, lineNumber, 'platform-condition', 'Less 条件编译仅支持 #ifdef、#ifndef、#endif'));
      continue;
    }
    if (/^@keyframes\b/.test(trimmed)) {
      issues.push(createIssue(file, lineNumber, 'forbidden-property', '@keyframes 不可用于公共 Less'));
      continue;
    }

    const selectorMatch = trimmed.match(/^(.+?)\s*\{\s*$/);
    if (selectorMatch) {
      const selector = selectorMatch[1].trim();
      if (ruleStack.length > 0 || !BEM_SELECTOR.test(selector)) {
        issues.push(
          createIssue(
            file,
            lineNumber,
            ruleStack.length > 0 ? 'top-level-single-selector' : 'bem-selector',
            `只允许顶层单个 BEM 类选择器，当前为 ${selector}`,
          ),
        );
      }
      ruleStack.push({ line: lineNumber, selector, declarations: [], includesRn: getIncludedPlatforms(conditionStack).has('rn') });
      continue;
    }

    const declaration = trimmed.match(/^([a-z-]+)\s*:\s*([^;]+);?\s*$/i);
    if (declaration && ruleStack.length > 0) {
      const property = declaration[1].toLowerCase();
      const value = declaration[2].trim();
      const rule = ruleStack.at(-1);
      rule.declarations.push({ property, value, line: lineNumber });

      const includesRn = getIncludedPlatforms(conditionStack).has('rn');
      if (includesRn && property === 'line-height' && !/^-?\d+(?:\.\d+)?px$/i.test(value)) {
        issues.push(createIssue(file, lineNumber, 'line-height-px', '公共 Less 的 line-height 必须使用 px 数值'));
      } else if (includesRn && isForbiddenDeclaration(property, value)) {
        issues.push(createIssue(file, lineNumber, 'forbidden-property', `${property}: ${value} 不可用于三端公共 Less`));
      }
      continue;
    }

    if (trimmed === '}') {
      const rule = ruleStack.pop();
      if (!rule) {
        issues.push(createIssue(file, lineNumber, 'syntax', '存在未匹配的 }'));
        continue;
      }
      if (rule.declarations.length === 0) {
        issues.push(createIssue(file, rule.line, 'empty-rule', `${rule.selector} 为空规则`));
      }
      const properties = new Map(rule.declarations.map((declaration) => [declaration.property, declaration.value]));
      const hasHorizontalPadding = ['padding', 'padding-left', 'padding-right', 'padding-inline', 'padding-inline-start', 'padding-inline-end'].some((property) => properties.has(property));
      if (rule.includesRn && properties.get('width') === '100%' && hasHorizontalPadding && properties.get('box-sizing') !== 'border-box') {
        issues.push(createIssue(file, rule.line, 'width-padding-box-sizing', 'width: 100% 与横向 padding 同用时必须声明 box-sizing: border-box'));
      }
    }
  }

  for (const rule of ruleStack) {
    issues.push(createIssue(file, rule.line, 'syntax', `${rule.selector} 缺少结束 }`));
  }
  if (conditionStack.length > 0) {
    issues.push(createIssue(file, lines.length, 'platform-condition', '条件编译块缺少 #endif'));
  }
  return issues;
}

function changedLessFiles() {
  try {
    return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '--', '*.less'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const files = process.argv.slice(2);
  const targets = files.length > 0 ? files : changedLessFiles();
  if (targets.length === 0) {
    console.log('未发现本次修改的 Less 文件。');
    return;
  }

  const issues = targets.flatMap((file) => {
    if (!existsSync(file)) return [createIssue(file, 0, 'file', '文件不存在')];
    return validateLess(readFileSync(file, 'utf8'), path.normalize(file));
  });
  if (issues.length === 0) {
    console.log(`PASS ${targets.length} 个 Less 文件`);
    return;
  }

  for (const issue of issues) {
    console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
