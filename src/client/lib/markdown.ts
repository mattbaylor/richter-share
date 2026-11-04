import DOMPurify from "dompurify";
import { marked } from "marked";

/** Render untrusted Markdown to sanitized HTML. */
export function renderMarkdown(src: string): string {
	const html = marked.parse(src ?? "", { async: false, gfm: true, breaks: true }) as string;
	return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// Open sanitized links in a new tab without leaking window.opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});
