// Small dependency-free XML reader (elements, attributes, text, entities) for importers that
// must run in both the browser and Node.
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      i = src.indexOf("-->", lt) + 3;
      if (i < 3) break;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      // Declarations and DOCTYPE (with an optional internal subset).
      let depth = 0;
      let j = lt + 1;
      for (; j < n; j++) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        else if (src[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const gt = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim();
      while (stack.length > 1 && stack[stack.length - 1].tag !== name) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const self = raw.endsWith("/");
    const body = self ? raw.slice(0, -1) : raw;
    const m = body.match(/^\s*([^\s/>]+)/);
    if (!m) continue;
    const node: XmlNode = { tag: m[1], attrs: {}, children: [], text: "" };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m[0].length);
    while ((a = re.exec(rest))) node.attrs[a[1]] = decode(a[3] ?? a[4] ?? "");
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root;
}

function findTagEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let j = from + 1; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return j;
  }
  return src.length;
}

/** Children with a tag name. */
export const xkids = (n: XmlNode | undefined, tag: string) => (n ? n.children.filter((c) => c.tag === tag) : []);
/** First child with a tag name. */
export const xkid = (n: XmlNode | undefined, tag: string) => n?.children.find((c) => c.tag === tag);
/** Depth-first descendant search along a path of tag names, e.g. xpath(root, "eagle/drawing/board"). */
export function xpath(n: XmlNode | undefined, path: string): XmlNode | undefined {
  let cur = n;
  for (const t of path.split("/")) cur = xkid(cur, t);
  return cur;
}
