export function acceptsSpaDocument(method: string, accept: string | undefined): boolean {
  if (method !== "GET" || !accept) return false;
  return accept.split(",").some((entry) => entry.split(";", 1)[0]?.trim().toLowerCase() === "text/html");
}
