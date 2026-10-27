import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile } from "../../apps/web/src/file-download";

const url = "/api/code/download?root=%2Fwork&path=%2Fdata%2Ftimeline.nsys-rep";
const link = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
const append = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { querySelector: () => null, createElement: () => link, body: { append } });
});
afterEach(() => vi.unstubAllGlobals());

describe("file download checks", () => {
  it("checks headers only and delegates the file stream to the browser", async () => {
    const fetch = vi.fn(async () => new Response(null, { headers: { "content-length": String(3 * 1024 ** 3) } }));
    vi.stubGlobal("fetch", fetch);
    await downloadFile(url);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: "HEAD", cache: "no-store", credentials: "same-origin" }));
    expect(link.href).toBe(url);
    expect(link.download).toBe("");
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it.each([[404, "SSH 远端"], [403, "权限"], [500, "HTTP 500"]])("does not save an error response when the server returns %s", async (status, message) => {
    // HEAD error replies can retain JSON Content-Type, but have no JSON body.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: Number(status), headers: { "content-type": "application/json" } })));
    await expect(downloadFile(url)).rejects.toThrow(String(message));
    expect(append).not.toHaveBeenCalled();
    expect(link.click).not.toHaveBeenCalled();
  });

  it("refreshes an expired security context before starting the native download", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "download-test" }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal("fetch", fetch);
    await downloadFile(url);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([url, "/api/bootstrap", url]);
    expect(link.click).toHaveBeenCalledOnce();
  });

  it("shows a login message when security refresh requires a password", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path) => path === "/api/bootstrap"
      ? new Response(JSON.stringify({ error: "password_required" }), { status: 401, headers: { "content-type": "application/json" } })
      : new Response(null, { status: 401 })));
    await expect(downloadFile(url)).rejects.toThrow("重新登录");
    expect(link.click).not.toHaveBeenCalled();
  });

  it("keeps network failures on the page without creating a download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(downloadFile(url)).rejects.toThrow("检查网络");
    expect(link.click).not.toHaveBeenCalled();
  });
});
