import { useEffect } from "react";

type Head = {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  robots?: string;
};

const setMeta = (selector: string, key: "name" | "property", name: string, content: string) => {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(key, name);
    document.head.appendChild(el);
  }
  const prev = el.getAttribute("content") || "";
  el.setAttribute("content", content);
  return prev;
};

/**
 * Sets per-route <title>, description, og:title/description, and optional
 * robots meta. Restores prior values on unmount so navigating back to the
 * static index.html defaults isn't leaked with stale route values.
 */
export function useRouteHead(head: Head) {
  useEffect(() => {
    const prevTitle = document.title;
    if (head.title) document.title = head.title;
    const prevDesc = head.description
      ? setMeta('meta[name="description"]', "name", "description", head.description)
      : null;
    const prevOgTitle = head.ogTitle
      ? setMeta('meta[property="og:title"]', "property", "og:title", head.ogTitle)
      : null;
    const prevOgDesc = head.ogDescription
      ? setMeta('meta[property="og:description"]', "property", "og:description", head.ogDescription)
      : null;
    const prevRobots = head.robots
      ? setMeta('meta[name="robots"]', "name", "robots", head.robots)
      : null;
    return () => {
      document.title = prevTitle;
      if (head.description && prevDesc !== null) setMeta('meta[name="description"]', "name", "description", prevDesc);
      if (head.ogTitle && prevOgTitle !== null) setMeta('meta[property="og:title"]', "property", "og:title", prevOgTitle);
      if (head.ogDescription && prevOgDesc !== null) setMeta('meta[property="og:description"]', "property", "og:description", prevOgDesc);
      if (head.robots) {
        if (prevRobots) setMeta('meta[name="robots"]', "name", "robots", prevRobots);
        else document.head.querySelector('meta[name="robots"]')?.remove();
      }
    };
  }, [head.title, head.description, head.ogTitle, head.ogDescription, head.robots]);
}
