import { invoke } from "@tauri-apps/api/core";

export type TunnelService = "mcp" | "actions";

export interface TunnelStatus {
  state: string;
  publicUrl: string;
  tunnelPid: number | null;
}

export async function getFrpSnippet(id: string, service: TunnelService): Promise<string> {
  return invoke<string>("get_frp_snippet", { id, service });
}

export async function startTunnel(id: string, service: TunnelService): Promise<TunnelStatus> {
  return invoke<TunnelStatus>("start_tunnel", { id, service });
}

export async function stopTunnel(id: string, service: TunnelService): Promise<TunnelStatus> {
  return invoke<TunnelStatus>("stop_tunnel", { id, service });
}

export interface TunnelTestResult {
  success: boolean;
  publicUrl: string;
  keptRunning: boolean;
  message: string;
}

export async function testTunnel(id: string, service: TunnelService): Promise<TunnelTestResult> {
  return invoke<TunnelTestResult>("test_tunnel", { id, service });
}

export async function restartTunnel(id: string, service: TunnelService): Promise<TunnelStatus> {
  return invoke<TunnelStatus>("restart_tunnel", { id, service });
}

export interface TunnelConnectionStatus {
  tunnel: TunnelStatus;
  recovery: { enabled: boolean; state: string; attempts: number; max_attempts: number; retry_after_seconds?: number; requires_manual_start?: boolean; reason?: string | null };
}
export async function getTunnelConnectionStatus(id: string, service: TunnelService): Promise<TunnelConnectionStatus> {
  return invoke<TunnelConnectionStatus>("get_tunnel_connection_status", { id, service });
}
