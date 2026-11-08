/* zip-reader.js — 只读 zip 解析（docx / xlsx / pptx 共用）
 *
 * Office 的 OOXML 格式本质就是 zip：一份 xml + 若干资源。手机上要预览它们，
 * 第一步都是「从二进制里取出某个条目再解压」。这段逻辑原来长在 file-preview.js
 * 里只服务 docx，现在表格和幻灯也要用，抽出来单独一份，谁也不依赖谁。
 *
 * 不引第三方库：
 *  - 中央目录、条目头按 zip 规范自己读（只读，不支持写、不支持加密、不支持分卷）
 *  - 解压用浏览器自带的 DecompressionStream('deflate-raw')，method 0（store）直接切片
 *
 * 用法：
 *   const zip = openZip(await res.arrayBuffer());
 *   zip.names                     // 全部条目名（顺序即中央目录顺序）
 *   zip.has('word/document.xml')
 *   await zip.text('word/document.xml')
 *   await zip.bytes('xl/media/image1.png')
 *
 * 取不到就返回 null，不抛异常；条目存在但格式不对（压缩方式不支持 / 结构损坏）才抛。
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(view) {
  // End of central directory：签名在后面，注释最长 65535，从尾部往前找
  const max = Math.min(view.byteLength, 66_000);
  for (let i = view.byteLength - 22; i >= view.byteLength - max; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

function listEntries(buffer) {
  const view = new DataView(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('不是有效的 zip');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读出条目的原始字节（解压后）。 */
async function readEntryBytes(buffer, meta) {
  const view = new DataView(buffer);
  const at = meta.localOffset;
  if (view.getUint32(at, true) !== LOCAL_SIG) throw new Error('zip 条目头损坏');
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, start, meta.compressedSize);
  if (meta.method === 0) return raw;
  if (meta.method !== 8) throw new Error('不支持的压缩方式');
  if (typeof DecompressionStream !== 'function') throw new Error('浏览器不支持解压');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer|Uint8Array} input zip 的完整字节
 */
export function openZip(input) {
  const buffer = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input;
  const entries = listEntries(buffer);
  const decoder = new TextDecoder('utf-8');

  return {
    names: Array.from(entries.keys()),
    has(name) {
      return entries.has(name);
    },
    /** 按名字前缀找条目名（例如所有 `ppt/slides/slide` 开头的），按名字排序便于按页号读。 */
    match(prefix) {
      return Array.from(entries.keys())
        .filter((name) => name.startsWith(prefix))
        .sort();
    },
    async bytes(name) {
      const meta = entries.get(name);
      if (!meta) return null;
      return readEntryBytes(buffer, meta);
    },
    async text(name) {
      const raw = await this.bytes(name);
      return raw ? decoder.decode(raw) : null;
    },
  };
}
