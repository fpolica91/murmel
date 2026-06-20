"use client";

import {
  Children,
  isValidElement,
  useCallback,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "./markdown.module.css";

/**
 * Safe Markdown renderer for cross-agent (untrusted) body text — chat messages,
 * issue descriptions/comments, memory bodies. GFM is on (tables, strikethrough,
 * task lists, autolinks).
 *
 * SECURITY: this is an XSS boundary. We deliberately do NOT use rehype-raw or
 * dangerouslySetInnerHTML, so raw HTML embedded in the markdown is escaped and
 * rendered as literal text — never as live DOM. Do not add a raw-HTML plugin
 * here without a sanitizer review.
 */
export function Markdown({
  children,
  content,
  className,
}: {
  /** Markdown source. Either `children` or `content` may be used. */
  children?: string;
  content?: string;
  className?: string;
}) {
  const source = content ?? children ?? "";
  const cls = className ? `${styles.md} ${className}` : styles.md;

  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Pull the raw text out of a node tree, for the copy button. */
function nodeToText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement(node)) {
    return nodeToText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Fenced code block: <pre> with a copy-to-clipboard toggle in the corner. */
function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const text = Children.toArray(children).map(nodeToText).join("");
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard denied — leave the label as "Copy". */
      },
    );
  }, [children]);

  return (
    <div className={styles.codeWrap}>
      <button
        type="button"
        className={styles.copyBtn}
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const components: Components = {
  // Fenced blocks come through <pre><code>…</code></pre>; we own the <pre> so we
  // can add the copy button. Inline code stays a bare styled <code>.
  pre: CodeBlock,
  code({ className, children, ...rest }) {
    const isBlock = /language-/.test(className ?? "");
    return (
      <code
        {...rest}
        className={isBlock ? className : `${styles.inlineCode} ${className ?? ""}`}
      >
        {children}
      </code>
    );
  },
  // Untrusted links: new tab + strip referrer/opener.
  a({ children, ...rest }) {
    return (
      <a {...rest} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};
