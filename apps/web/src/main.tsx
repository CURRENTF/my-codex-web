import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import * as Tooltip from "@radix-ui/react-tooltip";
import { App } from "./App";
import "./styles.css";

const CodeView = lazy(() => import("./components/CodeView"));

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><QueryClientProvider client={queryClient}><Tooltip.Provider delayDuration={450}><BrowserRouter>{window.location.pathname === "/code" ? <Suspense fallback={<div className="pane-loading">正在加载 Code View…</div>}><CodeView /></Suspense> : <App />}</BrowserRouter></Tooltip.Provider></QueryClientProvider></React.StrictMode>,
);
