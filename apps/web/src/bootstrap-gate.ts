export type BootstrapGate = "ready" | "disconnected" | "authRequired";

export function bootstrapGate(connectionState: "connected" | "connecting" | "disconnected", authReady: boolean): BootstrapGate {
  if (connectionState !== "connected") return "disconnected";
  return authReady ? "ready" : "authRequired";
}
