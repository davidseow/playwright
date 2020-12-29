/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

const fs = require('fs');
const md = require('../markdown');
const Documentation = require('./Documentation');

/** @typedef {import('../markdown').MarkdownNode} MarkdownNode */

class MDOutline {
  /**
   * @param {string} bodyPath
   * @param {string=} paramsPath
   * @param {string=} links
   */
  constructor(bodyPath, paramsPath, links = '') {
    const body = md.parse(fs.readFileSync(bodyPath).toString());
    const params = paramsPath ? md.parse(fs.readFileSync(paramsPath).toString()) : null;
    const api = params ? applyTemplates(body, params) : body;
    this.classesArray = /** @type {Documentation.Class[]} */ [];
    this.classes = /** @type {Map<string, Documentation.Class>} */ new Map();
    for (const clazz of api) {
      const c = parseClass(clazz);
      this.classesArray.push(c);
      this.classes.set(c.name, c);
    }
    const linksMap = new Map();
    for (const link of links.replace(/\r\n/g, '\n').split('\n')) {
      if (!link)
        continue;
      const match = link.match(/\[([^\]]+)\]: ([^"]+) "([^"]+)"/);
      linksMap.set(new RegExp('\\[' + match[1] + '\\]', 'g'), { href: match[2], label: match[3] });
    }
    this.signatures = this._generateComments(linksMap);
    this.documentation = new Documentation(this.classesArray);
  }

  /**
   * @param {string[]} errors
   */
  copyDocsFromSuperclasses(errors) {
    for (const [name, clazz] of this.documentation.classes.entries()) {
      clazz.validateOrder(errors, clazz);

      if (!clazz.extends || clazz.extends === 'EventEmitter' || clazz.extends === 'Error')
        continue;
      const superClass = this.documentation.classes.get(clazz.extends);
      if (!superClass) {
        errors.push(`Undefined superclass: ${superClass} in ${name}`);
        continue;
      }
      for (const memberName of clazz.members.keys()) {
        if (superClass.members.has(memberName))
          errors.push(`Member documentation overrides base: ${name}.${memberName} over ${clazz.extends}.${memberName}`);
      }

      clazz.membersArray = [...clazz.membersArray, ...superClass.membersArray];
      clazz.index();
    }
  }
  /**
   * @param {Map<string, { href: string, label: string}>} linksMap
   */
  _generateComments(linksMap) {
    /**
     * @type  {Map<string, string>}
     */
    const signatures = new Map();

    for (const clazz of this.classesArray) {
      for (const method of clazz.methodsArray) {
        const tokens = [];
        let hasOptional = false;
        for (const arg of method.argsArray) {
          const optional = !arg.required;
          if (tokens.length) {
            if (optional && !hasOptional)
              tokens.push(`[, ${arg.name}`);
            else
              tokens.push(`, ${arg.name}`);
          } else {
            if (optional && !hasOptional)
              tokens.push(`[${arg.name}`);
            else
              tokens.push(`${arg.name}`);
          }
          hasOptional = hasOptional || optional;
        }
        if (hasOptional)
          tokens.push(']');
        const signature = tokens.join('');
        const methodName = `${clazz.name}.${method.name}`;
        signatures.set(methodName, signature);
      }
    }

    for (const clazz of this.classesArray)
      clazz.visit(item => patchLinks(item.spec, signatures));
    for (const clazz of this.classesArray)
      clazz.visit(item => item.comment = renderCommentsForSourceCode(item.spec, linksMap));
    return signatures;
  }
}

/**
 * @param {MarkdownNode} node
 * @returns {Documentation.Class}
 */
function parseClass(node) {
  const members = [];
  let extendsName = null;
  const name = node.text.substring('class: '.length);
  for (const member of node.children) {
    if (member.type === 'li' && member.text.startsWith('extends: [')) {
      extendsName = member.text.substring('extends: ['.length, member.text.indexOf(']'));
      continue;
    }
    if (member.type === 'h2')
      members.push(parseMember(member));
  }
  return new Documentation.Class(name, members, extendsName, extractComments(node));
}

/**
 * @param {MarkdownNode} item
 * @returns {MarkdownNode[]}
 */
function extractComments(item) {
  return (item.children || []).filter(c => !c.type.startsWith('h') && (c.type !== 'li' || c.liType !== 'default'));
}

/**
 * @param {MarkdownNode[]} spec
 * @param {Map<string, { href: string, label: string}>} linksMap
 */
function renderCommentsForSourceCode(spec, linksMap) {
  const comments = (spec || []).filter(n => n.type !== 'gen' && !n.type.startsWith('h') && (n.type !== 'li' ||  n.liType !== 'default')).map(c => md.clone(c));
  md.visitAll(comments, node => {
    if (node.text) {
      for (const [regex, { href, label }] of linksMap)
        node.text = node.text.replace(regex, `[${label}](${href})`);
      // Those with in `` can have nested [], hence twice twice.
      node.text = node.text.replace(/\[`([^`]+)`\]\(#([^\)]+)\)/g, '[`$1`](https://github.com/microsoft/playwright/blob/master/docs/api.md#$2)');
      node.text = node.text.replace(/\[([^\]]+)\]\(#([^\)]+)\)/g, '[$1](https://github.com/microsoft/playwright/blob/master/docs/api.md#$2)');
      node.text = node.text.replace(/\[`([^`]+)`\]\(\.\/([^\)]+)\)/g, '[`$1`](https://github.com/microsoft/playwright/blob/master/docs/$2)');
      node.text = node.text.replace(/\[([^\]]+)\]\(\.\/([^\)]+)\)/g, '[$1](https://github.com/microsoft/playwright/blob/master/docs/$2)');
    }
    if (node.liType === 'bullet')
      node.liType = 'default';
  });
  return md.render(comments);
}

/**
 * @param {MarkdownNode[]} spec
 * @param {Map<string, string>} [signatures]
 */
function patchLinks(spec, signatures) {
  for (const node of spec || []) {
    if (node.type === 'text')
      node.text = patchLinksInText(node.text, signatures);
    if (node.type === 'li') {
      node.text = patchLinksInText(node.text, signatures);
      patchLinks(node.children, signatures);
    }
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function createLink(text) {
  const anchor = text.toLowerCase().split(',').map(c => c.replace(/[^a-z]/g, '')).join('-');
  return `[\`${text}\`](#${anchor})`;
}

/**
 * @param {string} comment
 * @param {Map<string, string>} signatures
 */
function patchLinksInText(comment, signatures) {
  if (!signatures)
    return comment;
  comment = comment.replace(/\[`(event|method|property):\s(JS|CDP|[A-Z])([^.]+)\.([^`]+)`\]\(\)/g, (match, type, clazzPrefix, clazz, name) => {
    const className = `${clazzPrefix.toLowerCase()}${clazz}`;
    if (type === 'event')
      return createLink(`${className}.on('${name}')`);
    if (type === 'method') {
      const signature = signatures.get(`${clazzPrefix}${clazz}.${name}`) || '';
      return createLink(`${className}.${name}(${signature})`);
    }
    return createLink(`${className}.${name}`);
  });
  return comment.replace(/\[`(?:param|option):\s([^`]+)`\]\(\)/g, '`$1`');
}

/**
 * @param {MarkdownNode} member
 * @returns {Documentation.Member}
 */
function parseMember(member) {
  const args = [];
  const match = member.text.match(/(event|method|property|async method|): (JS|CDP|[A-Z])([^.]+)\.(.*)/);
  const name = match[4];
  let returnType = null;
  const options = [];

  for (const item of member.children || []) {
    if (item.type === 'li' && item.liType === 'default')
      returnType = parseType(item);
  }
  if (!returnType)
    returnType = new Documentation.Type('void');
  if (match[1] === 'async method')
    returnType.name = `Promise<${returnType.name}>`;

  if (match[1] === 'event')
    return Documentation.Member.createEvent(name, returnType, extractComments(member));
  if (match[1] === 'property')
    return Documentation.Member.createProperty(name, returnType, extractComments(member), true);

  for (const item of member.children || []) {
    if (item.type === 'h3' && item.text.startsWith('param:'))
      args.push(parseProperty(item));
    if (item.type === 'h3' && item.text.startsWith('option:'))
      options.push(parseProperty(item));
  }

  if (options.length) {
    options.sort((o1, o2) => o1.name.localeCompare(o2.name));
    for (const option of options)
       option.required = false;
    const type = new Documentation.Type('Object', options);
    args.push(Documentation.Member.createProperty('options', type, undefined, false));
  }
  return Documentation.Member.createMethod(name, args, returnType, extractComments(member));
}

/**
 * @param {MarkdownNode} spec
 * @return {Documentation.Member}
 */
function parseProperty(spec) {
  const param = spec.children[0];
  const text = param.text;
  const name = text.substring(0, text.indexOf('<')).replace(/\`/g, '').trim();
  const comments = extractComments(spec);
  return Documentation.Member.createProperty(name, parseType(param), comments, guessRequired(renderCommentsForSourceCode(comments, new Map())));
}

/**
 * @param {MarkdownNode=} spec
 * @return {Documentation.Type}
 */
function parseType(spec) {
  const { type } = parseArgument(spec.text);
  let typeName = type.replace(/[\[\]\\]/g, '');
  const literals = typeName.match(/("[^"]+"(\|"[^"]+")*)/);
  if (literals) {
    const assorted = literals[1];
    typeName = typeName.substring(0, literals.index) + assorted + typeName.substring(literals.index + literals[0].length);
  }
  const properties = [];
  const hasNonEnumProperties = typeName.split('|').some(part => {
    const basicTypes = new Set(['string', 'number', 'boolean']);
    const arrayTypes = new Set([...basicTypes].map(type => `Array<${type}>`));
    return !basicTypes.has(part) && !arrayTypes.has(part) && !(part.startsWith('"') && part.endsWith('"'));
  });
  if (hasNonEnumProperties && spec) {
    for (const child of spec.children || []) {
      const { name, text } = parseArgument(child.text);
      const comments = /** @type {MarkdownNode[]} */ ([{ type: 'text', text }]);
      properties.push(Documentation.Member.createProperty(name, parseType(child), comments, guessRequired(text)));
    }
  }
  return new Documentation.Type(typeName, properties);
}

/**
 * @param {string} comment
 */
function guessRequired(comment) {
  let required = true;
  if (comment.toLowerCase().includes('defaults to '))
    required = false;
  if (comment.startsWith('Optional'))
    required = false;
  if (comment.endsWith('Optional.'))
    required = false;
  if (comment.toLowerCase().includes('if set'))
    required = false;
  if (comment.toLowerCase().includes('if applicable'))
    required = false;
  if (comment.toLowerCase().includes('if available'))
    required = false;
  if (comment.includes('**required**'))
    required = true;
  return required;
}

/**
 * @param {MarkdownNode[]} body
 * @param {MarkdownNode[]} params
 */
function applyTemplates(body, params) {
  const paramsMap = new Map();
  for (const node of params)
    paramsMap.set('%%-' + node.text + '-%%', node);

  const visit = (node, parent) => {
    if (node.text && node.text.includes('-inline- = %%')) {
      const [name, key] = node.text.split('-inline- = ');
      const list = paramsMap.get(key);
      if (!list)
        throw new Error('Bad template: ' + key);
      for (const prop of list.children) {
        const template = paramsMap.get(prop.text);
        if (!template)
          throw new Error('Bad template: ' + prop.text);
        const { name: argName } = parseArgument(template.children[0].text);
        parent.children.push({
          type: node.type,
          text: name + argName,
          children: template.children.map(c => md.clone(c))
        });
      }
    } else if (node.text && node.text.includes(' = %%')) {
      const [name, key] = node.text.split(' = ');
      node.text = name;
      const template = paramsMap.get(key);
      if (!template)
        throw new Error('Bad template: ' + key);
      node.children.push(...template.children.map(c => md.clone(c)));
    }
    for (const child of node.children || [])
      visit(child, node);
    if (node.children)
      node.children = node.children.filter(child => !child.text || !child.text.includes('-inline- = %%'));
  };

  for (const node of body)
    visit(node, null);

  return body;
}

/**
 * @param {string} line 
 * @returns {{ name: string, type: string, text: string }}
 */
function parseArgument(line) {
  let match = line.match(/^`([^`]+)` (.*)/);
  if (!match)
    match = line.match(/^(returns): (.*)/);
  if (!match)
    match = line.match(/^(type): (.*)/);
  if (!match)
    throw new Error('Invalid argument: ' + line);
  const name = match[1];
  const remainder = match[2];
  if (!remainder.startsWith('<'))
    throw new Error('Bad argument: ' + remainder);
  let depth = 0;
  for (let i = 0; i < remainder.length; ++i) {
    const c = remainder.charAt(i);
    if (c === '<')
      ++depth;
    if (c === '>')
      --depth;
    if (depth === 0)
      return { name, type: remainder.substring(1, i), text: remainder.substring(i + 2) };
  }
  throw new Error('Should not be reached');
}

module.exports = { MDOutline };