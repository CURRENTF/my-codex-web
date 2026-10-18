import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { FastTooltips } from "./components/FastTooltips";
import { App } from "./App";
import "./styles.css";
import "./liquid-glass.css";
import { initializeAppearance } from "./appearance-preferences";

const disposeAppearance = initializeAppearance();
if (import.meta.hot) import.meta.hot.dispose(disposeAppearance);

const CodeView = lazy(() => import("./components/CodeView"));

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });

queryClient.setQueryDefaults(["session"], { gcTime: 30 * 60 * 1000 });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter>{window.location.pathname === "/code" ? <Suspense fallback={<div className="pane-loading">正在加载 Code View…</div>}><CodeView /></Suspense> : <App />}</BrowserRouter><FastTooltips /></QueryClientProvider></React.StrictMode>,
);
