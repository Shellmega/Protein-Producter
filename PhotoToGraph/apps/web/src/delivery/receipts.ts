/**
 * Strict parsing/validation of the frozen ptg-graph/1.0 wire responses used by
 * the delivery layer: import receipt, error document and GET read response.
 *
 * Contract sources (frozen, read-only):
 * - `receipt.schema.json` (8 required members, no additional members),
 * - `error.schema.json` (error document + wire code registry),
 * - `read-response.schema.json` (exactly `{receipt, source_graph}`),
 * - `spec.md` §7.4 and `rules.json` (`limits.import_id`, `stages` order),
 * - `request.schema.json` via `validateRequest` (source_graph validity).
 *
 * Failure classification (used by the state machine):
 * - `DLV_RECEIPT_INVALID` / `DLV_GET_INVALID`: the bytes are not acceptable
 *   wire JSON (BOM, HTML, syntax error, duplicate member name, wrong member
 *   set, wrong type/domain, self-inconsistent counts, invalid source_graph).
 * - `DLV_RECEIPT_MISMATCH` / `DLV_GET_MISMATCH`: a well-formed object whose
 *   values do not bind to THIS local submission (different producer/graph/
 *   revision/version/counts/import_id, or a source_graph that is valid but not
 *   semantically equivalent to the frozen snapshot bytes).
 *
 * Never fabricate success: a `{ok:true, ...}` result is only returned after
 * every field and cross-field rule passed.
 */

import {
  MAX_JSON_DEPTH,
  MAX_NODE_COUNT,
  MAX_REVISION,
  MIN_NODE_COUNT,
} from '../contract/types';
import { validateRequest } from '../contract/validate';
import { compareSourceGraph } from './semantic';
import {
  WIRE_ID_PATTERN,
  type WireErrorBody,
  type WireReceipt,
} from './types';

type JsonRecord = Record<string, unknown>;

/** Frozen receipt status (spec §7.4): source graph saved, configuration pending. */
export const RECEIPT_STATUS = 'imported_needs_configuration' as const;

/** Frozen receipt member set (receipt.schema.json `required`). */
export const RECEIPT_FIELDS: readonly string[] = [
  'import_id',
  'schema_version',
  'producer_instance_id',
  'graph_id',
  'revision',
  'status',
  'node_count',
  'edge_count',
];

const RECEIPT_FIELD_SET: ReadonlySet<string> = new Set(RECEIPT_FIELDS);

const MIN_RECEIPT_NODE_COUNT = MIN_NODE_COUNT; // 2
const MAX_RECEIPT_NODE_COUNT = MAX_NODE_COUNT; // 2048
const MIN_RECEIPT_EDGE_COUNT = MIN_NODE_COUNT - 1; // 1
const MAX_RECEIPT_EDGE_COUNT = MAX_NODE_COUNT - 1; // 2047

const ERROR_FIELDS: readonly string[] = ['code', 'message', 'node_ids', 'field'];
const ERROR_FIELD_SET: ReadonlySet<string> = new Set(ERROR_FIELDS);
const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_ERROR_FIELD_LENGTH = 256;

/**
 * Frozen wire error registry (error.schema.json `error.code.enum`).
 * `PRECISION_LIMIT` / `DERIVATION_INVALID` are derivation-stage codes and are
 * deliberately absent from the import wire registry.
 */
export const WIRE_ERROR_CODES: readonly string[] = [
  'JSON_SYNTAX',
  'DUPLICATE_JSON_KEY',
  'NUMBER_NOT_REPRESENTABLE',
  'BODY_TOO_DEEP',
  'CONTENT_ENCODING_UNSUPPORTED',
  'UNSUPPORTED_MEDIA_TYPE',
  'BODY_TOO_LARGE',
  'SCHEMA_UNSUPPORTED',
  'PROFILE_UNSUPPORTED',
  'IDEMPOTENCY_KEY_INVALID',
  'FIELD_INVALID',
  'FIELD_UNKNOWN',
  'COORDINATE_INVALID',
  'NODE_COUNT_LIMIT',
  'NODE_ID_DUPLICATE',
  'ADJACENCY_KEYS',
  'UNKNOWN_NODE',
  'EDGE_DUPLICATE',
  'SELF_LOOP',
  'ADJACENCY_ASYMMETRIC',
  'COINCIDENT_NODES',
  'GRAPH_BRANCH',
  'GRAPH_DISCONNECTED',
  'GRAPH_CYCLE',
  'N_TERMINAL_INVALID',
  'IDEMPOTENCY_CONFLICT',
  'FRAME_CONFLICT',
  'REVISION_CONFLICT',
  'IMPORT_NOT_FOUND',
  'STORAGE_FAILURE',
  'INTERNAL_ERROR',
  'IMPORT_BUSY',
  'RATE_LIMITED',
];

const WIRE_ERROR_CODE_SET: ReadonlySet<string> = new Set(WIRE_ERROR_CODES);

/* ------------------------------------------------------------------------- */
/* Strict RFC 8259 JSON parsing (duplicate member names rejected)            */
/* ------------------------------------------------------------------------- */

class StrictJsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonSyntaxError';
  }
}

type StrictJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

class StrictJsonParser {
  private index = 0;
  private depth = 0;

  constructor(private readonly text: string) {}

  parse(): StrictJsonResult {
    try {
      if (this.text.length > 0 && this.text.charCodeAt(0) === 0xfeff) {
        throw this.fail('JSON 文本不得以 BOM 开头');
      }
      this.skipWhitespace();
      const value = this.parseValue();
      this.skipWhitespace();
      if (this.index !== this.text.length) {
        throw this.fail('JSON 值之后仍有内容');
      }
      return { ok: true, value };
    } catch (error) {
      if (error instanceof StrictJsonSyntaxError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  private fail(message: string): StrictJsonSyntaxError {
    return new StrictJsonSyntaxError(`${message}（字符位置 ${this.index}）`);
  }

  private skipWhitespace(): void {
    for (;;) {
      const ch = this.text[this.index];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.index += 1;
      } else {
        return;
      }
    }
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const ch = this.text[this.index];
    if (ch === undefined) {
      throw this.fail('JSON 意外结束');
    }
    switch (ch) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        return this.parseLiteral('true', true);
      case 'f':
        return this.parseLiteral('false', false);
      case 'n':
        return this.parseLiteral('null', null);
      default:
        if (ch === '-' || (ch >= '0' && ch <= '9')) {
          return this.parseNumber();
        }
        throw this.fail('JSON 非法字符');
    }
  }

  private parseLiteral(literal: string, value: unknown): unknown {
    if (!this.text.startsWith(literal, this.index)) {
      throw this.fail(`JSON 字面量非法，期望 ${literal}`);
    }
    this.index += literal.length;
    return value;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_JSON_DEPTH) {
      throw this.fail(`JSON 嵌套深度超过上限 ${MAX_JSON_DEPTH}`);
    }
  }

  private parseObject(): JsonRecord {
    this.enter();
    this.index += 1; // '{'
    const out: JsonRecord = {};
    const names = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        throw this.fail('JSON 对象成员名必须是字符串');
      }
      const name = this.parseString();
      if (names.has(name)) {
        throw this.fail(`重复的 JSON 对象成员名 ${JSON.stringify(name) as string}`);
      }
      names.add(name);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') {
        throw this.fail('JSON 对象成员名之后缺少冒号');
      }
      this.index += 1;
      out[name] = this.parseValue();
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ',') {
        this.index += 1;
        continue;
      }
      if (ch === '}') {
        this.index += 1;
        this.depth -= 1;
        return out;
      }
      throw this.fail('JSON 对象成员之后缺少逗号或右花括号');
    }
  }

  private parseArray(): unknown[] {
    this.enter();
    this.index += 1; // '['
    const out: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ',') {
        this.index += 1;
        continue;
      }
      if (ch === ']') {
        this.index += 1;
        this.depth -= 1;
        return out;
      }
      throw this.fail('JSON 数组元素之后缺少逗号或右方括号');
    }
  }

  private parseString(): string {
    this.index += 1; // opening quote
    let out = '';
    for (;;) {
      const ch = this.text[this.index];
      if (ch === undefined) {
        throw this.fail('JSON 字符串未结束');
      }
      if (ch === '"') {
        this.index += 1;
        return out;
      }
      if (ch === '\\') {
        this.index += 1;
        const escape = this.text[this.index];
        switch (escape) {
          case '"':
            out += '"';
            this.index += 1;
            break;
          case '\\':
            out += '\\';
            this.index += 1;
            break;
          case '/':
            out += '/';
            this.index += 1;
            break;
          case 'b':
            out += '\b';
            this.index += 1;
            break;
          case 'f':
            out += '\f';
            this.index += 1;
            break;
          case 'n':
            out += '\n';
            this.index += 1;
            break;
          case 'r':
            out += '\r';
            this.index += 1;
            break;
          case 't':
            out += '\t';
            this.index += 1;
            break;
          case 'u': {
            const hex = this.text.slice(this.index + 1, this.index + 5);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
              throw this.fail('JSON 字符串含非法 \\u 转义');
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.index += 5;
            break;
          }
          default:
            throw this.fail('JSON 字符串含非法转义');
        }
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        throw this.fail('JSON 字符串含未转义的控制字符');
      }
      out += ch;
      this.index += 1;
    }
  }

  private parseNumber(): number {
    const match = NUMBER_PATTERN.exec(this.text.slice(this.index));
    if (match === null) {
      throw this.fail('JSON 数值字面量非法');
    }
    const literal = match[0];
    this.index += literal.length;
    const value = Number(literal);
    if (!Number.isFinite(value)) {
      throw this.fail('JSON 数值无法表示为有限 binary64');
    }
    if (value === 0 && /[1-9]/.test(literal)) {
      throw this.fail('JSON 数值下溢为非零值无法表示的 0');
    }
    return value;
  }
}

/** Strict RFC 8259 JSON parse; rejects BOM, duplicates and trailing content. */
function parseStrictJson(text: string): StrictJsonResult {
  return new StrictJsonParser(text).parse();
}

/* ------------------------------------------------------------------------- */
/* Receipt                                                                    */
/* ------------------------------------------------------------------------- */

/** Values a receipt must bind to (copied from the frozen local submission). */
export interface ReceiptExpectation {
  producer_instance_id: string;
  graph_id: string;
  frame_id: string;
  revision: number;
  node_count: number;
  edge_count: number;
  wire_version: string;
  known_import_id?: string | null;
}

export type ReceiptParseResult =
  | { ok: true; receipt: WireReceipt }
  | {
      ok: false;
      code: 'DLV_RECEIPT_INVALID' | 'DLV_RECEIPT_MISMATCH';
      message: string;
      field: string | null;
    };

interface ReceiptFailure {
  ok: false;
  code: 'DLV_RECEIPT_INVALID' | 'DLV_RECEIPT_MISMATCH';
  message: string;
  field: string | null;
}

function invalidReceipt(field: string | null, message: string): ReceiptFailure {
  return { ok: false, code: 'DLV_RECEIPT_INVALID', message, field };
}

function mismatchReceipt(field: string | null, message: string): ReceiptFailure {
  return { ok: false, code: 'DLV_RECEIPT_MISMATCH', message, field };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value) as string;
  }
  return String(value);
}

function readStringField(
  value: JsonRecord,
  field: string,
  pattern: RegExp | null,
): { ok: true; text: string } | ReceiptFailure {
  const raw = value[field];
  if (typeof raw !== 'string') {
    return invalidReceipt(field, `回执字段 ${field} 必须是字符串`);
  }
  if (pattern !== null && !pattern.test(raw)) {
    return invalidReceipt(
      field,
      `回执字段 ${field} 不符合标识符规则（1—128 字符，首字符为 ASCII 字母或数字，其余仅限字母、数字、点、下划线、连字符）`,
    );
  }
  return { ok: true, text: raw };
}

function readIntegerField(
  value: JsonRecord,
  field: string,
  minimum: number,
  maximum: number,
): { ok: true; integer: number } | ReceiptFailure {
  const raw = value[field];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return invalidReceipt(field, `回执字段 ${field} 必须是整数`);
  }
  if (raw < minimum || raw > maximum) {
    return invalidReceipt(field, `回执字段 ${field} 必须在 ${minimum}—${maximum} 之间，当前 ${raw}`);
  }
  return { ok: true, integer: raw };
}

function requireEqual(
  actual: unknown,
  expected: unknown,
  field: string,
  label: string,
): ReceiptFailure | null {
  if (actual !== expected) {
    return mismatchReceipt(
      field,
      `回执${label}与本地提交不一致：回执 ${display(actual)}，期望 ${display(expected)}`,
    );
  }
  return null;
}

/**
 * Validate a parsed receipt value against the expectation.
 * Structure/domain errors are `DLV_RECEIPT_INVALID`; a well-formed receipt
 * that does not bind to this submission is `DLV_RECEIPT_MISMATCH`.
 */
function validateReceipt(value: unknown, expected: ReceiptExpectation): { ok: true; receipt: WireReceipt } | ReceiptFailure {
  if (!isRecord(value)) {
    return invalidReceipt('$', '回执必须是 JSON 对象');
  }

  for (const field of RECEIPT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return invalidReceipt(field, `回执缺少必需字段 ${field}`);
    }
  }
  const extras = Object.keys(value)
    .filter((key) => !RECEIPT_FIELD_SET.has(key))
    .sort();
  if (extras.length > 0) {
    return invalidReceipt(extras[0], `回执含契约未允许的成员 ${extras[0]}`);
  }

  const importId = readStringField(value, 'import_id', WIRE_ID_PATTERN);
  if (!importId.ok) return importId;
  const schemaVersion = readStringField(value, 'schema_version', null);
  if (!schemaVersion.ok) return schemaVersion;
  const producer = readStringField(value, 'producer_instance_id', WIRE_ID_PATTERN);
  if (!producer.ok) return producer;
  const graph = readStringField(value, 'graph_id', WIRE_ID_PATTERN);
  if (!graph.ok) return graph;
  const revision = readIntegerField(value, 'revision', 1, MAX_REVISION);
  if (!revision.ok) return revision;
  const status = readStringField(value, 'status', null);
  if (!status.ok) return status;
  const nodeCount = readIntegerField(value, 'node_count', MIN_RECEIPT_NODE_COUNT, MAX_RECEIPT_NODE_COUNT);
  if (!nodeCount.ok) return nodeCount;
  const edgeCount = readIntegerField(value, 'edge_count', MIN_RECEIPT_EDGE_COUNT, MAX_RECEIPT_EDGE_COUNT);
  if (!edgeCount.ok) return edgeCount;

  // Frozen const and cross-field rule (spec §7.4: edge_count = node_count - 1).
  if (status.text !== RECEIPT_STATUS) {
    return invalidReceipt(
      'status',
      `回执字段 status 必须为 ${RECEIPT_STATUS}，当前 ${display(status.text)}`,
    );
  }
  if (edgeCount.integer !== nodeCount.integer - 1) {
    return invalidReceipt(
      'edge_count',
      `回执自相矛盾：edge_count ${edgeCount.integer} 不等于 node_count - 1（node_count ${nodeCount.integer}）`,
    );
  }

  // Binding to THIS submission. `JSON` number literal 7.0 parses to 7, so a
  // mathematically integral literal is accepted as an integer revision.
  const bindings: [unknown, unknown, string, string][] = [
    [schemaVersion.text, expected.wire_version, 'schema_version', 'schema_version'],
    [producer.text, expected.producer_instance_id, 'producer_instance_id', '生产者实例'],
    [graph.text, expected.graph_id, 'graph_id', '图标识'],
    [revision.integer, expected.revision, 'revision', '修订号'],
    [nodeCount.integer, expected.node_count, 'node_count', '结点数'],
    [edgeCount.integer, expected.edge_count, 'edge_count', '边数'],
  ];
  for (const [actual, bound, field, label] of bindings) {
    const failure = requireEqual(actual, bound, field, label);
    if (failure !== null) return failure;
  }

  const knownImportId = expected.known_import_id;
  if (knownImportId !== undefined && knownImportId !== null && importId.text !== knownImportId) {
    return mismatchReceipt(
      'import_id',
      `回执 import_id 与已保存的导入标识不一致：回执 ${display(importId.text)}，已知 ${display(knownImportId)}`,
    );
  }

  return {
    ok: true,
    receipt: {
      import_id: importId.text,
      schema_version: schemaVersion.text,
      producer_instance_id: producer.text,
      graph_id: graph.text,
      revision: revision.integer,
      status: status.text,
      node_count: nodeCount.integer,
      edge_count: edgeCount.integer,
    },
  };
}

/**
 * Parse and validate one receipt (201/200 body) against the frozen submission.
 * BOM, HTML, malformed JSON and duplicate member names are rejected as
 * `DLV_RECEIPT_INVALID`; identity/count mismatches are `DLV_RECEIPT_MISMATCH`.
 */
export function parseReceipt(rawText: string, expected: ReceiptExpectation): ReceiptParseResult {
  const parsed = parseStrictJson(rawText);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'DLV_RECEIPT_INVALID',
      message: `回执不是合法 JSON：${parsed.message}`,
      field: null,
    };
  }
  return validateReceipt(parsed.value, expected);
}

/* ------------------------------------------------------------------------- */
/* Error document                                                             */
/* ------------------------------------------------------------------------- */

export type WireErrorParse =
  | { ok: true; error: WireErrorBody }
  | { ok: false; message: string };

function validateErrorBody(value: unknown): WireErrorParse {
  if (!isRecord(value)) {
    return { ok: false, message: '错误响应必须是 JSON 对象' };
  }
  const topKeys = Object.keys(value);
  if (topKeys.length !== 1 || topKeys[0] !== 'error') {
    return { ok: false, message: '错误响应必须恰好包含一个 error 成员' };
  }
  const error = value.error;
  if (!isRecord(error)) {
    return { ok: false, message: '错误响应的 error 必须是 JSON 对象' };
  }
  for (const field of ERROR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(error, field)) {
      return { ok: false, message: `错误响应缺少必需字段 error.${field}` };
    }
  }
  const extras = Object.keys(error)
    .filter((key) => !ERROR_FIELD_SET.has(key))
    .sort();
  if (extras.length > 0) {
    return { ok: false, message: `错误响应含契约未允许的成员 error.${extras[0]}` };
  }

  const code = error.code;
  if (typeof code !== 'string' || !WIRE_ERROR_CODE_SET.has(code)) {
    return { ok: false, message: '错误响应字段 error.code 不是冻结错误码' };
  }
  const message = error.message;
  if (typeof message !== 'string' || message.length < 1 || message.length > MAX_ERROR_MESSAGE_LENGTH) {
    return {
      ok: false,
      message: `错误响应字段 error.message 必须是 1—${MAX_ERROR_MESSAGE_LENGTH} 字符的字符串`,
    };
  }
  const field = error.field;
  if (typeof field !== 'string' || field.length < 1 || field.length > MAX_ERROR_FIELD_LENGTH) {
    return {
      ok: false,
      message: `错误响应字段 error.field 必须是 1—${MAX_ERROR_FIELD_LENGTH} 字符的字符串`,
    };
  }
  const nodeIds = error.node_ids;
  if (!Array.isArray(nodeIds) || nodeIds.length > MAX_NODE_COUNT) {
    return { ok: false, message: '错误响应字段 error.node_ids 必须是最多 2048 项的数组' };
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of nodeIds) {
    if (typeof item !== 'string' || !WIRE_ID_PATTERN.test(item)) {
      return { ok: false, message: '错误响应字段 error.node_ids 含非法结点标识' };
    }
    if (seen.has(item)) {
      return { ok: false, message: `错误响应字段 error.node_ids 含重复结点 ${item}` };
    }
    seen.add(item);
    ids.push(item);
  }

  return { ok: true, error: { code, message, node_ids: ids, field } };
}

/**
 * Parse a wire error document (`error.schema.json`) strictly: exactly one
 * top-level `error` member with exactly `code`/`message`/`node_ids`/`field`,
 * a frozen wire code, and a valid id array. Node order is not asserted (the
 * schema only says ids are unique; the description's sort order is normative
 * for producers, not a parse precondition).
 */
export function parseErrorBody(rawText: string): WireErrorParse {
  const parsed = parseStrictJson(rawText);
  if (!parsed.ok) {
    return { ok: false, message: `错误响应不是合法 JSON：${parsed.message}` };
  }
  return validateErrorBody(parsed.value);
}

/* ------------------------------------------------------------------------- */
/* Read response (GET)                                                        */
/* ------------------------------------------------------------------------- */

export interface ReadExpectation extends ReceiptExpectation {
  known_import_id: string;
}

export type ReadParseResult =
  | {
      ok: true;
      receipt: WireReceipt;
      sourceGraph: unknown;
      equivalent: boolean;
      reason: string;
    }
  | {
      ok: false;
      code: 'DLV_GET_INVALID' | 'DLV_GET_MISMATCH';
      message: string;
      field: string | null;
    };

function getInvalid(field: string | null, message: string): ReadParseResult {
  return { ok: false, code: 'DLV_GET_INVALID', message, field };
}

function getMismatch(field: string | null, message: string): ReadParseResult {
  return { ok: false, code: 'DLV_GET_MISMATCH', message, field };
}

function countUndirectedEdges(adjacency: Record<string, string[]>): number {
  let degreeSum = 0;
  for (const neighbours of Object.values(adjacency)) {
    degreeSum += neighbours.length;
  }
  return degreeSum / 2;
}

/**
 * Parse a GET read response `{receipt, source_graph}` strictly.
 *
 * 1. Strict JSON (BOM/HTML/syntax/duplicate names rejected), exactly the two
 *    schema members.
 * 2. The receipt is validated exactly like a POST receipt, including binding
 *    to the known import_id.
 * 3. `source_graph` must pass the full frozen request pipeline
 *    (`validateRequest`: version -> structure -> graph -> geometry ->
 *    topology) and bind to the same producer/graph/revision/frame/counts.
 * 4. `source_graph` must be semantically equivalent (ptg-jcs-1 projection) to
 *    the exact frozen snapshot bytes: numeric literal form and array order do
 *    not matter, every binary64 component does (a tiny Z change at large
 *    coordinates is a mismatch).
 *
 * A malformed response is `DLV_GET_INVALID`; a well-formed response that does
 * not bind to the local submission is `DLV_GET_MISMATCH`. Neither ever
 * fabricates success.
 */
export function parseReadResponse(
  rawText: string,
  expected: ReadExpectation,
  snapshotBytes: Uint8Array,
): ReadParseResult {
  const parsed = parseStrictJson(rawText);
  if (!parsed.ok) {
    return getInvalid(null, `读取响应不是合法 JSON：${parsed.message}`);
  }
  const body = parsed.value;
  if (!isRecord(body)) {
    return getInvalid('$', '读取响应必须是 JSON 对象');
  }
  const keys = Object.keys(body);
  for (const field of ['receipt', 'source_graph']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      return getInvalid(field, `读取响应缺少必需字段 ${field}`);
    }
  }
  const extras = keys.filter((key) => key !== 'receipt' && key !== 'source_graph').sort();
  if (extras.length > 0) {
    return getInvalid(extras[0], `读取响应含契约未允许的成员 ${extras[0]}`);
  }

  const receiptCheck = validateReceipt(body.receipt, expected);
  if (!receiptCheck.ok) {
    const code = receiptCheck.code === 'DLV_RECEIPT_INVALID' ? 'DLV_GET_INVALID' : 'DLV_GET_MISMATCH';
    const field = receiptCheck.field === null ? 'receipt' : `receipt.${receiptCheck.field}`;
    return { ok: false, code, message: `读取响应回执不可用：${receiptCheck.message}`, field };
  }

  const validation = validateRequest(body.source_graph);
  if (!validation.ok) {
    const issue = validation.error;
    const issueField = issue === null ? '$' : issue.field;
    const field = issueField === '$' ? 'source_graph' : `source_graph.${issueField}`;
    return getInvalid(
      field,
      `读取响应的 source_graph 不是合法 ptg-graph/1.0 请求：${issue?.code ?? 'FIELD_INVALID'} ${issue?.message ?? ''}`.trim(),
    );
  }
  const graph = validation.payload;
  if (graph === null) {
    return getInvalid('source_graph', '读取响应的 source_graph 未通过校验');
  }

  // Identity and counts must bind to the frozen submission (frame_id only
  // exists on the graph, not on the receipt).
  const identityChecks: [unknown, unknown, string, string][] = [
    [graph.producer_instance_id, expected.producer_instance_id, 'producer_instance_id', '生产者实例'],
    [graph.graph_id, expected.graph_id, 'graph_id', '图标识'],
    [graph.revision, expected.revision, 'revision', '修订号'],
    [graph.coordinate_system.frame_id, expected.frame_id, 'coordinate_system.frame_id', '坐标框架'],
    [graph.nodes.length, expected.node_count, 'nodes', '结点数'],
    [countUndirectedEdges(graph.adjacency), expected.edge_count, 'adjacency', '边数'],
  ];
  for (const [actual, bound, graphField, label] of identityChecks) {
    if (actual !== bound) {
      return getMismatch(
        `source_graph.${graphField}`,
        `source_graph ${label}与本地快照不一致：响应 ${display(actual)}，期望 ${display(bound)}`,
      );
    }
  }

  // Decode the frozen snapshot exactly as the receiver would return it: UTF-8
  // bytes -> strict JSON -> semantic comparison. Local corruption is reported
  // as DLV_GET_INVALID (fail closed, never a fabricated success).
  let snapshotText: string;
  try {
    snapshotText = new TextDecoder('utf-8', { fatal: true }).decode(snapshotBytes);
  } catch {
    return getInvalid('snapshot', '冻结快照字节不是合法 UTF-8，无法核对 source_graph');
  }
  const snapshot = parseStrictJson(snapshotText);
  if (!snapshot.ok) {
    return getInvalid('snapshot', `冻结快照字节不是合法 JSON：${snapshot.message}`);
  }

  const comparison = compareSourceGraph(body.source_graph, snapshot.value);
  if (!comparison.equivalent) {
    return {
      ok: false,
      code: 'DLV_GET_MISMATCH',
      message: comparison.reason,
      field: 'source_graph',
    };
  }

  return {
    ok: true,
    receipt: receiptCheck.receipt,
    sourceGraph: body.source_graph,
    equivalent: true,
    reason: comparison.reason,
  };
}
