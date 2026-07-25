import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import * as Tooltip from "@radix-ui/react-tooltip";
import { App } from "./App";
import "./styles.css";

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><QueryClientProvider client={queryClient}><Tooltip.Provider delayDuration={450}><BrowserRouter><App /></BrowserRouter></Tooltip.Provider></QueryClientProvider></React.StrictMode>,
);
