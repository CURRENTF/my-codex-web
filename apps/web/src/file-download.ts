import { api, ApiError } from "./api";
import { appUrl } from "./app-base";

export async function downloadFile(url: string): Promise<void> {
  try {
    // Check without transferring the file or buffering large reports in memory.
    await api<void>(url, { method: "HEAD", cache: "no-store" });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : null;
    const message = status === 404
      ? "Web 服务所在机器上找不到此文件。若文件在 SSH 远端，请先复制到 Web 服务所在机器再下载。"
      : status === 403 ? "当前服务用户没有读取此文件的权限。"
      : status === 401 ? "登录已过期，请刷新页面并重新登录后下载。"
      : status ? `无法下载文件（HTTP ${status}），请稍后重试。`
      : "无法连接下载服务，请检查网络后重试。";
    throw new Error(message);
  }
  const link = document.createElement("a");
  link.href = appUrl(url);
  link.download = "";
  link.hidden = true;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); }
}
