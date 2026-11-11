import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 白名单映射。房间目录内的 JSONL 只允许这三个名字，
 * 任何其他输入（含路径分隔符、`..`、绝对路径）都在读取前拒绝。
 */
export const JSONL_FILENAMES = Object.freeze({
  events: 'events.jsonl',
  transcript: 'transcript.jsonl',
  attempts: 'attempts.jsonl',
});

const JSONL_NAME_SET = new Set(Object.keys(JSONL_FILENAMES));

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StoreError);
    }
  }
}

/** 返回白名单内的物理文件名；非法名字抛 StoreError。 */
export function resolveJsonlName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new StoreError('INVALID_JSONL_NAME', 'JSONL name must be a non-empty string.', {
      name,
      allowed: Object.keys(JSONL_FILENAMES),
    });
  }
  // 只接受裸名字；先拒绝任何路径语义，再查白名单，避免 `events/../x` 之类绕过。
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new StoreError('INVALID_JSONL_NAME', `JSONL name is not allowed: ${name}`, {
      name,
      allowed: Object.keys(JSONL_FILENAMES),
    });
  }
  const bare = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  if (!JSONL_NAME_SET.has(bare)) {
    throw new StoreError('INVALID_JSONL_NAME', `Unknown JSONL file: ${name}`, {
      name,
      allowed: Object.keys(JSONL_FILENAMES),
    });
  }
  return bare;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析 JSONL 文本。
 *
 * - 每个以 `\n` 结束的行都必须是完整 JSON，否则抛带行号的 StoreError。
 * - 只有“没有换行结尾的最后一行”解析失败时，才视为写入中断形成的部分尾行：
 *   跳过该行并通过 warnings 报告行号，之前已完整的记录照常返回。
 * - 完整但缺少最后换行符的 JSON 行仍然是一条有效记录。
 */
export function parseJsonl(text, file) {
  const records = [];
  const warnings = [];
  const source = stripBom(text);
  if (source.length === 0) {
    return { records, warnings };
  }

  const terminated = source.endsWith('\n');
  const rawLines = source.split('\n');
  if (terminated) {
    rawLines.pop();
  }

  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index];
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    const lineNumber = index + 1;
    const isLast = index === rawLines.length - 1;
    const isPartialTail = isLast && !terminated;

    if (line.trim().length === 0) {
      throw new StoreError('JSONL_PARSE_ERROR', `Empty JSONL line at ${file}:${lineNumber}`, {
        file,
        line: lineNumber,
      });
    }

    try {
      records.push(JSON.parse(line));
    } catch {
      if (isPartialTail) {
        warnings.push({
          code: 'PARTIAL_TAIL',
          file,
          line: lineNumber,
          message: `Incomplete final JSONL line ignored at ${file}:${lineNumber}`,
        });
        continue;
      }
      throw new StoreError(
        'JSONL_PARSE_ERROR',
        `Invalid JSON at ${file}:${lineNumber}`,
        { file, line: lineNumber },
      );
    }
  }

  return { records, warnings };
}

/** 读取并解析白名单内的 JSONL；文件不存在时返回空结果。 */
export async function readJsonlFile(roomDir, name) {
  const bare = resolveJsonlName(name);
  const fileName = JSONL_FILENAMES[bare];
  const target = path.join(roomDir, fileName);

  let text;
  try {
    text = await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { records: [], warnings: [] };
    }
    throw error;
  }
  return parseJsonl(text, fileName);
}

/** 追加一行已序列化好的 JSONL 文本；调用方负责同一文件的串行化。 */
export async function appendJsonlLine(roomDir, name, line) {
  const bare = resolveJsonlName(name);
  const fileName = JSONL_FILENAMES[bare];
  await mkdir(roomDir, { recursive: true });
  await appendFile(path.join(roomDir, fileName), line, 'utf8');
}
